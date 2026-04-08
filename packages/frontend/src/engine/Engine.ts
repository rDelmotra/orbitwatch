import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EarthRenderer } from './EarthRenderer';
import { StarfieldRenderer } from './StarfieldRenderer';
import { DeepSpaceRenderer } from './DeepSpaceRenderer';
import { getSunDirection, getGAST } from '../orbital/time';
import { getObserverScenePosition, getObserverECEFPosition } from '../orbital/coordinates';
import { fetchVisualNoradIds } from '../data/visualList';
import { SatelliteRenderer } from './SatelliteRenderer';
import type { TLEInput, EnrichedTLEObject, WorkerOutMessage, ObjectCategory, OrbitalRegime, DeepSpaceObject, HorizonsEphemerisPoint, DSOApiResponse } from '../data/types';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { OrbitTrailRenderer } from './OrbitTrailRenderer';
import { CameraController, HOME_POSITION, HOME_TARGET } from './CameraController';
import { DevValidation } from './DevValidation';

const EARTH_RADIUS_KM = 6371;
const CLUSTER_RADIUS_SQ = 0.0078 * 0.0078; // ~50 km in scene units, squared

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
  private worker: Worker | null = null;
  private propagationInterval: ReturnType<typeof setInterval> | null = null;
  private objectCount = 0;
  private lastTickTime = 0;
  private firstPositionReceived = false;
  private gpuPicker: GPUPicker | null = null;
  private catalogData: EnrichedTLEObject[] = [];
  private dsoData: DeepSpaceObject[] = [];
  private dsoEphemeris: Record<string, HorizonsEphemerisPoint[]> = {};
  private deepSpaceRenderer: DeepSpaceRenderer;
  private followingDSO = false;
  private pointerDownPos: { x: number; y: number } | null = null;
  private lastHoverTime = 0;
  private static readonly HOVER_THROTTLE_MS = 100;
  private orbitTrailRenderer: OrbitTrailRenderer;
  private cameraController: CameraController;
  private arrivalTime = -1; // performance.now() when camera arrived; -1 = none
  private cameraModeUnsub: (() => void) | null = null;
  private trailUnsub: (() => void) | null = null;
  private filterUnsub: (() => void) | null = null;
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
    this.controls.maxDistance = 100;
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

    // ── Orbit trail ─────────────────────────────────────────────────────────
    this.orbitTrailRenderer = new OrbitTrailRenderer(this.scene);

    // ── Deep-space renderer ───────────────────────────────────────────────
    this.deepSpaceRenderer = new DeepSpaceRenderer(this.scene);

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
        this.followingDSO = false;

        // Context-aware controls.target on transition to free
        if (this.dragExitedFollowing) {
          // target already set to satellite pos in onControlsStart, keep it
          // reset the flag for next time
          this.dragExitedFollowing = false;
        } else if (this.returnEndPos) {
          // finished returning animation, aim at Earth
          this.controls.target.set(0, 0, 0);
          this.returnEndPos = null;
        }
      }

      // Entering 'returning': disable controls and start return animation
      if (state.cameraMode === 'returning') {
        this.cameraController.cancel();
        this.controls.enabled = false;
        this.arrivalTime = -1;

        // Both contextual and hard reset need the start timer initialized
        this.cameraController.returnToHome(this.controls.target);

        if (this.useHardReset) {
          this.returnEndPos = HOME_POSITION.clone();
          this.returnEndTarget.copy(HOME_TARGET);
          this.useHardReset = false; // reset flag
        } else {
          // Contextual pullback
          const dir = this.camera.position.clone().normalize();
          const currentDistance = this.camera.position.length();
          const targetDist = Math.max(currentDistance, HOME_POSITION.length());
          this.returnEndPos = dir.multiplyScalar(targetDist);
          this.returnEndTarget.set(0, 0, 0);
        }
      }

      // Entering 'flying': controls disabled (Engine.flyToSatellite starts animation)
      if (state.cameraMode === 'flying') {
        this.controls.enabled = false;
      }

      // Entering 'following': controls disabled so OrbitControls doesn't fire
      // 'start' on clicks. Drag exit is handled in onPointerMove instead.
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
      const [res, dsoRes, visualIds] = await Promise.all([
        fetch(`${apiUrl}/api/tle/all`),
        fetch(`${apiUrl}/api/dso/all`),
        fetchVisualNoradIds(),
      ]);
      this.visualNoradIds = visualIds;
      if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);

      // DSO data is non-fatal: log a warning but continue if unavailable.
      if (dsoRes.ok) {
        const dsoResponse: DSOApiResponse = await dsoRes.json();
        this.dsoData = dsoResponse.objects;
        this.dsoEphemeris = dsoResponse.ephemeris;
        console.log(`Loaded ${this.dsoData.length} DSO(s), ephemeris for: [${Object.keys(this.dsoEphemeris).join(', ')}]`);

        this.deepSpaceRenderer.initFromCatalog(this.dsoData);
        useStore.getState().setDSOData(this.dsoData);
        useStore.getState().setSelectDSOByIndex((i) => this.selectDSOByIndex(i));
        useStore.getState().setTriggerFlyToDSO((i) => this.flyToDSO(i));
      } else {
        console.warn(`DSO fetch failed (${dsoRes.status}) — deep-space objects unavailable`);
      }

      const response = await res.json();
      const catalogData: EnrichedTLEObject[] = response.data;
      const tles: TLEInput[] = catalogData.map((d) => ({
        noradId: d.noradId,
        line1: d.line1,
        line2: d.line2,
      }));

      // Compute category counts for the UI legend
      const categoryCounts: Record<ObjectCategory, number> = {
        active_satellite: 0,
        inactive_satellite: 0,
        rocket_body: 0,
        debris: 0,
        unknown: 0,
        deep_space: 0,
      };
      const regimeCounts: Record<OrbitalRegime, number> = {
        LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0, LUNAR: 0,
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

      // Retain catalog for index lookup after pick
      this.catalogData = catalogData;

      // Expose catalog data and selectByIndex to the UI via the store
      useStore.getState().setCatalogData(catalogData);
      useStore.getState().setSelectByIndex((index: number) => this.selectByIndex(index));
      useStore.getState().setTriggerFlyTo((index: number) => this.flyToSatellite(index));
      useStore.getState().setTriggerResetCamera(() => this.resetCamera());

      // Initialize per-vertex colors (by category) and pick IDs
      this.satelliteRenderer.initFromCatalog(catalogData);

      // Create GPU picker (shares geometry with satellite renderer)
      this.gpuPicker = new GPUPicker(
        this.renderer,
        this.camera,
        this.satelliteRenderer,
        catalogData.length,
      );

      // Dev validation harness
      if (import.meta.env.DEV) {
        this.devValidation = new DevValidation();
        this.devValidation.initFromCatalog(catalogData);
      }

      // Highlight the ISS: bright green, slightly larger but not overwhelming
      const issIndex = catalogData.findIndex((d) => d.noradId === 25544);
      if (issIndex !== -1) {
        this.satelliteRenderer.setSatelliteColor(issIndex, 0.2, 1.0, 0.4);
        this.satelliteRenderer.setSatelliteSize(issIndex, 2.0);
      }

      // Subscribe to filter changes from the UI
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

          // Update observer marker when location changes
          if (obsLocChanged) {
            this.updateObserverMarker(state.observerLocation);
          }

          // Clear selection if filtered out
          const sel = useStore.getState().selectedIndex;
          if (sel !== null && sel < this.catalogData.length) {
            const sizeArr = this.satelliteRenderer.mesh.geometry.getAttribute('size').array as Float32Array;
            if (sizeArr[sel] < 0.01) {
              useStore.getState().setSelectedSatellite(null, null);
            }
          }
        }
      });

      // Subscribe to orbit trail toggle
      let prevShowTrail = useStore.getState().showOrbitTrail;
      this.trailUnsub = useStore.subscribe((state) => {
        if (state.showOrbitTrail !== prevShowTrail) {
          prevShowTrail = state.showOrbitTrail;
          if (state.showOrbitTrail) {
            if (state.selectedDSOIndex !== null) {
              // DSO trail: use ephemeris points directly
              const dso = this.dsoData[state.selectedDSOIndex];
              if (dso) {
                const pts = this.dsoEphemeris[dso.horizonsId] ?? [];
                this.orbitTrailRenderer.generateFromEphemeris(pts);
              }
            } else {
              const idx = state.selectedIndex;
              if (idx !== null && idx >= 0 && idx < this.catalogData.length) {
                const sat = this.catalogData[idx];
                this.orbitTrailRenderer.generate(sat.line1, sat.line2);
              }
            }
          } else {
            this.orbitTrailRenderer.clear();
          }
        }
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
          // Trigger first propagation immediately, then every 1s
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

          // Dev validation: run checks on raw ECI positions
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

  start(): void {
    this.clock.start();
    this.loop();
  }

  private loop = (): void => {
    this.animationId = requestAnimationFrame(this.loop);
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();
    const now = new Date();

    // Sun direction in ECI frame — no rotation needed since the scene is inertial.
    // Earth mesh rotates by GAST so its texture aligns with real geography.
    const sunDir = getSunDirection(now);
    this.earthRenderer.sunDirection.copy(sunDir);
    this.earthRenderer.object.rotation.y = getGAST(now);

    // GPU-side interpolation: compute t from time since last propagation tick
    let uT = 0.0;
    if (this.lastTickTime > 0) {
      const elapsed = performance.now() - this.lastTickTime;
      uT = Math.min(elapsed / 1000.0, 1.0);
      this.satelliteRenderer.material.uniforms.uT.value = uT;
    }

    // ── Deep-space renderer update ────────────────────────────────────────
    this.deepSpaceRenderer.update(Date.now(), this.dsoEphemeris, elapsed);

    this.devValidation?.tickFrame();

    // ── Camera mode handling ────────────────────────────────────────────────
    // CRITICAL: controls.update() only runs in 'free' mode. In all other modes
    // the CameraController directly sets camera.position and lookAt, and we keep
    // controls.target synced so OrbitControls can resume cleanly on exit.
    const store = useStore.getState();
    const cameraMode = store.cameraMode;
    const selectedIdx = store.selectedIndex;

    if (cameraMode === 'free') {
      this.controls.update();

    } else if (cameraMode === 'flying') {
      if (this.followingDSO) {
        const dsoIdx = store.selectedDSOIndex;
        if (dsoIdx !== null) {
          const dsoPos = this.deepSpaceRenderer.getPosition(dsoIdx) ?? new THREE.Vector3();
          const radialDir = dsoPos.clone().normalize();
          const endCamPos = dsoPos.clone().add(
            radialDir.multiplyScalar(this.cameraController.followOffsetDist),
          );
          const done = this.cameraController.updateAnim(endCamPos, dsoPos, this.controls.target);
          if (done) {
            store.setCameraMode('following');
            this.arrivalTime = performance.now();
          }
        }
      } else if (selectedIdx !== null) {
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
      }

    } else if (cameraMode === 'following') {
      if (this.followingDSO) {
        const dsoIdx = store.selectedDSOIndex;
        if (dsoIdx !== null) {
          const dsoPos = this.deepSpaceRenderer.getPosition(dsoIdx) ?? new THREE.Vector3();
          this.cameraController.updateFollow(dsoPos, this.controls.target);
        }
      } else if (selectedIdx !== null) {
        const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
        this.cameraController.updateFollow(satPos, this.controls.target);
      }

    } else if (cameraMode === 'returning') {
      const done = this.cameraController.updateAnim(
        this.returnEndPos || HOME_POSITION, this.returnEndTarget, this.controls.target,
      );
      if (done) {
        store.setCameraMode('free');
      }
    }

    // ── Selected-object shader uniforms ──────────────────────────────────────
    const timeSinceArrival = this.arrivalTime > 0
      ? (performance.now() - this.arrivalTime) / 1000
      : -1.0;
    this.satelliteRenderer.updateSelectedUniforms(
      selectedIdx !== null ? selectedIdx : -1,
      timeSinceArrival,
    );

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
    // Drag detection for all non-free modes (controls are disabled in these modes).
    const mode = useStore.getState().cameraMode;
    if (this.pointerDownPos && mode !== 'free') {
      const dx = e.clientX - this.pointerDownPos.x;
      const dy = e.clientY - this.pointerDownPos.y;
      if (dx * dx + dy * dy > 25) {
        if (mode === 'following') {
          // User is dragging while following — exit to free orbit around satellite
          this.dragExitedFollowing = true;
          const selectedIdx = useStore.getState().selectedIndex;
          if (selectedIdx !== null) {
            const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
            const satPos = this.satelliteRenderer.getInterpolatedPosition(selectedIdx, uT);
            this.controls.target.copy(satPos);
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

    // Check DSO hover first (screen-space proximity — DSOs not in GPU picker)
    const dsoHover = this.pickDSO(screenX, screenY, rect.width, rect.height);
    if (dsoHover !== null) {
      canvas.style.cursor = 'pointer';
      useStore.getState().setHover(this.dsoData[dsoHover].name, e.clientX, e.clientY);
      return;
    }

    this.syncPickerUniforms();
    const index = this.gpuPicker.pickSingle(screenX, screenY, rect.width, rect.height);

    if (index !== null && index < this.catalogData.length) {
      canvas.style.cursor = 'pointer';
      useStore.getState().setHover(this.catalogData[index].name, e.clientX, e.clientY);
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

    // Ignore drags: only pick if pointer moved less than 5px
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    if (dx * dx + dy * dy > 25) return;

    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // DSO picking: screen-space proximity check (DSOs not in GPU picker)
    const dsoIndex = this.pickDSO(screenX, screenY, rect.width, rect.height);
    if (dsoIndex !== null) {
      this.selectDSOByIndex(dsoIndex);
      return;
    }

    this.syncPickerUniforms();
    const gpuHits = this.gpuPicker.pickArea(screenX, screenY, rect.width, rect.height);
    const store = useStore.getState();

    if (gpuHits.length === 0) {
      store.setSelectedSatellite(null, null);
      store.clearCluster();
      return;
    }

    // Use the first GPU hit as the anchor for CPU proximity search
    const geom = this.satelliteRenderer.mesh.geometry;
    const posArr = geom.getAttribute('currentPosition') as THREE.BufferAttribute;
    const sizeArr = geom.getAttribute('size') as THREE.BufferAttribute;
    const anchorIdx = gpuHits[0];
    const wx = posArr.getX(anchorIdx);
    const wy = posArr.getY(anchorIdx);
    const wz = posArr.getZ(anchorIdx);

    // CPU search: find all satellites within ~50km of the anchor
    const clusterSet = new Set<number>(gpuHits);
    const count = this.catalogData.length;
    for (let i = 0; i < count; i++) {
      if (sizeArr.getX(i) < 0.01) continue; // skip hidden/invalid
      const px = posArr.getX(i) - wx;
      const py = posArr.getY(i) - wy;
      const pz = posArr.getZ(i) - wz;
      if (px * px + py * py + pz * pz < CLUSTER_RADIUS_SQ) {
        clusterSet.add(i);
      }
    }

    // Sort by size descending (most visually prominent first)
    const allIndices = Array.from(clusterSet);
    allIndices.sort((a, b) => sizeArr.getX(b) - sizeArr.getX(a));

    if (allIndices.length === 1) {
      store.clearCluster();
      this.selectByIndex(allIndices[0]);
      return;
    }

    // Multiple objects — show disambiguation popup
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

    // Auto-redirect fly-to on satellite change — start animation directly
    // (can't use flyToSatellite because its guard would bail after selectedIndex is updated)
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

    // Clicking a different object while returning exits camera tracking
    if (store.cameraMode !== 'free' && store.selectedIndex !== index) {
      store.setCameraMode('free');
    }

    this.deepSpaceRenderer.clearSelection();
    this.followingDSO = false;
    store.setSelectedSatellite(index, this.catalogData[index], Math.round(altitudeKm));
  }

  // ── Deep-space methods ──────────────────────────────────────────────────────

  /**
   * Screen-space proximity pick for DSOs (not in GPU picker — too few to warrant it).
   * Returns the DSO index if the pointer is within 20px of a projected DSO position.
   */
  private pickDSO(screenX: number, screenY: number, canvasW: number, canvasH: number): number | null {
    if (this.dsoData.length === 0) return null;
    const RADIUS_SQ = 20 * 20;
    for (let i = 0; i < this.dsoData.length; i++) {
      const worldPos = this.deepSpaceRenderer.getPosition(i);
      if (!worldPos) continue;
      const projected = worldPos.clone().project(this.camera);
      if (projected.z > 1) continue; // behind camera
      const sx = (projected.x + 1) * 0.5 * canvasW;
      const sy = (1 - projected.y) * 0.5 * canvasH;
      const dx = screenX - sx;
      const dy = screenY - sy;
      if (dx * dx + dy * dy < RADIUS_SQ) return i;
    }
    return null;
  }

  selectDSOByIndex(index: number): void {
    if (index < 0 || index >= this.dsoData.length) return;
    const store = useStore.getState();

    // Exit 'returning' if user picks a new DSO mid-return. Don't force 'free' from
    // 'flying'/'following' — callers like flyToDSO set the correct mode immediately after.
    if (store.cameraMode === 'returning') store.setCameraMode('free');

    const dso = this.dsoData[index];
    const worldPos = this.deepSpaceRenderer.getPosition(index);
    const altitudeKm = worldPos
      ? Math.round(worldPos.length() * EARTH_RADIUS_KM - EARTH_RADIUS_KM)
      : null;

    this.followingDSO = false;
    this.deepSpaceRenderer.setSelectedIndex(index);
    store.setSelectedDSO(index, dso, altitudeKm);
  }

  flyToDSO(index: number): void {
    if (index < 0 || index >= this.dsoData.length) return;
    const store = useStore.getState();

    // Already flying/following this DSO — no-op
    if (this.followingDSO
      && (store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedDSOIndex === index) return;

    if (store.selectedDSOIndex !== index) this.selectDSOByIndex(index);

    const dsoPos = this.deepSpaceRenderer.getPosition(index);
    if (!dsoPos) return;

    this.followingDSO = true;
    this.arrivalTime = -1;
    this.cameraController.flyTo(dsoPos, this.controls.target);
    store.setCameraMode('flying');
  }

  flyToSatellite(index: number): void {
    if (index < 0 || index >= this.catalogData.length || !this.firstPositionReceived) return;

    const store = useStore.getState();
    // Already flying/following this satellite — no-op
    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedIndex === index) return;

    // Ensure satellite is selected
    if (store.selectedIndex !== index) {
      this.selectByIndex(index);
    }

    const uT = this.satelliteRenderer.material.uniforms.uT.value as number;
    const satPos = this.satelliteRenderer.getInterpolatedPosition(index, uT);

    // Start fly animation — subscription handles controls.enabled
    this.arrivalTime = -1;
    this.cameraController.flyTo(satPos, this.controls.target);
    store.setCameraMode('flying');
  }

  resetCamera(): void {
    const store = useStore.getState();
    this.useHardReset = true;
    if (store.cameraMode !== 'returning') {
      store.setCameraMode('returning');
    } else {
      // Re-trigger if already returning (e.g. from a contextual deselect)
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

  /** OrbitControls 'start' event — reserved for future use.
   *  Drag exit from following is handled in onPointerMove (controls are disabled
   *  in following mode so this event won't fire during following). */
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
    this.worker?.terminate();
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
    this.deepSpaceRenderer.dispose();
    this.orbitTrailRenderer.dispose();
    this.satelliteRenderer.dispose();
    this.earthRenderer.dispose();
    this.starfieldRenderer.dispose();
    this.renderer.dispose();
  }
}
