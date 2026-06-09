import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EarthRenderer } from './EarthRenderer';
import { StarfieldRenderer } from './StarfieldRenderer';
import { getSunDirection, getGAST } from '../orbital/time';
import { getObserverScenePosition, getObserverECEFPosition } from '../orbital/coordinates';
import {
  reconcileVisibilityModeForVisualStatus,
  type VisualListResolvedResult,
} from '../data/visualList';
import { fetchTleCatalog, VisualListPoller } from '../data/tle-client';
import { SatelliteRenderer } from './SatelliteRenderer';
import { DsoRenderer } from './DsoRenderer';
import type { EnrichedTLEObject } from '../data/types';
import { useStore, type TrackingStyle } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { OrbitTrailRenderer } from './OrbitTrailRenderer';
import { CameraController, HOME_POSITION, HOME_TARGET } from './CameraController';
import { DevValidation } from './DevValidation';
import { initDsoClient, stopDsoClient } from '../data/dso-client';
import { simClock } from './SimClock';
import { Sgp4WorkerClient, type Sgp4PositionResult } from './tle/Sgp4WorkerClient';
import { DsoWorkerClient } from './dso/DsoWorkerClient';
import { InputManager } from './input/InputManager';
import { Renderer } from './render/Renderer';

const EARTH_RADIUS_KM = 6371;
const VISUAL_CAMERA_EYE_HEIGHT_ER = 0.0000025;
const VISUAL_CAMERA_LOOK_AHEAD_ER = 1.6;

export class Engine {
  private static readonly EMPTY_NORAD_SET: Set<number> = new Set();

  private renderer: Renderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock: THREE.Clock;
  private earthRenderer: EarthRenderer;
  private starfieldRenderer: StarfieldRenderer;
  private animationId: number | null = null;
  private satelliteRenderer: SatelliteRenderer;
  private dsoRenderer: DsoRenderer;
  private sgp4Client: Sgp4WorkerClient | null = null;
  private dsoClient: DsoWorkerClient | null = null;
  private firstPositionReceived = false;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private inputManager: InputManager | null = null;
  private dragExitedFollowingFromInput = false;
  private orbitTrailRenderer: OrbitTrailRenderer;
  private cameraController: CameraController;
  private arrivalTime = -1; // performance.now() when camera arrived; -1 = none
  private cameraModeUnsub: (() => void) | null = null;
  private trailUnsub: (() => void) | null = null;
  private filterUnsub: (() => void) | null = null;
  private dsoUnsub: (() => void) | null = null;
  private dsoEphemerisUnsub: (() => void) | null = null;
  private devValidation: DevValidation | null = null;
  private returnEndPos: THREE.Vector3 | null = null;
  private returnEndTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private useHardReset = false;
  private visualListPoller: VisualListPoller | null = null;
  private observerMarker: THREE.Group | null = null;
  private readonly trackingRadialDir = new THREE.Vector3();
  private readonly trackingEndCamPos = new THREE.Vector3();
  private readonly joyrideEntryTarget = new THREE.Vector3();
  private readonly trackingVelocity = new THREE.Vector3();
  private lastSimTimeUpdateAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    this.renderer = new Renderer(canvas);

    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Camera ────────────────────────────────────────────────────────────────
    const aspect = canvas.clientWidth / canvas.clientHeight;
    this.camera = new THREE.PerspectiveCamera(27, aspect, 0.01, 1000);
    this.camera.position.set(0, 1.5, 3.5);

    // ── Controls ──────────────────────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 300; // expanded from 100 to reach JWST (~235 ER)
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;

    // ── Lights ────────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x101820, 0.15);
    this.scene.add(ambient);

    // ── Sub-renderers ─────────────────────────────────────────────────────────
    this.starfieldRenderer = new StarfieldRenderer();
    this.scene.add(this.starfieldRenderer.object);

    const maxAnisotropy = this.renderer.getMaxAnisotropy();
    this.earthRenderer = new EarthRenderer(maxAnisotropy, this.renderer.instance, this.camera);
    this.scene.add(this.earthRenderer.object);

    // ── Satellites ───────────────────────────────────────────────────────────
    this.satelliteRenderer = new SatelliteRenderer(this.scene);

    // ── DSO renderer (always present, inited later when catalog arrives) ─────
    this.dsoRenderer = new DsoRenderer(this.scene);

    // ── Orbit trail ─────────────────────────────────────────────────────────
    this.orbitTrailRenderer = new OrbitTrailRenderer(this.scene);

    // ── Camera controller ────────────────────────────────────────────────────
    this.cameraController = new CameraController(this.camera);

    // Centralized camera mode transitions
    let prevCameraMode = useStore.getState().cameraMode;
    this.cameraModeUnsub = useStore.subscribe((state) => {
      if (state.cameraMode === prevCameraMode) return;
      prevCameraMode = state.cameraMode;

      // Any transition to 'free': cancel animation, re-enable controls
      if (state.cameraMode === 'free') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = true;
        this.inputManager?.cancelJoyrideLook();
        this.arrivalTime = -1;

        if (this.dragExitedFollowingFromInput) {
          this.dragExitedFollowingFromInput = false;
        } else if (this.returnEndPos) {
          this.controls.target.set(0, 0, 0);
          this.returnEndPos = null;
        }
      }

      // Entering 'returning': disable controls and start return animation
      if (state.cameraMode === 'returning') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = false;
        this.inputManager?.cancelJoyrideLook();
        this.arrivalTime = -1;

        this.cameraController.returnToHome(this.controls.target);

        if (this.useHardReset) {
          this.returnEndPos = HOME_POSITION.clone();
          this.returnEndTarget.copy(HOME_TARGET);
          this.useHardReset = false;
        } else {
          const dir = this.camera.position.clone().normalize();
          const currentDistance = this.camera.position.length();
          const targetDist = Math.max(currentDistance, HOME_POSITION.length());
          this.returnEndPos = dir.multiplyScalar(targetDist);
          this.returnEndTarget.set(0, 0, 0);
        }
      }

      if (state.cameraMode === 'flying') {
        this.controls.enabled = false;
      }

      if (state.cameraMode === 'following') {
        this.controls.enabled = false;
      }
    });

    // ── Clock ─────────────────────────────────────────────────────────────────
    this.clock = new THREE.Clock();

    // ── Resize handler ────────────────────────────────────────────────────────
    window.addEventListener('resize', this.onResize);

    // ── Input manager ─────────────────────────────────────────────────────────
    this.inputManager = new InputManager(
      {
        canvas,
        satelliteRenderer: this.satelliteRenderer,
        dsoRenderer: this.dsoRenderer,
        controls: this.controls,
      },
      {
        onSelectTle: (index) => this.selectByIndex(index),
        onSelectDso: (dsoIndex) => this.selectDsoByIndex(dsoIndex),
        onDeselect: () => {
          useStore.getState().setSelectedSatellite(null, null);
          useStore.getState().setSelectedDso(null);
        },
        onDragExitFollow: () => { this.dragExitedFollowingFromInput = true; },
        onJoyrideLookInput: (dx, dy) => this.cameraController.addJoyrideLookInput(dx, dy),
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

      // TLE catalog fetch (pure — no store side effects)
      const catalog = await fetchTleCatalog(apiUrl);
      const { catalogData, tles, categoryCounts, regimeCounts } = catalog;

      useStore.getState().setCatalogInfo({
        objectCount: catalogData.length,
        categoryCounts,
        regimeCounts,
      });

      this.catalogData = catalogData;
      this.inputManager?.setCatalogData(catalogData);

      useStore.getState().setCatalogData(catalogData);
      useStore.getState().setSelectByIndex((index: number) => this.selectByIndex(index));
      useStore.getState().setTriggerFlyTo((index: number) => this.flyToSatellite(index));
      useStore.getState().setTriggerJoyride((index: number) => this.joyrideSatellite(index));
      useStore.getState().setTriggerResetCamera(() => this.resetCamera());
      useStore.getState().setTriggerFlyToDso((dsoId: string) => this.flyToDso(dsoId));
      useStore.getState().setTriggerJoyrideDso((dsoId: string) => this.joyrideDso(dsoId));
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

      this.dsoClient = new DsoWorkerClient({
        onPositions: (positions, _velocities, visibleFlags) => {
          this.dsoRenderer.updateFromWorkerBuffers(positions, visibleFlags);
        },
        onTrail: (dsoId, positions) => {
          // Gate: only apply if trail is active and this DSO is selected
          const state = useStore.getState();
          if (!state.showOrbitTrail || state.selectedDso?.dsoId !== dsoId) return;
          this.orbitTrailRenderer.generateFromPositions(positions);
        },
      });

      // ── DSO catalog subscription ────────────────────────────────────────────
      // Re-init DSO renderer whenever dsoObjects changes in the store.
      // initDsoClient() runs in parallel and writes to the store when ready.
      let prevDsoObjects = useStore.getState().dsoObjects;
      this.dsoUnsub = useStore.subscribe((state) => {
        if (state.dsoObjects !== prevDsoObjects) {
          prevDsoObjects = state.dsoObjects;
          this.dsoRenderer.init(state.dsoObjects, this.catalogData.length);
          this.gpuPicker?.addDsoGeometry(this.dsoRenderer.geometry, state.dsoObjects.length);
          this.dsoClient?.syncIds(state.dsoObjects.map((dso) => dso.dsoId));
          if (state.showOrbitTrail) {
            this.refreshOrbitTrail(state);
          }
        }
      });
      let prevDsoEphemeris = useStore.getState().dsoEphemerisById;
      this.dsoEphemerisUnsub = useStore.subscribe((state) => {
        if (state.dsoEphemerisById !== prevDsoEphemeris) {
          this.dsoClient?.syncEphemerisDiff(prevDsoEphemeris, state.dsoEphemerisById);
          prevDsoEphemeris = state.dsoEphemerisById;
          if (state.showOrbitTrail && state.selectedDso) {
            this.dsoClient?.requestTrail(state.selectedDso.dsoId);
          }
        }
      });

      // Start DSO pipeline in parallel — non-blocking
      initDsoClient().catch((err) =>
        console.warn('DSO client init error:', err),
      );

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
            this.focusCameraOnObserverSky(state.observerLocation);
          } else if (modeChanged && prevMode === 'visual' && state.visibilityMode !== 'visual') {
            this.resetCamera();
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

  private focusCameraOnObserverSky(loc: { lat: number; lon: number; alt: number }): void {
    const { observerWorldPos, upDir } = this.getObserverSkyAnchor(loc);
    const camPos = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_EYE_HEIGHT_ER);
    const lookTarget = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_LOOK_AHEAD_ER);

    const store = useStore.getState();
    if (store.cameraMode !== 'free') {
      store.setCameraMode('free');
    }

    this.cameraController.cancel();
    this.arrivalTime = -1;
    this.returnEndPos = null;
    this.controls.enabled = true;
    this.camera.position.copy(camPos);
    this.controls.target.copy(lookTarget);
    this.camera.lookAt(lookTarget);
    this.controls.update();
  }

  private getObserverSkyAnchor(
    loc: { lat: number; lon: number; alt: number },
  ): { observerWorldPos: THREE.Vector3; upDir: THREE.Vector3 } {
    const observerWorldPos = getObserverScenePosition(
      loc.lat,
      loc.lon,
      loc.alt,
      simClock.date(),
    );
    const upDir = observerWorldPos.clone().normalize();
    return { observerWorldPos, upDir };
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
      this.orbitTrailRenderer.clear();
      return;
    }

    const selectedIndex = state.selectedIndex;
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < this.catalogData.length) {
      const sat = this.catalogData[selectedIndex];
      this.orbitTrailRenderer.generate(
        sat.line1,
        sat.line2,
        this.sgp4Client?.getCurrentPropagationTimestampMs() ?? simClock.now(),
      );
      return;
    }

    if (state.selectedDso) {
      this.dsoClient?.requestTrail(state.selectedDso.dsoId);
      return;
    }

    this.orbitTrailRenderer.clear();
  }

  /** Called by store actions on rate change, jumpTo, or reset. */
  private onSimTimeJump(): void {
    // SGP4: immediate snap + reschedule (all handled internally)
    this.sgp4Client?.requestImmediateSnap();
    this.satelliteRenderer.material.uniforms.uT.value = 0.0;

    // Immediate DSO tick at new sim-time
    this.dsoClient?.triggerImmediateTick(simClock.now());

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
    this.earthRenderer.sunDirection.copy(sunDir);
    this.earthRenderer.object.rotation.y = getGAST(now);

    // GPU-side interpolation factor for TLE positions
    const tickState = this.sgp4Client?.getTickState();
    const uT = tickState?.uT ?? 0.0;
    this.satelliteRenderer.material.uniforms.uT.value = uT;

    this.devValidation?.tickFrame();

    // ── DSO position update (worker-driven) ───────────────────────────────────
    const store = useStore.getState();
    this.dsoClient?.tick(simClock.now());
    // Push sim-time to store at ~4Hz for UI (HUD, TimeController)
    const wallNow = performance.now();
    if (wallNow - this.lastSimTimeUpdateAt > 250) {
      useStore.getState().setSimTimeMs(simClock.now());
      this.lastSimTimeUpdateAt = wallNow;
    }

    this.dsoRenderer.updateUniforms(this.renderer.getPixelRatio());

    // ── DSO label screen positions ────────────────────────────────────────────
    const canvas = this.renderer.domElement;
    const labelPositions = this.dsoRenderer.getScreenPositions(
      this.camera,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    useStore.getState().setDsoLabelPositions(labelPositions);

    // ── Camera mode handling ─────────────────────────────────────────────────
    const cameraMode = store.cameraMode;
    const trackingStyle = store.trackingStyle;
    const selectedIdx = store.selectedIndex;
    const selectedDso = store.selectedDso;

    if (cameraMode === 'free') {
      // Observer sky camera (visual mode): keep camera pinned to geolocation
      // and facing up, so the view remains correct as Earth rotates.
      if (store.visibilityMode === 'visual' && store.observerLocation) {
        const { observerWorldPos, upDir } = this.getObserverSkyAnchor(store.observerLocation);
        const camPos = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_EYE_HEIGHT_ER);
        const lookTarget = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_LOOK_AHEAD_ER);
        this.camera.position.copy(camPos);
        this.controls.target.copy(lookTarget);
        this.camera.lookAt(lookTarget);
      } else {
        this.controls.update();
      }

    } else if (cameraMode === 'flying' && selectedIdx !== null) {
      // TLE fly-to
      const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
      let endCamPos: THREE.Vector3;
      let endTarget: THREE.Vector3;
      if (trackingStyle === 'joyride') {
        this.sgp4Client!.getInterpolatedVelocity(selectedIdx, uT, this.trackingVelocity);
        endCamPos = satPos;
        this.cameraController.getJoyrideEntryTarget(satPos, this.trackingVelocity, this.joyrideEntryTarget);
        endTarget = this.joyrideEntryTarget;
      } else {
        this.trackingRadialDir.copy(satPos).normalize();
        this.trackingEndCamPos.copy(satPos).addScaledVector(
          this.trackingRadialDir,
          this.cameraController.followOffsetDist,
        );
        endCamPos = this.trackingEndCamPos;
        endTarget = satPos;
      }
      const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
      if (done) {
        store.setCameraMode('following');
        this.arrivalTime = performance.now();
      }

    } else if (cameraMode === 'flying' && selectedDso !== null) {
      // DSO fly-to
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (dsoIndex >= 0 && this.dsoRenderer.isVisible(dsoIndex)) {
        const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
        let endCamPos: THREE.Vector3;
        let endTarget: THREE.Vector3;
        if (trackingStyle === 'joyride') {
          this.dsoClient!.getDsoVelocity(dsoIndex, this.trackingVelocity);
          endCamPos = dsoPos;
          this.cameraController.getJoyrideEntryTarget(dsoPos, this.trackingVelocity, this.joyrideEntryTarget);
          endTarget = this.joyrideEntryTarget;
        } else {
          this.trackingRadialDir.copy(dsoPos).normalize();
          this.trackingEndCamPos.copy(dsoPos).addScaledVector(
            this.trackingRadialDir,
            this.cameraController.followOffsetDist,
          );
          endCamPos = this.trackingEndCamPos;
          endTarget = dsoPos;
        }
        const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
        if (done) {
          store.setCameraMode('following');
          this.arrivalTime = performance.now();
        }
      } else {
        // No ephemeris yet — stay in free until data arrives
        store.setCameraMode('free');
      }

    } else if (cameraMode === 'following' && selectedIdx !== null) {
      // TLE follow
      const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
      if (trackingStyle === 'joyride') {
        this.sgp4Client!.getInterpolatedVelocity(selectedIdx, uT, this.trackingVelocity);
        this.cameraController.updateJoyride(satPos, this.trackingVelocity, this.controls.target);
      } else {
        this.cameraController.updateFollow(satPos, this.controls.target);
      }

    } else if (cameraMode === 'following' && selectedDso !== null) {
      // DSO follow
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (dsoIndex >= 0 && this.dsoRenderer.isVisible(dsoIndex)) {
        const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
        if (trackingStyle === 'joyride') {
          this.dsoClient!.getDsoVelocity(dsoIndex, this.trackingVelocity);
          this.cameraController.updateJoyride(dsoPos, this.trackingVelocity, this.controls.target);
        } else {
          this.cameraController.updateFollow(dsoPos, this.controls.target);
        }
      }

    } else if (cameraMode === 'returning') {
      const done = this.cameraController.updateAnim(
        this.returnEndPos || HOME_POSITION, this.returnEndTarget, this.controls.target,
      );
      if (done) {
        store.setCameraMode('free');
      }
    }

    // ── TLE selection shader uniforms ─────────────────────────────────────────
    const timeSinceArrival = this.arrivalTime > 0
      ? (performance.now() - this.arrivalTime) / 1000
      : -1.0;
    this.satelliteRenderer.updateSelectedUniforms(
      selectedIdx !== null ? selectedIdx : -1,
      timeSinceArrival,
    );

    // ── DSO selection shader uniform ──────────────────────────────────────────
    if (selectedDso !== null) {
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      this.dsoRenderer.setSelectedDsoIndex(dsoIndex);
    } else {
      this.dsoRenderer.setSelectedDsoIndex(-1);
    }

    this.earthRenderer.update(delta, this.camera);
    this.satelliteRenderer.updateUniforms(
      this.camera.position.length(),
      this.renderer.getPixelRatio(),
    );
    this.orbitTrailRenderer.setJoyrideMode(cameraMode === 'following' && trackingStyle === 'joyride');
    this.renderer.render(this.scene, this.camera);
  };

  selectByIndex(index: number): void {
    if (index < 0 || index >= this.catalogData.length) return;

    const posArr = this.satelliteRenderer.mesh.geometry.getAttribute('currentPosition');
    const x = posArr.getX(index);
    const y = posArr.getY(index);
    const z = posArr.getZ(index);
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const altitudeKm = (magnitude * EARTH_RADIUS_KM) - EARTH_RADIUS_KM;

    const store = useStore.getState();

    const isTracking = store.cameraMode === 'flying' || store.cameraMode === 'following';
    if (isTracking && store.selectedIndex !== null && store.selectedIndex !== index) {
      store.setSelectedSatellite(index, this.catalogData[index], Math.round(altitudeKm));
      const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
      const satPos = this.satelliteRenderer.getInterpolatedPosition(index, uT);
      if (store.trackingStyle === 'joyride') {
        this.cameraController.resetJoyrideState();
      }
      this.arrivalTime = -1;
      this.cameraController.flyTo(satPos, this.controls.target);
      store.setCameraMode('flying');
      return;
    }

    if (store.cameraMode !== 'free' && store.selectedIndex !== index) {
      store.setCameraMode('free');
    }

    store.setSelectedSatellite(index, this.catalogData[index], Math.round(altitudeKm));
  }

  selectDsoByIndex(dsoIndex: number): void {
    const store = useStore.getState();
    const dso = store.dsoObjects[dsoIndex];
    if (!dso) return;

    if (store.cameraMode !== 'free') {
      store.setCameraMode('free');
    }

    store.setSelectedDso(dso);
  }

  flyToSatellite(index: number, style: TrackingStyle = 'follow'): void {
    if (index < 0 || index >= this.catalogData.length || !this.firstPositionReceived) return;

    let store = useStore.getState();
    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedIndex === index
      && store.trackingStyle === style) return;

    if (store.selectedIndex !== index) {
      this.selectByIndex(index);
    }

    store = useStore.getState();
    if (store.selectedIndex !== index) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
    const satPos = this.satelliteRenderer.getInterpolatedPosition(index, uT);

    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(satPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideSatellite(index: number): void {
    this.flyToSatellite(index, 'joyride');
  }

  flyToDso(dsoId: string, style: TrackingStyle = 'follow'): void {
    let store = useStore.getState();
    const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === dsoId);
    if (dsoIndex < 0 || !this.dsoRenderer.isVisible(dsoIndex)) return;

    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedDso?.dsoId === dsoId
      && store.trackingStyle === style) return;

    if (store.selectedDso?.dsoId !== dsoId) {
      store.setSelectedDso(store.dsoObjects[dsoIndex]);
    }

    store = useStore.getState();
    if (store.selectedDso?.dsoId !== dsoId) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(dsoPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideDso(dsoId: string): void {
    this.flyToDso(dsoId, 'joyride');
  }

  resetCamera(): void {
    const store = useStore.getState();
    this.useHardReset = true;
    if (store.cameraMode !== 'returning') {
      store.setCameraMode('returning');
    } else {
      this.returnEndPos = HOME_POSITION.clone();
      this.returnEndTarget.copy(HOME_TARGET);
      this.cameraController.returnToHome(this.controls.target);
      this.useHardReset = false;
    }
  }

  private updateObserverMarker(loc: { lat: number; lon: number; alt: number } | null): void {
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
        this.earthRenderer.object.add(this.observerMarker);

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
      this.earthRenderer.object.remove(this.observerMarker);
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  dispose(): void {
    stopDsoClient();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.sgp4Client?.dispose();
    this.visualListPoller?.dispose();
    this.cameraModeUnsub?.();
    this.filterUnsub?.();
    this.trailUnsub?.();
    this.dsoUnsub?.();
    this.dsoEphemerisUnsub?.();
    this.dsoClient?.dispose();
    this.inputManager?.dispose();
    window.removeEventListener('resize', this.onResize);
    if (this.observerMarker) {
      this.earthRenderer.object.remove(this.observerMarker);
      this.observerMarker.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.observerMarker = null;
    }
    this.gpuPicker?.dispose();
    this.dsoRenderer.dispose();
    this.orbitTrailRenderer.dispose();
    this.satelliteRenderer.dispose();
    this.earthRenderer.dispose();
    this.starfieldRenderer.dispose();
    this.renderer.dispose();
  }
}
