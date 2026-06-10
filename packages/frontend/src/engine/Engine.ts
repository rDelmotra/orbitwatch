import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getSunDirection, getGAST } from '../orbital/time';
import { getObserverECEFPosition } from '../orbital/coordinates';
import {
  reconcileVisibilityModeForVisualStatus,
  type VisualListResolvedResult,
} from '../data/visualList';
import { VisualListPoller } from '../data/tle-client';
import { bootstrapCatalog } from '../data/bootstrapCatalog';
import type { EnrichedTLEObject } from '../data/types';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { initDsoClient, stopDsoClient } from '../data/dso-client';
import { simClock } from './SimClock';
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
import { SatellitesLayer } from './world/layers/SatellitesLayer';
import type { FrameContext } from './render/Layer';

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
  private satellitesLayer: SatellitesLayer;
  private dsoLayer: DsoLayer;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private inputManager: InputManager | null = null;
  private trailsLayer: TrailsLayer;
  private nav: NavigationController;
  private trailUnsub: (() => void) | null = null;
  private visualListPoller: VisualListPoller | null = null;
  private observerMarker: THREE.Group | null = null;
  private lastSimTimeUpdateAt = 0;
  private isDisposed = false;
  private criticalFailed = false;

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
    this.satellitesLayer = new SatellitesLayer();
    this.world = new World({
      onCriticalError: (err) => this.handleCriticalError(err),
    });
    this.world.register(this.earthLayer);
    this.world.register(new StarfieldLayer());
    this.world.register(this.trailsLayer);
    this.world.register(this.dsoLayer);
    // Satellites registered last so the point cloud is added to the scene last
    // (drawn over Earth/DSO), matching the prior inline order.
    this.world.register(this.satellitesLayer);
    // Synchronous layers (all current ones) fully init in this call, so their
    // renderers are ready for InputManager / TrackingSource below.
    this.world.init({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer.instance,
      maxAnisotropy,
    });

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
    // Guarded: a critical satellites-init failure leaves no renderer (and has
    // already escalated to the error screen), so skip input wiring entirely.
    const satelliteRenderer = this.satellitesLayer.renderer;
    if (satelliteRenderer) {
      this.inputManager = new InputManager(
        {
          canvas,
          satelliteRenderer,
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
    }

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

      if (this.isDisposed) return;

      this.catalogData = catalogData;
      this.inputManager?.setCatalogData(catalogData);

      useStore.getState().setSelectByIndex((index: number) => this.nav.selectByIndex(index));
      useStore.getState().setTriggerFlyTo((index: number) => this.nav.flyToSatellite(index));
      useStore.getState().setTriggerJoyride((index: number) => this.nav.joyrideSatellite(index));
      useStore.getState().setTriggerResetCamera(() => this.nav.resetCamera());
      useStore.getState().setTriggerFlyToDso((dsoId: string) => this.nav.flyToDso(dsoId));
      useStore.getState().setTriggerJoyrideDso((dsoId: string) => this.nav.joyrideDso(dsoId));
      useStore.getState().setTriggerSimTimeJump(() => this.onSimTimeJump());

      // ── Satellites layer activation (renderer prime + SGP4 worker) ───────────
      // Critical layer: if activate throws, World escalates it (onCriticalError →
      // setLoadingError) — same user-visible outcome as the old try/catch around
      // worker construction. The GPU picker is built right after activate returns;
      // safe because the worker's first POSITIONS message is async (a later task).
      console.log(`Loaded ${tles.length} TLEs from backend`);
      useStore.getState().setLoadingPhase('initializing');

      const satellitesActivated = this.world.runLayerCommand(
        this.satellitesLayer,
        'activate',
        () =>
          this.satellitesLayer.activate(catalogData, tles, {
            getVisualNoradIds: () => this.getVisualNoradIds(),
            onError: (err, phase) =>
              this.world.reportLayerFailure(this.satellitesLayer, err, phase),
            onReady: () => useStore.getState().setLoadingPhase('propagating'),
            onFirstPosition: () => {
              this.inputManager?.setFirstPositionReceived(true);
              useStore.getState().setLoadingPhase('ready');
            },
            onSelectionInvalidated: () =>
              useStore.getState().setSelectedSatellite(null, null),
            onTrailRefresh: () => this.refreshOrbitTrail(),
            onObserverChange: (loc) => this.updateObserverMarker(loc),
            onEnterObserverSky: (loc) => this.nav.focusCameraOnObserverSky(loc),
            onExitObserverSky: () => this.nav.resetCamera(),
          }),
      );

      if (!satellitesActivated) {
        // The product-critical layer is dead. World.onCriticalError →
        // handleCriticalError() has already shown the error + torn down the
        // loop/picker/input; don't keep wiring DSO/trail onto a dead engine.
        return;
      }

      const satelliteRenderer = this.satellitesLayer.renderer;
      if (satelliteRenderer) {
        this.gpuPicker = new GPUPicker(
          this.renderer.instance,
          this.camera,
          satelliteRenderer,
          catalogData.length,
        );
        this.inputManager?.setGpuPicker(this.gpuPicker);
      }

      // ── DSO layer activation (worker client + subscriptions) ─────────────────
      // Guarded: if DSO init failed (non-critical) this is skipped; if activation
      // throws, World isolates it so DSO fails soft instead of failing the TLE init.
      const dsoActivated = this.world.runLayerCommand(this.dsoLayer, 'activate', () =>
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
        }),
      );

      // Global DSO catalog/manifest polling (populates the store the DSO layer
      // reacts to) — data orchestration lives here, not in the visual layer.
      // Only start it if the DSO layer actually activated: no point feeding a
      // disabled visual layer (keeps the "DSO fails soft" story honest).
      if (dsoActivated) {
        initDsoClient().catch((err) => console.warn('DSO client init error:', err));
      }

      // (Satellite-visibility subscription — category/regime/mode/observer — now
      // lives in SatellitesLayer.activate(); cross-cutting effects route back here
      // via its callbacks above.)

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
    } catch (err) {
      console.error('Failed to initialize SGP4 worker:', err);
      useStore.getState().setLoadingError(
        err instanceof Error ? err.message : 'Failed to load satellite data',
      );
    }
  }

  /**
   * Build the {@link TrackingSource} adapter the NavigationController reads through.
   * This is the only place that bridges the camera to the layers, keeping the
   * controller itself free of those imports. Uses live field reads + optional
   * chaining so it's valid before the catalog/worker exist (set in initWorker).
   */
  private createTrackingSource(): TrackingSource {
    return {
      isReady: () => this.satellitesLayer.isReady(),
      getTleCount: () => this.catalogData.length,
      getTleObject: (index) => this.catalogData[index],
      getTleAltitudeKm: (index) => this.satellitesLayer.getTleAltitudeKm(index),
      getInterpolationFactor: () => this.satellitesLayer.getInterpolationFactor(),
      getTleKinematics: (index, uT, outPos, outVel) =>
        this.satellitesLayer.getTleKinematics(index, uT, outPos, outVel),
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

    this.world.runLayerCommand(this.satellitesLayer, 'recompute', () =>
      this.satellitesLayer.recomputeVisibleCounts(useStore.getState()),
    );
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
      const anchorMs = this.satellitesLayer.getPropagationTimestampMs();
      this.world.runLayerCommand(this.trailsLayer, 'generate', () =>
        this.trailsLayer.generate(sat.line1, sat.line2, anchorMs),
      );
      return;
    }

    if (state.selectedDso) {
      const dsoId = state.selectedDso.dsoId;
      this.world.runLayerCommand(this.dsoLayer, 'requestTrail', () =>
        this.dsoLayer.requestTrail(dsoId),
      );
      return;
    }

    this.world.runLayerCommand(this.trailsLayer, 'clear', () => this.trailsLayer.clear());
  }

  /** Called by store actions on rate change, jumpTo, or reset. */
  private onSimTimeJump(): void {
    // SGP4: immediate snap + reset interpolation tween (handled in the layer)
    this.world.runLayerCommand(this.satellitesLayer, 'requestImmediateSnap', () =>
      this.satellitesLayer.requestImmediateSnap(),
    );

    // Immediate DSO tick at new sim-time
    this.world.runLayerCommand(this.dsoLayer, 'triggerImmediateTick', () =>
      this.dsoLayer.triggerImmediateTick(simClock.now()),
    );

    // Refresh orbit trails at new time
    this.refreshOrbitTrail(useStore.getState());
  }

  start(): void {
    // A critical layer that died during construction already tore everything
    // down — don't spin up a render loop over a dead engine.
    if (this.criticalFailed) return;
    this.clock.start();
    this.loop();
  }

  /**
   * A critical layer (satellites = the product) failed — at init OR at runtime.
   * Show the error and tear down the infrastructure that holds references to the
   * now-disposed satellite renderer (the GPU picker + input listeners) and stop
   * the render loop, so nothing touches freed GL after the failure. Idempotent.
   * (World disposes the failed layer itself; this handles the Engine-owned
   * consumers World can't see.)
   */
  private handleCriticalError(err: unknown): void {
    if (this.criticalFailed) return;
    this.criticalFailed = true;

    useStore.getState().setLoadingError(
      err instanceof Error ? err.message : 'A critical layer failed',
    );

    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.inputManager?.dispose();
    this.inputManager = null;
    this.gpuPicker?.dispose();
    this.gpuPicker = null;
  }

  private loop = (): void => {
    this.animationId = requestAnimationFrame(this.loop);
    const delta = this.clock.getDelta();
    const now = simClock.date();

    const sunDir = getSunDirection(now);
    const gast = getGAST(now);

    // GPU-side interpolation factor for TLE positions (owned by SatellitesLayer).
    const uT = this.satellitesLayer.getInterpolationFactor();

    // Camera state machine runs FIRST so the frame carries this-frame camera
    // position/distance (Earth/DSO LOD + label projection) and the freshest
    // selection arrival time for the satellite glow.
    this.nav.update(uT);
    const arrivalTime = this.nav.getArrivalTime();
    const selectionTimeSinceArrival = arrivalTime > 0
      ? (performance.now() - arrivalTime) / 1000
      : -1.0;

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
      selectionTimeSinceArrival,
    };
    this.world.update(frame);

    // Push sim-time to store at ~4Hz for UI (HUD, TimeController)
    const wallNow = performance.now();
    if (wallNow - this.lastSimTimeUpdateAt > 250) {
      useStore.getState().setSimTimeMs(simClock.now());
      this.lastSimTimeUpdateAt = wallNow;
    }

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
    this.isDisposed = true;
    stopDsoClient();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualListPoller?.dispose();
    this.nav.dispose();
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
    // GPU picker references the satellite renderer's geometry — dispose it before
    // World disposes the SatellitesLayer.
    this.gpuPicker?.dispose();
    this.world.dispose();
    this.cameraRig.dispose();
    this.renderer.dispose();
  }
}
