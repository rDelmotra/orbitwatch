import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getSunDirection, getGAST } from '../orbital/time';
import { getObserverScenePosition, getObserverECEFPosition } from '../orbital/coordinates';
import {
  reconcileVisibilityModeForVisualStatus,
  type VisualListResolvedResult,
} from '../data/visualList';
import { VisualListPoller } from '../data/tle-client';
import { bootstrapCatalog } from '../data/bootstrapCatalog';
import { SatelliteRenderer } from './SatelliteRenderer';
import type { EnrichedTLEObject } from '../data/types';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { DevValidation } from './DevValidation';
import { simClock } from './SimClock';
import { Sgp4WorkerClient, type Sgp4PositionResult } from './tle/Sgp4WorkerClient';
import { InputManager } from './input/InputManager';
import { Renderer } from './render/Renderer';
import { Camera } from './render/Camera';
import { NavigationController } from './controllers/NavigationController';
import type { TrackingSource } from './controllers/TrackingSource';
import { World } from './world/World';
import { StarfieldLayer } from './world/layers/StarfieldLayer';
import { EarthLayer } from './world/layers/EarthLayer';
import { TrailsLayer } from './world/layers/TrailsLayer';
import { DsoLayer } from './world/layers/DsoLayer';
import type { FrameContext } from './render/Layer';

const EARTH_RADIUS_KM = 6371;

export class Engine {
  private static readonly EMPTY_NORAD_SET: Set<number> = new Set();

  private renderer: Renderer;
  private scene: THREE.Scene;
  private cameraRig: Camera;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock: THREE.Clock;
  private earthLayer: EarthLayer;
  private world: World;
  private animationId: number | null = null;
  private satelliteRenderer: SatelliteRenderer;
  private dsoLayer: DsoLayer;
  private sgp4Client: Sgp4WorkerClient | null = null;
  private firstPositionReceived = false;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private inputManager: InputManager | null = null;
  private trailsLayer: TrailsLayer;
  private nav: NavigationController;
  private trailUnsub: (() => void) | null = null;
  private filterUnsub: (() => void) | null = null;
  private devValidation: DevValidation | null = null;
  private visualListPoller: VisualListPoller | null = null;
  private observerMarker: THREE.Group | null = null;
  private lastSimTimeUpdateAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    this.renderer = new Renderer(canvas);

    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Camera + controls ─────────────────────────────────────────────────────
    this.cameraRig = new Camera(canvas);
    this.camera = this.cameraRig.instance;
    this.controls = this.cameraRig.controls;

    // ── Lights ────────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x101820, 0.15);
    this.scene.add(ambient);

    // ── World (layer registry) ──────────────────────────────────────────────────
    // Migrating subsystems into layers one at a time (Slice 5).
    const maxAnisotropy = this.renderer.getMaxAnisotropy();
    this.earthLayer = new EarthLayer();
    this.trailsLayer = new TrailsLayer();
    this.dsoLayer = new DsoLayer();
    this.world = new World({
      onCriticalError: (err) =>
        useStore.getState().setLoadingError(
          err instanceof Error ? err.message : 'A critical layer failed',
        ),
    });
    this.world.register(this.earthLayer);
    this.world.register(new StarfieldLayer());
    this.world.register(this.trailsLayer);
    this.world.register(this.dsoLayer);
    // Synchronous layers (all current ones) fully init in this call, so their
    // renderers are ready for InputManager / TrackingSource below.
    this.world.init({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer.instance,
      maxAnisotropy,
    });

    // ── Satellites ───────────────────────────────────────────────────────────
    this.satelliteRenderer = new SatelliteRenderer(this.scene);

    // ── Navigation (camera state machine) ──────────────────────────────────────
    this.nav = new NavigationController(
      this.camera,
      this.controls,
      this.createTrackingSource(),
      { onCancelJoyrideLook: () => this.inputManager?.cancelJoyrideLook() },
    );

    // ── Clock ─────────────────────────────────────────────────────────────────
    this.clock = new THREE.Clock();

    // ── Resize handler ────────────────────────────────────────────────────────
    window.addEventListener('resize', this.onResize);

    // ── Input manager ─────────────────────────────────────────────────────────
    this.inputManager = new InputManager(
      {
        canvas,
        satelliteRenderer: this.satelliteRenderer,
        dsoRenderer: this.dsoLayer.renderer,
        controls: this.controls,
      },
      {
        onSelectTle: (index) => this.nav.selectByIndex(index),
        onSelectDso: (dsoIndex) => this.nav.selectDsoByIndex(dsoIndex),
        onDeselect: () => {
          useStore.getState().setSelectedSatellite(null, null);
          useStore.getState().setSelectedDso(null);
        },
        onDragExitFollow: () => this.nav.notifyDragExitedFollowing(),
        onJoyrideLookInput: (dx, dy) => this.nav.addJoyrideLookInput(dx, dy),
      },
    );

    // ── Load TLE data and start propagation ───────────────────────────────────
    this.initWorker();
  }

  private async initWorker(): Promise<void> {
    const store = useStore.getState();
    try {
      store.setLoadingPhase('fetching');
      const apiUrl = import.meta.env.VITE_API_URL ?? '';

      // Visual list poller — non-blocking, starts in background
      store.setVisualListState({
        status: 'loading',
        version: null,
        source: null,
        stale: false,
        count: 0,
        updatedAt: null,
        message: null,
      });
      this.visualListPoller = new VisualListPoller(apiUrl, (result) => {
        this.applyVisualListResult(result);
      });
      this.visualListPoller.start();

      // One-time catalog bootstrap — pure data (fetch + store seed). Renderer
      // priming + GPU picker stay here on the render side (data/ never imports engine/).
      const { catalogData, tles } = await bootstrapCatalog(apiUrl);

      this.catalogData = catalogData;
      this.inputManager?.setCatalogData(catalogData);

      useStore.getState().setSelectByIndex((index: number) => this.nav.selectByIndex(index));
      useStore.getState().setTriggerFlyTo((index: number) => this.nav.flyToSatellite(index));
      useStore.getState().setTriggerJoyride((index: number) => this.nav.joyrideSatellite(index));
      useStore.getState().setTriggerResetCamera(() => this.nav.resetCamera());
      useStore.getState().setTriggerFlyToDso((dsoId: string) => this.nav.flyToDso(dsoId));
      useStore.getState().setTriggerJoyrideDso((dsoId: string) => this.nav.joyrideDso(dsoId));
      useStore.getState().setTriggerSimTimeJump(() => this.onSimTimeJump());

      this.satelliteRenderer.initFromCatalog(catalogData);

      this.gpuPicker = new GPUPicker(
        this.renderer.instance,
        this.camera,
        this.satelliteRenderer,
        catalogData.length,
      );
      this.inputManager?.setGpuPicker(this.gpuPicker);

      if (import.meta.env.DEV) {
        this.devValidation = new DevValidation();
        this.devValidation.initFromCatalog(catalogData);
      }

      const issIndex = catalogData.findIndex((d) => d.noradId === 25544);
      if (issIndex !== -1) {
        this.satelliteRenderer.setSatelliteColor(issIndex, 0.2, 1.0, 0.4);
        this.satelliteRenderer.setSatelliteSize(issIndex, 2.0);
      }

      // ── DSO layer activation (worker client + subscriptions) ─────────────────
      this.dsoLayer.activate({
        onDsoTrail: (dsoId, positions) => {
          // Gate: only apply if trail is active and this DSO is selected
          const state = useStore.getState();
          if (!state.showOrbitTrail || state.selectedDso?.dsoId !== dsoId) return;
          this.world.runLayerCommand(this.trailsLayer, 'generateFromPositions', () =>
            this.trailsLayer.generateFromPositions(positions),
          );
        },
        onDsoGeometry: (geometry, count) => this.gpuPicker?.addDsoGeometry(geometry, count),
        onRefreshTrail: () => this.refreshOrbitTrail(),
        getTleCount: () => this.catalogData.length,
      });

      // ── TLE filters subscription ────────────────────────────────────────────
      let prevCatFilters = useStore.getState().categoryFilters;
      let prevRegFilters = useStore.getState().regimeFilters;
      let prevVisMode = useStore.getState().visibilityMode;
      let prevObsLoc = useStore.getState().observerLocation;

      this.filterUnsub = useStore.subscribe((state) => {
        if (
          state.categoryFilters !== prevCatFilters ||
          state.regimeFilters !== prevRegFilters ||
          state.visibilityMode !== prevVisMode ||
          state.observerLocation !== prevObsLoc
        ) {
          const obsLocChanged = state.observerLocation !== prevObsLoc;
          const modeChanged = state.visibilityMode !== prevVisMode;
          const prevMode = prevVisMode;
          prevCatFilters = state.categoryFilters;
          prevRegFilters = state.regimeFilters;
          prevVisMode = state.visibilityMode;
          prevObsLoc = state.observerLocation;

          this.recomputeVisibleCounts(state);

          if (obsLocChanged) {
            this.updateObserverMarker(state.observerLocation);
          }

          if (
            state.visibilityMode === 'visual' &&
            state.observerLocation &&
            (modeChanged || obsLocChanged)
          ) {
            this.nav.focusCameraOnObserverSky(state.observerLocation);
          } else if (modeChanged && prevMode === 'visual' && state.visibilityMode !== 'visual') {
            this.nav.resetCamera();
          }

          if (state.showOrbitTrail && (modeChanged || obsLocChanged)) {
            this.refreshOrbitTrail(state);
          }
        }
      });

      // ── Orbit trail subscription ─────────────────────────────────────────────
      let prevShowTrail = useStore.getState().showOrbitTrail;
      let prevSelectedIndex = useStore.getState().selectedIndex;
      let prevSelectedDsoId = useStore.getState().selectedDso?.dsoId ?? null;
      this.trailUnsub = useStore.subscribe((state) => {
        const selectedDsoId = state.selectedDso?.dsoId ?? null;
        const changed =
          state.showOrbitTrail !== prevShowTrail ||
          state.selectedIndex !== prevSelectedIndex ||
          selectedDsoId !== prevSelectedDsoId;

        if (!changed) {
          return;
        }

        prevShowTrail = state.showOrbitTrail;
        prevSelectedIndex = state.selectedIndex;
        prevSelectedDsoId = selectedDsoId;

        this.refreshOrbitTrail(state);
      });

      console.log(`Loaded ${tles.length} TLEs from backend`);
      useStore.getState().setLoadingPhase('initializing');

      this.sgp4Client = new Sgp4WorkerClient(tles, {
        onReady: (objectCount) => {
          console.log(`SGP4 worker ready: ${objectCount} objects`);
          useStore.getState().setLoadingPhase('propagating');
        },
        onPositions: (result) => this.onSgp4Positions(result),
      });
    } catch (err) {
      console.error('Failed to initialize SGP4 worker:', err);
      useStore.getState().setLoadingError(
        err instanceof Error ? err.message : 'Failed to load satellite data',
      );
    }
  }

  private onSgp4Positions(result: Sgp4PositionResult): void {
    const state = useStore.getState();
    const propagationDate = new Date(result.timestamp);
    const observerPos = this.getObserverScenePositionForState(state, propagationDate);
    const sunDir = getSunDirection(propagationDate);

    const counts = result.isSnap
      ? this.satelliteRenderer.snapPositions(
          result.positions,
          result.validFlags,
          result.objectCount,
          observerPos,
          sunDir,
          state.visibilityMode,
          this.catalogData,
          state.categoryFilters,
          state.regimeFilters,
          this.getVisualNoradIds()
        )
      : this.satelliteRenderer.updatePositions(
          result.positions,
          result.validFlags,
          result.objectCount,
          observerPos,
          sunDir,
          state.visibilityMode,
          this.catalogData,
          state.categoryFilters,
          state.regimeFilters,
          this.getVisualNoradIds()
        );

    useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

    this.satelliteRenderer.material.uniforms.uT.value = 0.0;

    if (state.showOrbitTrail && state.selectedIndex !== null) {
      this.refreshOrbitTrail(state);
    }

    this.devValidation?.runChecks(result.positions, result.validFlags, result.objectCount);

    if (!this.firstPositionReceived) {
      this.firstPositionReceived = true;
      this.inputManager?.setFirstPositionReceived(true);
      useStore.getState().setLoadingPhase('ready');
    }
  }

  private getObserverScenePositionForState(
    state: ReturnType<typeof useStore.getState>,
    date: Date,
  ): THREE.Vector3 | null {
    if (state.visibilityMode === 'all' || !state.observerLocation) {
      return null;
    }

    return getObserverScenePosition(
      state.observerLocation.lat,
      state.observerLocation.lon,
      state.observerLocation.alt,
      date,
    );
  }

  private recomputeVisibleCounts(state: ReturnType<typeof useStore.getState>): void {
    if (!this.firstPositionReceived || this.catalogData.length === 0) {
      return;
    }

    const simDate = simClock.date();
    const observerPos = this.getObserverScenePositionForState(state, simDate);
    const sunDir = getSunDirection(simDate);

    const counts = this.satelliteRenderer.applyFilters(
      this.catalogData,
      state.categoryFilters,
      state.regimeFilters,
      observerPos,
      sunDir,
      state.visibilityMode,
      this.getVisualNoradIds(),
    );
    useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

    const sel = state.selectedIndex;
    if (sel !== null && sel < this.catalogData.length) {
      const sizeArr = this.satelliteRenderer.mesh.geometry.getAttribute('size').array as Float32Array;
      if (sizeArr[sel] < 0.01) {
        useStore.getState().setSelectedSatellite(null, null);
      }
    }
  }

  /**
   * Build the {@link TrackingSource} adapter the NavigationController reads through.
   * This is the only place that bridges the camera to the renderers + worker clients,
   * keeping the controller itself free of those imports. Uses live field reads +
   * optional chaining so it's valid before the workers exist (created in initWorker).
   */
  private createTrackingSource(): TrackingSource {
    return {
      isReady: () => this.firstPositionReceived,
      getTleCount: () => this.catalogData.length,
      getTleObject: (index) => this.catalogData[index],
      getTleAltitudeKm: (index) => {
        const posArr = this.satelliteRenderer.mesh.geometry.getAttribute('currentPosition');
        const x = posArr.getX(index);
        const y = posArr.getY(index);
        const z = posArr.getZ(index);
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        return (magnitude * EARTH_RADIUS_KM) - EARTH_RADIUS_KM;
      },
      getInterpolationFactor: () => this.satelliteRenderer.material.uniforms.uT.value as number,
      getTleKinematics: (index, uT, outPos, outVel) => {
        if (index < 0 || index >= this.catalogData.length) return false;
        outPos.copy(this.satelliteRenderer.getInterpolatedPosition(index, uT));
        // Never leave outVel stale: zero it when the worker client isn't up yet.
        if (this.sgp4Client) {
          this.sgp4Client.getInterpolatedVelocity(index, uT, outVel);
        } else {
          outVel.set(0, 0, 0);
        }
        return true;
      },
      getDsoKinematics: (dsoIndex, outPos, outVel) =>
        this.dsoLayer.getDsoKinematics(dsoIndex, outPos, outVel),
    };
  }

  private getVisualNoradIds(): Set<number> {
    return this.visualListPoller?.visualNoradIds ?? Engine.EMPTY_NORAD_SET;
  }

  private applyVisualListResult(result: VisualListResolvedResult): void {
    const store = useStore.getState();

    store.setVisualListState({
      status: result.status,
      version: result.version,
      source: result.source,
      stale: result.stale,
      count: result.ids.size,
      updatedAt: Date.now(),
      message: result.message,
    });

    const nextMode = reconcileVisibilityModeForVisualStatus(
      store.visibilityMode,
      result.status,
    );
    if (nextMode !== store.visibilityMode) {
      store.setVisibilityMode(nextMode);
    }

    this.recomputeVisibleCounts(useStore.getState());
  }

  private refreshOrbitTrail(
    state: ReturnType<typeof useStore.getState> = useStore.getState(),
  ): void {
    if (!state.showOrbitTrail) {
      this.world.runLayerCommand(this.trailsLayer, 'clear', () => this.trailsLayer.clear());
      return;
    }

    const selectedIndex = state.selectedIndex;
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < this.catalogData.length) {
      const sat = this.catalogData[selectedIndex];
      const anchorMs = this.sgp4Client?.getCurrentPropagationTimestampMs() ?? simClock.now();
      this.world.runLayerCommand(this.trailsLayer, 'generate', () =>
        this.trailsLayer.generate(sat.line1, sat.line2, anchorMs),
      );
      return;
    }

    if (state.selectedDso) {
      this.dsoLayer.requestTrail(state.selectedDso.dsoId);
      return;
    }

    this.world.runLayerCommand(this.trailsLayer, 'clear', () => this.trailsLayer.clear());
  }

  /** Called by store actions on rate change, jumpTo, or reset. */
  private onSimTimeJump(): void {
    // SGP4: immediate snap + reschedule (all handled internally)
    this.sgp4Client?.requestImmediateSnap();
    this.satelliteRenderer.material.uniforms.uT.value = 0.0;

    // Immediate DSO tick at new sim-time
    this.dsoLayer.triggerImmediateTick(simClock.now());

    // Refresh orbit trails at new time
    this.refreshOrbitTrail(useStore.getState());
  }

  start(): void {
    this.clock.start();
    this.loop();
  }

  private loop = (): void => {
    this.animationId = requestAnimationFrame(this.loop);
    const delta = this.clock.getDelta();
    const now = simClock.date();

    const sunDir = getSunDirection(now);
    const gast = getGAST(now);

    // GPU-side interpolation factor for TLE positions
    const tickState = this.sgp4Client?.getTickState();
    const uT = tickState?.uT ?? 0.0;
    this.satelliteRenderer.material.uniforms.uT.value = uT;

    // Per-frame context shared by all registered layers (Slice 5).
    const navState = useStore.getState();
    const frame: FrameContext = {
      date: now,
      nowMs: simClock.now(),
      delta,
      uT,
      pixelRatio: this.renderer.getPixelRatio(),
      cameraDistance: this.camera.position.length(),
      sunDirectionECI: sunDir,
      gastRadians: gast,
      isJoyrideTracking:
        navState.cameraMode === 'following' && navState.trackingStyle === 'joyride',
    };
    this.world.update(frame);

    this.devValidation?.tickFrame();

    // Push sim-time to store at ~4Hz for UI (HUD, TimeController)
    const wallNow = performance.now();
    if (wallNow - this.lastSimTimeUpdateAt > 250) {
      useStore.getState().setSimTimeMs(simClock.now());
      this.lastSimTimeUpdateAt = wallNow;
    }

    // ── Camera mode handling ─────────────────────────────────────────────────
    const selectedIdx = useStore.getState().selectedIndex;

    this.nav.update(uT);

    // ── TLE selection shader uniforms ─────────────────────────────────────────
    const arrivalTime = this.nav.getArrivalTime();
    const timeSinceArrival = arrivalTime > 0
      ? (performance.now() - arrivalTime) / 1000
      : -1.0;
    this.satelliteRenderer.updateSelectedUniforms(
      selectedIdx !== null ? selectedIdx : -1,
      timeSinceArrival,
    );

    this.satelliteRenderer.updateUniforms(
      this.camera.position.length(),
      this.renderer.getPixelRatio(),
    );
    this.renderer.render(this.scene, this.camera);
  };

  private updateObserverMarker(loc: { lat: number; lon: number; alt: number } | null): void {
    const earthGroup = this.earthLayer.group;
    if (!earthGroup) return;
    if (loc) {
      if (!this.observerMarker) {
        // Frustum: 160 degree FOV (half-angle 80deg). radius = height * tan(80)
        // Shallow height=0.02. radiusTop = 0.02 * 5.67 = 0.1134
        const geo = new THREE.CylinderGeometry(0.1134, 0.002, 0.02, 32, 1, true);
        geo.translate(0, 0.01, 0); // Offset so base is at (0,0,0)

        const mat = new THREE.MeshBasicMaterial({
          color: 0x00e5ff,
          transparent: true,
          opacity: 0.35,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: true,
        });

        this.observerMarker = new THREE.Group();
        earthGroup.add(this.observerMarker);

        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 1;
        this.observerMarker.add(mesh);

        // Add wireframe grid lines
        const wireframe = new THREE.LineSegments(
          new THREE.WireframeGeometry(geo),
          new THREE.LineBasicMaterial({
            color: 0xff4444, // Faint red
            transparent: true,
            opacity: 0.25,
            depthTest: true,
            depthWrite: false,
          })
        );
        wireframe.renderOrder = 1;
        this.observerMarker.add(wireframe);
      }
      const pos = getObserverECEFPosition(loc.lat, loc.lon, loc.alt);
      this.observerMarker.position.copy(pos);

      // Orient to surface normal
      const normal = pos.clone().normalize();
      this.observerMarker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        normal
      );
    } else if (this.observerMarker) {
      earthGroup.remove(this.observerMarker);
      this.observerMarker.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.observerMarker = null;
    }
  }

  private onResize = (): void => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    this.cameraRig.resize(width, height);
    this.renderer.setSize(width, height);
  };

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.sgp4Client?.dispose();
    this.visualListPoller?.dispose();
    this.nav.dispose();
    this.filterUnsub?.();
    this.trailUnsub?.();
    this.inputManager?.dispose();
    window.removeEventListener('resize', this.onResize);
    if (this.observerMarker) {
      this.earthLayer.group?.remove(this.observerMarker);
      this.observerMarker.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.observerMarker = null;
    }
    this.gpuPicker?.dispose();
    this.satelliteRenderer.dispose();
    this.world.dispose();
    this.cameraRig.dispose();
    this.renderer.dispose();
  }
}
