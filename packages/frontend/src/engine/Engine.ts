import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EarthRenderer } from './EarthRenderer';
import { StarfieldRenderer } from './StarfieldRenderer';
import { getSunDirection, getGAST } from '../orbital/time';
import { SatelliteRenderer } from './SatelliteRenderer';
import type { TLEInput, EnrichedTLEObject, WorkerOutMessage, ObjectCategory, OrbitalRegime } from '../data/types';
import { useStore } from '../store/useStore';
import { GPUPicker } from './GPUPicker';
import { OrbitTrailRenderer } from './OrbitTrailRenderer';
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
  private pointerDownPos: { x: number; y: number } | null = null;
  private lastHoverTime = 0;
  private static readonly HOVER_THROTTLE_MS = 100;
  private orbitTrailRenderer: OrbitTrailRenderer;
  private trailUnsub: (() => void) | null = null;
  private filterUnsub: (() => void) | null = null;
  private devValidation: DevValidation | null = null;

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
      const res = await fetch(`${apiUrl}/api/tle/all`);
      if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);

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

      // Retain catalog for index lookup after pick
      this.catalogData = catalogData;

      // Expose catalog data and selectByIndex to the UI via the store
      useStore.getState().setCatalogData(catalogData);
      useStore.getState().setSelectByIndex((index: number) => this.selectByIndex(index));

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
      this.filterUnsub = useStore.subscribe((state) => {
        if (
          state.categoryFilters !== prevCatFilters ||
          state.regimeFilters !== prevRegFilters
        ) {
          prevCatFilters = state.categoryFilters;
          prevRegFilters = state.regimeFilters;
          const counts = this.satelliteRenderer.applyFilters(
            this.catalogData,
            state.categoryFilters,
            state.regimeFilters,
          );
          useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

          // Clear selection if filtered out
          const sel = useStore.getState().selectedIndex;
          if (sel !== null && sel < this.catalogData.length) {
            const obj = this.catalogData[sel];
            if (!state.categoryFilters[obj.category] || !state.regimeFilters[obj.regime]) {
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
            const idx = state.selectedIndex;
            if (idx !== null && idx >= 0 && idx < this.catalogData.length) {
              const sat = this.catalogData[idx];
              this.orbitTrailRenderer.generate(sat.line1, sat.line2);
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
          this.satelliteRenderer.updatePositions(
            msg.positions,
            msg.validFlags,
            this.objectCount,
          );
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
    const now = new Date();

    // Sun direction in ECI frame — no rotation needed since the scene is inertial.
    // Earth mesh rotates by GAST so its texture aligns with real geography.
    const sunDir = getSunDirection(now);
    this.earthRenderer.sunDirection.copy(sunDir);
    this.earthRenderer.object.rotation.y = getGAST(now);

    // GPU-side interpolation: compute t from time since last propagation tick
    if (this.lastTickTime > 0) {
      const elapsed = performance.now() - this.lastTickTime;
      this.satelliteRenderer.material.uniforms.uT.value = Math.min(elapsed / 1000.0, 1.0);
    }

    this.devValidation?.tickFrame();
    this.controls.update();
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

    useStore.getState().setSelectedSatellite(
      index,
      this.catalogData[index],
      Math.round(altitudeKm),
    );
  }

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
    this.filterUnsub?.();
    this.trailUnsub?.();
    this.worker?.terminate();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.onResize);
    this.gpuPicker?.dispose();
    this.orbitTrailRenderer.dispose();
    this.satelliteRenderer.dispose();
    this.earthRenderer.dispose();
    this.starfieldRenderer.dispose();
    this.renderer.dispose();
  }
}
