import type * as THREE from 'three';
import { SatelliteRenderer } from '../../SatelliteRenderer';
import { DevValidation } from '../../DevValidation';
import { Sgp4WorkerClient, type Sgp4PositionResult } from '../../tle/Sgp4WorkerClient';
import { getSunDirection } from '../../../orbital/time';
import { getObserverScenePosition } from '../../../orbital/coordinates';
import { simClock } from '../../SimClock';
import { useStore } from '../../../store/useStore';
import type { EnrichedTLEObject } from '../../../data/types';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

const EARTH_RADIUS_KM = 6371;

/**
 * Satellites: THE product layer. Owns the {@link SatelliteRenderer}, the
 * {@link Sgp4WorkerClient} (~1Hz propagation), the positions→visibility→render
 * pipeline, the visible-count recompute, dev validation, and the per-frame
 * uniforms. **Critical** (the only one): a throw at init/activate/update escalates
 * via `World.onCriticalError` → `store.setLoadingError` instead of failing soft.
 *
 * Two-phase like {@link DsoLayer}: `init(ctx)` builds the renderer synchronously
 * (so the Engine can feed InputManager + build the GPU picker in the same tick);
 * `activate(...)` primes geometry + starts the worker once the catalog has
 * bootstrapped. The Engine builds the GPU picker immediately AFTER `activate()`
 * returns — safe because the worker's first POSITIONS message is async (a later
 * task), so the picker is in place before any pick. Cross-cutting concerns
 * (loading phases, selection clears, trail refresh) flow back to the Engine via
 * callbacks — layers never import other layers.
 */
export class SatellitesLayer implements Layer {
  readonly name = 'satellites';
  readonly critical = true;

  private _renderer: SatelliteRenderer | null = null;
  private client: Sgp4WorkerClient | null = null;
  private catalog: EnrichedTLEObject[] = [];
  private devValidation: DevValidation | null = null;
  private firstPositionReceived = false;
  private callbacks: SatellitesLayerCallbacks | null = null;

  /**
   * The satellite renderer, or null if init hasn't run / failed. Nullable on
   * purpose: a critical init failure is escalated (error screen), not crashed —
   * the Engine guards its consumers (InputManager, GPU picker) on this.
   */
  get renderer(): SatelliteRenderer | null {
    return this._renderer;
  }

  /** True once the first SGP4 propagation has arrived (camera moves gate on this). */
  isReady(): boolean {
    return this.firstPositionReceived;
  }

  init(ctx: LayerContext): void {
    this._renderer = new SatelliteRenderer(ctx.scene);
    if (import.meta.env.DEV) {
      this.devValidation = new DevValidation();
    }
  }

  /**
   * Prime renderer geometry + start SGP4 propagation. Called by the Engine after
   * the TLE catalog bootstrap. `init` has already run, so `_renderer` is set.
   */
  activate(
    catalog: EnrichedTLEObject[],
    tles: ConstructorParameters<typeof Sgp4WorkerClient>[0],
    callbacks: SatellitesLayerCallbacks,
  ): void {
    if (!this._renderer) return;
    this.catalog = catalog;
    this.callbacks = callbacks;

    this._renderer.initFromCatalog(catalog);
    this.devValidation?.initFromCatalog(catalog);

    const issIndex = catalog.findIndex((d) => d.noradId === 25544);
    if (issIndex !== -1) {
      this._renderer.setSatelliteColor(issIndex, 0.2, 1.0, 0.4);
      this._renderer.setSatelliteSize(issIndex, 2.0);
    }

    this.client = new Sgp4WorkerClient(tles, {
      onReady: (objectCount) => callbacks.onReady(objectCount),
      onPositions: (result) => this.onPositions(result),
    });
  }

  private onPositions(result: Sgp4PositionResult): void {
    if (!this._renderer || !this.callbacks) return;

    const state = useStore.getState();
    const propagationDate = new Date(result.timestamp);
    const observerPos = this.getObserverScenePositionForState(state, propagationDate);
    const sunDir = getSunDirection(propagationDate);
    const visualNoradIds = this.callbacks.getVisualNoradIds();

    const counts = result.isSnap
      ? this._renderer.snapPositions(
          result.positions,
          result.validFlags,
          result.objectCount,
          observerPos,
          sunDir,
          state.visibilityMode,
          this.catalog,
          state.categoryFilters,
          state.regimeFilters,
          visualNoradIds,
        )
      : this._renderer.updatePositions(
          result.positions,
          result.validFlags,
          result.objectCount,
          observerPos,
          sunDir,
          state.visibilityMode,
          this.catalog,
          state.categoryFilters,
          state.regimeFilters,
          visualNoradIds,
        );

    useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

    this._renderer.material.uniforms.uT.value = 0.0;

    const post = useStore.getState();
    if (post.showOrbitTrail && post.selectedIndex !== null) {
      this.callbacks.onTrailRefresh();
    }

    this.devValidation?.runChecks(result.positions, result.validFlags, result.objectCount);

    if (!this.firstPositionReceived) {
      this.firstPositionReceived = true;
      this.callbacks.onFirstPosition();
    }
  }

  /** Recompute category/regime counts (filter or visual-list change), no new propagation. */
  recomputeVisibleCounts(state: ReturnType<typeof useStore.getState>): void {
    if (
      !this._renderer ||
      !this.callbacks ||
      !this.firstPositionReceived ||
      this.catalog.length === 0
    ) {
      return;
    }

    const simDate = simClock.date();
    const observerPos = this.getObserverScenePositionForState(state, simDate);
    const sunDir = getSunDirection(simDate);

    const counts = this._renderer.applyFilters(
      this.catalog,
      state.categoryFilters,
      state.regimeFilters,
      observerPos,
      sunDir,
      state.visibilityMode,
      this.callbacks.getVisualNoradIds(),
    );
    useStore.getState().setVisibleCounts(counts.categoryCounts, counts.regimeCounts);

    const sel = state.selectedIndex;
    if (sel !== null && sel < this.catalog.length) {
      const sizeArr = this._renderer.mesh.geometry.getAttribute('size').array as Float32Array;
      if (sizeArr[sel] < 0.01) {
        this.callbacks.onSelectionInvalidated();
      }
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

  update(frame: FrameContext): void {
    if (!this._renderer) return;

    this._renderer.material.uniforms.uT.value = frame.uT;

    const selectedIdx = useStore.getState().selectedIndex;
    this._renderer.updateSelectedUniforms(
      selectedIdx !== null ? selectedIdx : -1,
      frame.selectionTimeSinceArrival,
    );

    this._renderer.updateUniforms(frame.cameraDistance, frame.pixelRatio);

    this.devValidation?.tickFrame();
  }

  // ── TrackingSource bridge ────────────────────────────────────────────────────

  /** GPU-side interpolation factor (uT), fresh from the worker client's timing. */
  getInterpolationFactor(): number {
    return this.client?.getTickState().uT ?? 0.0;
  }

  /** Fill outPos/outVel with the interpolated TLE state at uT. False if index invalid. */
  getTleKinematics(
    index: number,
    uT: number,
    outPos: THREE.Vector3,
    outVel: THREE.Vector3,
  ): boolean {
    if (!this._renderer || index < 0 || index >= this.catalog.length) return false;
    outPos.copy(this._renderer.getInterpolatedPosition(index, uT));
    // Never leave outVel stale: zero it when the worker client isn't up yet.
    if (this.client) {
      this.client.getInterpolatedVelocity(index, uT, outVel);
    } else {
      outVel.set(0, 0, 0);
    }
    return true;
  }

  /** Current altitude (km) of a TLE object, from its snapped position. */
  getTleAltitudeKm(index: number): number {
    if (!this._renderer) return 0;
    const posArr = this._renderer.mesh.geometry.getAttribute('currentPosition');
    const x = posArr.getX(index);
    const y = posArr.getY(index);
    const z = posArr.getZ(index);
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    return magnitude * EARTH_RADIUS_KM - EARTH_RADIUS_KM;
  }

  // ── Engine-driven commands ───────────────────────────────────────────────────

  /** Sim-time jump: immediate snap + reset interpolation tween. */
  requestImmediateSnap(): void {
    this.client?.requestImmediateSnap();
    if (this._renderer) this._renderer.material.uniforms.uT.value = 0.0;
  }

  /** Best-estimate propagation timestamp for the orbit-trail anchor. */
  getPropagationTimestampMs(): number {
    return this.client?.getCurrentPropagationTimestampMs() ?? simClock.now();
  }

  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this._renderer?.dispose();
    this._renderer = null;
    // DevValidation owns no GL resources (Engine never disposed it) — just drop it.
    this.devValidation = null;
    this.catalog = [];
    this.callbacks = null;
    this.firstPositionReceived = false;
  }
}

export interface SatellitesLayerCallbacks {
  /** Curated visual NORAD set (owned by the Engine's VisualListPoller). */
  getVisualNoradIds: () => Set<number>;
  /** SGP4 worker reported READY → loading phase 'propagating'. */
  onReady: (objectCount: number) => void;
  /** First propagation batch arrived → input enable + loading phase 'ready'. */
  onFirstPosition: () => void;
  /** Selected satellite was filtered out (size 0) → clear the TLE selection. */
  onSelectionInvalidated: () => void;
  /** New positions arrived while a trail is active → regenerate it. */
  onTrailRefresh: () => void;
}
