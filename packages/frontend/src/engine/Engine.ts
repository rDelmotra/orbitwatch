import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EarthRenderer } from './EarthRenderer';
import { StarfieldRenderer } from './StarfieldRenderer';
import { getSunDirection, getGAST } from '../orbital/time';
import { getObserverScenePosition, getObserverECEFPosition } from '../orbital/coordinates';
import { fetchVisualNoradIds } from '../data/visualList';
import { SatelliteRenderer } from './SatelliteRenderer';
import { DsoRenderer } from './DsoRenderer';
import type { TLEInput, EnrichedTLEObject, WorkerOutMessage, ObjectCategory, OrbitalRegime } from '../data/types';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { OrbitTrailRenderer } from './OrbitTrailRenderer';
import { CameraController, HOME_POSITION, HOME_TARGET } from './CameraController';
import { DevValidation } from './DevValidation';
import { initDsoClient, stopDsoClient } from '../data/dso-client';
import type { DsoSnapshot } from '../data/dso-types';

const EARTH_RADIUS_KM = 6371;
const CLUSTER_RADIUS_SQ = 0.0078 * 0.0078; // ~50 km in scene units, squared
const DSO_VALID_TO_GRACE_SEC = 600;
const DSO_TRAIL_POINTS = 360;
const DSO_WORKER_RESTART_DELAY_MS = 500;
const DSO_WORKER_STALL_TIMEOUT_MS = 5000;

type DsoWorkerInMessage =
  | {
      type: 'INIT_SNAPSHOTS';
      dsoIds: string[];
      snapshots: Record<string, DsoSnapshot>;
      validToGraceSec?: number;
    }
  | { type: 'SET_DSO_IDS'; dsoIds: string[] }
  | { type: 'UPDATE_SNAPSHOT'; dsoId: string; snapshot: DsoSnapshot | null }
  | { type: 'SET_VALID_TO_GRACE_SEC'; validToGraceSec: number }
  | { type: 'TICK'; timestamp: number }
  | { type: 'BUILD_TRAIL'; dsoId: string; pointCount?: number };

type DsoWorkerOutMessage =
  | { type: 'POSITIONS'; positions: Float32Array; visibleFlags: Uint8Array }
  | { type: 'TRAIL'; dsoId: string; positions: Float32Array };

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock: THREE.Clock;
  private earthRenderer: EarthRenderer;
  private starfieldRenderer: StarfieldRenderer;
  private animationId: number | null = null;
  private satelliteRenderer: SatelliteRenderer;
  private dsoRenderer: DsoRenderer;
  private worker: Worker | null = null;
  private dsoWorker: Worker | null = null;
  private dsoWorkerTickInFlight = false;
  private dsoWorkerLastTickSentAt = 0;
  private dsoWorkerRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private dsoWorkerKnownIds = new Set<string>();
  private dsoWorkerKnownSnapshotVersions = new Map<string, string>();
  private propagationInterval: ReturnType<typeof setInterval> | null = null;
  private objectCount = 0;
  private lastTickTime = 0;
  private firstPositionReceived = false;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private pointerDownPos: { x: number; y: number } | null = null;
  private lastHoverTime = 0;
  private static readonly HOVER_THROTTLE_MS = 100;
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
  private dragExitedFollowing = false;
  private visualNoradIds: Set<number> = new Set();
  private observerMarker: THREE.Mesh | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();

    // ── Camera ────────────────────────────────────────────────────────────────
    const aspect = canvas.clientWidth / canvas.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
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

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.earthRenderer = new EarthRenderer(maxAnisotropy, this.renderer, this.camera);
    this.scene.add(this.earthRenderer.object);

    // ── Satellites ───────────────────────────────────────────────────────────
    this.satelliteRenderer = new SatelliteRenderer(this.scene);

    // ── DSO renderer (always present, inited later when catalog arrives) ─────
    this.dsoRenderer = new DsoRenderer(this.scene);

    // ── Orbit trail ─────────────────────────────────────────────────────────
    this.orbitTrailRenderer = new OrbitTrailRenderer(this.scene);

    // ── Camera controller ────────────────────────────────────────────────────
    this.cameraController = new CameraController(this.camera);

    // Exit following mode when user begins an OrbitControls interaction (drag)
    this.controls.addEventListener('start', this.onControlsStart);

    // Centralized camera mode transitions
    let prevCameraMode = useStore.getState().cameraMode;
    this.cameraModeUnsub = useStore.subscribe((state) => {
      if (state.cameraMode === prevCameraMode) return;
      prevCameraMode = state.cameraMode;

      // Any transition to 'free': cancel animation, re-enable controls
      if (state.cameraMode === 'free') {
        this.cameraController.cancel();
        this.controls.enabled = true;
        this.arrivalTime = -1;

        if (this.dragExitedFollowing) {
          this.dragExitedFollowing = false;
        } else if (this.returnEndPos) {
          this.controls.target.set(0, 0, 0);
          this.returnEndPos = null;
        }
      }

      // Entering 'returning': disable controls and start return animation
      if (state.cameraMode === 'returning') {
        this.cameraController.cancel();
        this.controls.enabled = false;
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

    // ── Click picking ───────────────────────────────────────────────────────
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);

    // ── Load TLE data and start propagation ───────────────────────────────────
    this.initWorker();
  }

  private async initWorker(): Promise<void> {
    const store = useStore.getState();
    try {
      store.setLoadingPhase('fetching');
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      // Visual list is optional: keep TLE bootstrap fast even if this request fails.
      void fetchVisualNoradIds(apiUrl).then((visualIds) => {
        this.visualNoradIds = visualIds;
      });

      const res = await fetch(`${apiUrl}/api/tle/all`);
      if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);

      const response = await res.json();
      const catalogData: EnrichedTLEObject[] = response.data;
      const tles: TLEInput[] = catalogData.map((d) => ({
        noradId: d.noradId,
        line1: d.line1,
        line2: d.line2,
      }));

      const categoryCounts: Record<ObjectCategory, number> = {
        active_satellite: 0,
        inactive_satellite: 0,
        rocket_body: 0,
        debris: 0,
        unknown: 0,
        deep_space: 0,
      };
      const regimeCounts: Record<OrbitalRegime, number> = {
        LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
      };
      for (const obj of catalogData) {
        categoryCounts[obj.category] = (categoryCounts[obj.category] ?? 0) + 1;
        regimeCounts[obj.regime] = (regimeCounts[obj.regime] ?? 0) + 1;
      }
      useStore.getState().setCatalogInfo({
        objectCount: catalogData.length,
        categoryCounts,
        regimeCounts,
        version: response.version,
      });

      this.catalogData = catalogData;

      useStore.getState().setCatalogData(catalogData);
      useStore.getState().setSelectByIndex((index: number) => this.selectByIndex(index));
      useStore.getState().setTriggerFlyTo((index: number) => this.flyToSatellite(index));
      useStore.getState().setTriggerResetCamera(() => this.resetCamera());
      useStore.getState().setTriggerFlyToDso((dsoId: string) => this.flyToDso(dsoId));

      this.satelliteRenderer.initFromCatalog(catalogData);

      this.gpuPicker = new GPUPicker(
        this.renderer,
        this.camera,
        this.satelliteRenderer,
        catalogData.length,
      );

      if (import.meta.env.DEV) {
        this.devValidation = new DevValidation();
        this.devValidation.initFromCatalog(catalogData);
      }

      const issIndex = catalogData.findIndex((d) => d.noradId === 25544);
      if (issIndex !== -1) {
        this.satelliteRenderer.setSatelliteColor(issIndex, 0.2, 1.0, 0.4);
        this.satelliteRenderer.setSatelliteSize(issIndex, 2.0);
      }

      this.initDsoWorker();

      // ── DSO catalog subscription ────────────────────────────────────────────
      // Re-init DSO renderer whenever dsoObjects changes in the store.
      // initDsoClient() runs in parallel and writes to the store when ready.
      let prevDsoObjects = useStore.getState().dsoObjects;
      this.dsoUnsub = useStore.subscribe((state) => {
        if (state.dsoObjects !== prevDsoObjects) {
          prevDsoObjects = state.dsoObjects;
          this.dsoRenderer.init(state.dsoObjects, this.catalogData.length);
          this.gpuPicker?.addDsoGeometry(this.dsoRenderer.geometry, state.dsoObjects.length);
          this.syncDsoWorkerIds(state.dsoObjects.map((dso) => dso.dsoId));
          if (state.showOrbitTrail) {
            this.refreshOrbitTrail(state);
          }
        }
      });
      let prevDsoEphemeris = useStore.getState().dsoEphemerisById;
      this.dsoEphemerisUnsub = useStore.subscribe((state) => {
        if (state.dsoEphemerisById !== prevDsoEphemeris) {
          this.syncDsoWorkerEphemerisDiff(prevDsoEphemeris, state.dsoEphemerisById);
          prevDsoEphemeris = state.dsoEphemerisById;
          if (state.showOrbitTrail && state.selectedDso) {
            this.requestDsoTrail(state.selectedDso.dsoId);
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
          prevCatFilters = state.categoryFilters;
          prevRegFilters = state.regimeFilters;
          prevVisMode = state.visibilityMode;
          prevObsLoc = state.observerLocation;

          let observerPos: THREE.Vector3 | null = null;
          if (state.visibilityMode !== 'all' && state.observerLocation) {
             observerPos = getObserverScenePosition(
               state.observerLocation.lat,
               state.observerLocation.lon,
               state.observerLocation.alt,
               new Date()
             );
          }
          const sunDir = getSunDirection(new Date());

          const counts = this.satelliteRenderer.applyFilters(
            this.catalogData,
            state.categoryFilters,
            state.regimeFilters,
            observerPos,
            sunDir,
            state.visibilityMode,
            this.visualNoradIds
          );
          useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

          if (obsLocChanged) {
            this.updateObserverMarker(state.observerLocation);
          }

          const sel = useStore.getState().selectedIndex;
          if (sel !== null && sel < this.catalogData.length) {
            const sizeArr = this.satelliteRenderer.mesh.geometry.getAttribute('size').array as Float32Array;
            if (sizeArr[sel] < 0.01) {
              useStore.getState().setSelectedSatellite(null, null);
            }
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

      this.worker = new Worker(
        new URL('../workers/sgp4.worker.ts', import.meta.url),
        { type: 'module' },
      );

      this.worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
        const msg = e.data;
        if (msg.type === 'READY') {
          this.objectCount = msg.objectCount;
          console.log(`SGP4 worker ready: ${this.objectCount} objects`);
          useStore.getState().setLoadingPhase('propagating');
          this.worker!.postMessage({ type: 'PROPAGATE', timestamp: Date.now() });
          this.propagationInterval = setInterval(() => {
            this.worker!.postMessage({ type: 'PROPAGATE', timestamp: Date.now() });
          }, 1000);
        } else if (msg.type === 'POSITIONS') {
          const state = useStore.getState();
          let observerPos: THREE.Vector3 | null = null;
          if (state.visibilityMode !== 'all' && state.observerLocation) {
             observerPos = getObserverScenePosition(
               state.observerLocation.lat,
               state.observerLocation.lon,
               state.observerLocation.alt,
               new Date()
             );
          }
          const sunDir = getSunDirection(new Date());

          const counts = this.satelliteRenderer.updatePositions(
            msg.positions,
            msg.validFlags,
            this.objectCount,
            observerPos,
            sunDir,
            state.visibilityMode,
            this.catalogData,
            state.categoryFilters,
            state.regimeFilters,
            this.visualNoradIds
          );

          useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

          this.lastTickTime = performance.now();
          this.satelliteRenderer.material.uniforms.uT.value = 0.0;

          this.devValidation?.runChecks(msg.positions, msg.validFlags, this.objectCount);

          if (!this.firstPositionReceived) {
            this.firstPositionReceived = true;
            useStore.getState().setLoadingPhase('ready');
          }
        }
      };

      this.worker.postMessage({ type: 'INIT', tles, startIndex: 0 });
    } catch (err) {
      console.error('Failed to initialize SGP4 worker:', err);
      useStore.getState().setLoadingError(
        err instanceof Error ? err.message : 'Failed to load satellite data',
      );
    }
  }

  private initDsoWorker(): void {
    this.dsoWorker?.terminate();
    this.dsoWorkerTickInFlight = false;
    this.dsoWorkerLastTickSentAt = 0;
    this.dsoWorkerKnownIds.clear();
    this.dsoWorkerKnownSnapshotVersions.clear();

    this.dsoWorker = new Worker(
      new URL('../workers/dso.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.dsoWorker.onmessage = (event: MessageEvent<DsoWorkerOutMessage>) => {
      const msg = event.data;
      if (msg.type === 'POSITIONS') {
        this.dsoWorkerTickInFlight = false;
        this.dsoWorkerLastTickSentAt = 0;
        this.dsoRenderer.updateFromWorkerBuffers(msg.positions, msg.visibleFlags);
        return;
      }

      const state = useStore.getState();
      if (!state.showOrbitTrail || state.selectedDso?.dsoId !== msg.dsoId) {
        return;
      }
      this.orbitTrailRenderer.generateFromPositions(msg.positions);
    };

    this.dsoWorker.onerror = (event) => {
      console.error('DSO worker error:', event);
      this.dsoWorkerTickInFlight = false;
      this.scheduleDsoWorkerRestart();
    };

    this.dsoWorker.onmessageerror = (event) => {
      console.error('DSO worker message error:', event);
      this.dsoWorkerTickInFlight = false;
      this.scheduleDsoWorkerRestart();
    };

    this.bootstrapDsoWorkerState();
  }

  private scheduleDsoWorkerRestart(): void {
    if (this.dsoWorkerRestartTimer !== null) {
      return;
    }

    this.dsoWorkerRestartTimer = setTimeout(() => {
      this.dsoWorkerRestartTimer = null;
      this.initDsoWorker();
    }, DSO_WORKER_RESTART_DELAY_MS);
  }

  private bootstrapDsoWorkerState(): void {
    if (!this.dsoWorker) {
      return;
    }

    const state = useStore.getState();
    const dsoIds = state.dsoObjects.map((dso) => dso.dsoId);
    this.dsoWorker.postMessage({
      type: 'INIT_SNAPSHOTS',
      dsoIds,
      snapshots: state.dsoEphemerisById,
      validToGraceSec: DSO_VALID_TO_GRACE_SEC,
    } satisfies DsoWorkerInMessage);
    this.dsoWorker.postMessage({
      type: 'SET_VALID_TO_GRACE_SEC',
      validToGraceSec: DSO_VALID_TO_GRACE_SEC,
    } satisfies DsoWorkerInMessage);

    this.dsoWorkerKnownIds = new Set(dsoIds);
    this.dsoWorkerKnownSnapshotVersions.clear();
    for (const [dsoId, snapshot] of Object.entries(state.dsoEphemerisById)) {
      this.dsoWorkerKnownSnapshotVersions.set(dsoId, snapshot.snapshotVersion);
    }
  }

  private syncDsoWorkerIds(nextIds: string[]): void {
    if (!this.dsoWorker) {
      return;
    }

    const sameSize = this.dsoWorkerKnownIds.size === nextIds.length;
    const sameMembers = sameSize && nextIds.every((id) => this.dsoWorkerKnownIds.has(id));
    if (!sameMembers) {
      this.dsoWorker.postMessage({
        type: 'SET_DSO_IDS',
        dsoIds: nextIds,
      } satisfies DsoWorkerInMessage);
      this.dsoWorkerKnownIds = new Set(nextIds);
    }

    for (const knownId of Array.from(this.dsoWorkerKnownSnapshotVersions.keys())) {
      if (!this.dsoWorkerKnownIds.has(knownId)) {
        this.dsoWorkerKnownSnapshotVersions.delete(knownId);
      }
    }
  }

  private syncDsoWorkerEphemerisDiff(
    prev: Record<string, DsoSnapshot>,
    next: Record<string, DsoSnapshot>,
  ): void {
    if (!this.dsoWorker) {
      return;
    }

    const touchedIds = new Set<string>([
      ...Object.keys(prev),
      ...Object.keys(next),
    ]);

    for (const dsoId of touchedIds) {
      const prevSnapshot = prev[dsoId];
      const nextSnapshot = next[dsoId];
      const prevVersion = prevSnapshot?.snapshotVersion ?? null;
      const nextVersion = nextSnapshot?.snapshotVersion ?? null;

      if (prevVersion === nextVersion) {
        continue;
      }

      this.dsoWorker.postMessage({
        type: 'UPDATE_SNAPSHOT',
        dsoId,
        snapshot: nextSnapshot ?? null,
      } satisfies DsoWorkerInMessage);

      if (nextSnapshot) {
        this.dsoWorkerKnownSnapshotVersions.set(dsoId, nextSnapshot.snapshotVersion);
      } else {
        this.dsoWorkerKnownSnapshotVersions.delete(dsoId);
      }
    }
  }

  private requestDsoTrail(dsoId: string): void {
    if (!this.dsoWorker) {
      this.orbitTrailRenderer.clear();
      return;
    }

    this.dsoWorker.postMessage({
      type: 'BUILD_TRAIL',
      dsoId,
      pointCount: DSO_TRAIL_POINTS,
    } satisfies DsoWorkerInMessage);
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
      this.orbitTrailRenderer.generate(sat.line1, sat.line2);
      return;
    }

    if (state.selectedDso) {
      this.requestDsoTrail(state.selectedDso.dsoId);
      return;
    }

    this.orbitTrailRenderer.clear();
  }

  start(): void {
    this.clock.start();
    this.loop();
  }

  private loop = (): void => {
    this.animationId = requestAnimationFrame(this.loop);
    const delta = this.clock.getDelta();
    const now = new Date();

    const sunDir = getSunDirection(now);
    this.earthRenderer.sunDirection.copy(sunDir);
    this.earthRenderer.object.rotation.y = getGAST(now);

    // GPU-side interpolation factor for TLE positions
    let uT = 0.0;
    if (this.lastTickTime > 0) {
      const elapsed = performance.now() - this.lastTickTime;
      uT = Math.min(elapsed / 1000.0, 1.0);
      this.satelliteRenderer.material.uniforms.uT.value = uT;
    }

    this.devValidation?.tickFrame();

    // ── DSO position update (worker-driven) ───────────────────────────────────
    const store = useStore.getState();
    if (
      this.dsoWorker &&
      this.dsoWorkerTickInFlight &&
      performance.now() - this.dsoWorkerLastTickSentAt > DSO_WORKER_STALL_TIMEOUT_MS
    ) {
      console.warn('DSO worker tick timed out; restarting worker');
      this.dsoWorkerTickInFlight = false;
      this.scheduleDsoWorkerRestart();
    }
    if (this.dsoWorker && !this.dsoWorkerTickInFlight) {
      this.dsoWorker.postMessage({
        type: 'TICK',
        timestamp: Date.now(),
      } satisfies DsoWorkerInMessage);
      this.dsoWorkerTickInFlight = true;
      this.dsoWorkerLastTickSentAt = performance.now();
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
    const selectedIdx = store.selectedIndex;
    const selectedDso = store.selectedDso;

    if (cameraMode === 'free') {
      this.controls.update();

    } else if (cameraMode === 'flying' && selectedIdx !== null) {
      // TLE fly-to
      const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
      const radialDir = satPos.clone().normalize();
      const endCamPos = satPos.clone().add(
        radialDir.multiplyScalar(this.cameraController.followOffsetDist),
      );
      const done = this.cameraController.updateAnim(endCamPos, satPos, this.controls.target);
      if (done) {
        store.setCameraMode('following');
        this.arrivalTime = performance.now();
      }

    } else if (cameraMode === 'flying' && selectedDso !== null) {
      // DSO fly-to
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (dsoIndex >= 0 && this.dsoRenderer.isVisible(dsoIndex)) {
        const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
        const radialDir = dsoPos.clone().normalize();
        const endCamPos = dsoPos.clone().add(
          radialDir.multiplyScalar(this.cameraController.followOffsetDist),
        );
        const done = this.cameraController.updateAnim(endCamPos, dsoPos, this.controls.target);
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
      this.cameraController.updateFollow(satPos, this.controls.target);

    } else if (cameraMode === 'following' && selectedDso !== null) {
      // DSO follow
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (dsoIndex >= 0 && this.dsoRenderer.isVisible(dsoIndex)) {
        const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
        this.cameraController.updateFollow(dsoPos, this.controls.target);
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
    this.renderer.render(this.scene, this.camera);
  };

  private syncPickerUniforms(): void {
    if (!this.gpuPicker) return;
    this.gpuPicker.syncUniforms(
      this.satelliteRenderer.material.uniforms.uT.value,
      this.satelliteRenderer.material.uniforms.uCameraDistance.value,
      this.satelliteRenderer.material.uniforms.uPixelRatio.value,
    );
  }

  private onPointerMove = (e: PointerEvent): void => {
    const mode = useStore.getState().cameraMode;
    if (this.pointerDownPos && mode !== 'free') {
      const dx = e.clientX - this.pointerDownPos.x;
      const dy = e.clientY - this.pointerDownPos.y;
      if (dx * dx + dy * dy > 25) {
        if (mode === 'following') {
          this.dragExitedFollowing = true;
          const selectedIdx = useStore.getState().selectedIndex;
          if (selectedIdx !== null) {
            const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
            const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
            this.controls.target.copy(satPos);
          } else {
            // Following a DSO — aim controls at DSO position
            const dso = useStore.getState().selectedDso;
            const dsoObjects = useStore.getState().dsoObjects;
            if (dso) {
              const dsoIndex = dsoObjects.findIndex((d) => d.dsoId === dso.dsoId);
              if (dsoIndex >= 0) {
                this.controls.target.copy(this.dsoRenderer.getPositionAt(dsoIndex));
              }
            }
          }
          this.controls.enabled = true;
        }
        useStore.getState().setCameraMode('free');
        this.pointerDownPos = null;
      }
    }

    const now = performance.now();
    if (now - this.lastHoverTime < Engine.HOVER_THROTTLE_MS) return;
    this.lastHoverTime = now;

    if (!this.gpuPicker || !this.firstPositionReceived) return;

    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    this.syncPickerUniforms();
    const index = this.gpuPicker.pickSingle(screenX, screenY, rect.width, rect.height);

    if (index !== null && index < this.catalogData.length) {
      // TLE hover
      canvas.style.cursor = 'pointer';
      useStore.getState().setHover(this.catalogData[index].name, e.clientX, e.clientY);
    } else if (index !== null && index >= this.catalogData.length) {
      // DSO hover
      const dsoIndex = index - this.catalogData.length;
      const dsoObjects = useStore.getState().dsoObjects;
      if (dsoIndex < dsoObjects.length) {
        canvas.style.cursor = 'pointer';
        useStore.getState().setHover(dsoObjects[dsoIndex].name, e.clientX, e.clientY);
      }
    } else {
      canvas.style.cursor = '';
      useStore.getState().setHover(null);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointerDownPos || !this.gpuPicker) return;

    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    if (dx * dx + dy * dy > 25) return;

    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    this.syncPickerUniforms();
    const gpuHits = this.gpuPicker.pickArea(screenX, screenY, rect.width, rect.height);
    const store = useStore.getState();

    if (gpuHits.length === 0) {
      store.setSelectedSatellite(null, null);
      store.setSelectedDso(null);
      store.clearCluster();
      return;
    }

    // pickArea sorts by visual size descending; DSOs use a constant 5.0 which
    // beats any normal TLE, so gpuHits[0] is a DSO whenever one was directly
    // clicked — even if stray TLE pixels bleed into the 5×5 sample area.
    if (gpuHits[0] >= this.catalogData.length) {
      const dsoIndex = gpuHits[0] - this.catalogData.length;
      if (dsoIndex < store.dsoObjects.length) {
        store.clearCluster();
        this.selectDsoByIndex(dsoIndex);
      }
      return;
    }

    // TLE hit path — existing cluster logic
    const tleHits = gpuHits.filter((i) => i < this.catalogData.length);
    const geom = this.satelliteRenderer.mesh.geometry;
    const posArr = geom.getAttribute('currentPosition') as THREE.BufferAttribute;
    const sizeArr = geom.getAttribute('size') as THREE.BufferAttribute;
    const anchorIdx = tleHits[0];
    const wx = posArr.getX(anchorIdx);
    const wy = posArr.getY(anchorIdx);
    const wz = posArr.getZ(anchorIdx);

    const clusterSet = new Set<number>(tleHits);
    const count = this.catalogData.length;
    for (let i = 0; i < count; i++) {
      if (sizeArr.getX(i) < 0.01) continue;
      const px = posArr.getX(i) - wx;
      const py = posArr.getY(i) - wy;
      const pz = posArr.getZ(i) - wz;
      if (px * px + py * py + pz * pz < CLUSTER_RADIUS_SQ) {
        clusterSet.add(i);
      }
    }

    const allIndices = Array.from(clusterSet);
    allIndices.sort((a, b) => sizeArr.getX(b) - sizeArr.getX(a));

    if (allIndices.length === 1) {
      store.clearCluster();
      this.selectByIndex(allIndices[0]);
      return;
    }

    const items = allIndices.map((i) => {
      const px = posArr.getX(i);
      const py = posArr.getY(i);
      const pz = posArr.getZ(i);
      const mag = Math.sqrt(px * px + py * py + pz * pz);
      const alt = Math.round((mag * EARTH_RADIUS_KM) - EARTH_RADIUS_KM);
      return { index: i, data: this.catalogData[i], altitude: alt };
    });
    store.setCluster(items, e.clientX, e.clientY);
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

  flyToSatellite(index: number): void {
    if (index < 0 || index >= this.catalogData.length || !this.firstPositionReceived) return;

    const store = useStore.getState();
    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedIndex === index) return;

    if (store.selectedIndex !== index) {
      this.selectByIndex(index);
    }

    const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
    const satPos = this.satelliteRenderer.getInterpolatedPosition(index, uT);

    this.arrivalTime = -1;
    this.cameraController.flyTo(satPos, this.controls.target);
    store.setCameraMode('flying');
  }

  flyToDso(dsoId: string): void {
    const store = useStore.getState();
    const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === dsoId);
    if (dsoIndex < 0 || !this.dsoRenderer.isVisible(dsoIndex)) return;

    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedDso?.dsoId === dsoId) return;

    if (store.selectedDso?.dsoId !== dsoId) {
      store.setSelectedDso(store.dsoObjects[dsoIndex]);
    }

    const dsoPos = this.dsoRenderer.getPositionAt(dsoIndex);
    this.arrivalTime = -1;
    this.cameraController.flyTo(dsoPos, this.controls.target);
    store.setCameraMode('flying');
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
        const geo = new THREE.SphereGeometry(0.03, 16, 16);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x00e5ff,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        });
        this.observerMarker = new THREE.Mesh(geo, mat);
        this.observerMarker.renderOrder = 1;
        this.earthRenderer.object.add(this.observerMarker);
      }
      this.observerMarker.position.copy(getObserverECEFPosition(loc.lat, loc.lon));
    } else if (this.observerMarker) {
      this.earthRenderer.object.remove(this.observerMarker);
      this.observerMarker.geometry.dispose();
      (this.observerMarker.material as THREE.Material).dispose();
      this.observerMarker = null;
    }
  }

  private onControlsStart = (): void => {
    // no-op
  };

  private onResize = (): void => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  dispose(): void {
    stopDsoClient();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.propagationInterval !== null) {
      clearInterval(this.propagationInterval);
    }
    this.controls.removeEventListener('start', this.onControlsStart);
    this.cameraModeUnsub?.();
    this.filterUnsub?.();
    this.trailUnsub?.();
    this.dsoUnsub?.();
    this.dsoEphemerisUnsub?.();
    this.worker?.terminate();
    this.dsoWorker?.terminate();
    this.dsoWorkerTickInFlight = false;
    this.dsoWorkerLastTickSentAt = 0;
    this.dsoWorkerKnownIds.clear();
    this.dsoWorkerKnownSnapshotVersions.clear();
    if (this.dsoWorkerRestartTimer !== null) {
      clearTimeout(this.dsoWorkerRestartTimer);
      this.dsoWorkerRestartTimer = null;
    }
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.onResize);
    if (this.observerMarker) {
      this.earthRenderer.object.remove(this.observerMarker);
      this.observerMarker.geometry.dispose();
      (this.observerMarker.material as THREE.Material).dispose();
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
