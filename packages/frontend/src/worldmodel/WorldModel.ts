import * as THREE from 'three';
import type { EnrichedTLEObject } from '../data/types';
import { useStore } from '../store/useStore';
import { useDevStore } from '../store/devStore';
import { queryFrustum } from './awareness/frustum';
import { NotableTracker } from './awareness/notable';
import { BehaviorTracker } from './awareness/behavior';
import { computeObserverState } from './awareness/observer';
import { wrapUpcomingPasses } from './awareness/upcoming';
import type { AwarenessSnapshot, ObserverState } from './types';

export interface WorldModelDeps {
  camera: THREE.PerspectiveCamera;
  controlsTarget: THREE.Vector3;
  getCurrPosAttr: () => THREE.BufferAttribute;
  getCurrSizeAttr: () => THREE.BufferAttribute;
  catalogData: EnrichedTLEObject[];
  objectCount: number;
}

export class WorldModel {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controlsTarget: THREE.Vector3;
  private readonly getCurrPosAttr: () => THREE.BufferAttribute;
  private readonly getCurrSizeAttr: () => THREE.BufferAttribute;
  private readonly catalogData: EnrichedTLEObject[];
  private readonly objectCount: number;

  private readonly notableTracker: NotableTracker;
  private readonly behaviorTracker: BehaviorTracker;

  private snapshotId = 0;
  private latestSnapshot: AwarenessSnapshot | null = null;
  private prevInViewCount = 0;

  // Observer is recomputed at ~0.1Hz or on location change
  private observerTickAccum = 0;
  private lastObserverLat: number | null = null;
  private lastObserverLon: number | null = null;
  private cachedObserver: ObserverState = {
    active: false,
    lat: null,
    lon: null,
    twilightPhase: null,
    nakedEyeQuality: null,
    localSolarHourAngle: null,
  };

  constructor(deps: WorldModelDeps) {
    this.camera = deps.camera;
    this.controlsTarget = deps.controlsTarget;
    this.getCurrPosAttr = deps.getCurrPosAttr;
    this.getCurrSizeAttr = deps.getCurrSizeAttr;
    this.catalogData = deps.catalogData;
    this.objectCount = deps.objectCount;

    this.notableTracker = new NotableTracker(deps.catalogData);
    this.behaviorTracker = new BehaviorTracker();
  }

  tick(sunDir: THREE.Vector3, deltaSec: number): void {
    const currPosAttr = this.getCurrPosAttr();
    const currSizeAttr = this.getCurrSizeAttr();

    if (!currPosAttr || !currSizeAttr) return;

    const storeState = useStore.getState();

    // 5Hz modules — run every tick
    const frustumResult = queryFrustum(
      this.camera,
      currPosAttr,
      currSizeAttr,
      this.objectCount,
      this.catalogData,
    );

    const { states: notables, transitions: notableTransitions } = this.notableTracker.tick(
      currPosAttr,
      sunDir,
      this.camera.position,
      frustumResult.inFrustumSet,
      frustumResult.inPeripheralSet,
    );

    const selectedSat = storeState.selectedSatellite;
    const behavior = this.behaviorTracker.tick(
      this.camera,
      this.controlsTarget,
      deltaSec,
      frustumResult.contents.byRegime,
      storeState.cameraMode,
      selectedSat?.noradId ?? null,
      selectedSat?.name ?? null,
    );

    // ~0.1Hz observer module — recompute every 10s or on location change
    this.observerTickAccum += deltaSec;
    const obsLoc = storeState.observerLocation;
    const obsChanged = obsLoc?.lat !== this.lastObserverLat || obsLoc?.lon !== this.lastObserverLon;
    if (this.observerTickAccum >= 10 || obsChanged) {
      this.cachedObserver = computeObserverState(obsLoc, sunDir, new Date());
      this.observerTickAccum = 0;
      this.lastObserverLat = obsLoc?.lat ?? null;
      this.lastObserverLon = obsLoc?.lon ?? null;
    }

    // Upcoming passes — wraps existing store.visualPass (no new computation)
    const upcoming = wrapUpcomingPasses(
      obsLoc,
      storeState.visualPass,
      selectedSat?.name ?? null,
    );

    // View changes — single delta number + notable transitions only
    const inViewDelta = frustumResult.contents.inViewCount - this.prevInViewCount;

    const snapshot: AwarenessSnapshot = {
      snapshotId: this.snapshotId++,
      generatedAt: Date.now(),
      simTimeMs: Date.now(),
      frustum: frustumResult.contents,
      notables,
      behavior,
      observer: this.cachedObserver,
      upcoming,
      changes: { inViewDelta, notableTransitions },
    };

    this.latestSnapshot = snapshot;
    this.prevInViewCount = frustumResult.contents.inViewCount;

    if (import.meta.env.DEV) {
      useDevStore.getState().setWorldModelSnapshot(snapshot);
    }
  }

  getLatestSnapshot(): AwarenessSnapshot | null {
    return this.latestSnapshot;
  }

  dispose(): void {
    // Nothing to clean up in Phase 1
  }
}
