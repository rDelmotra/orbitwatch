import type { ObjectCategory, OrbitalRegime } from '../data/types';
import type { CameraMode } from '../store/useStore';

export type { ObjectCategory, OrbitalRegime };

export interface AwarenessSnapshot {
  snapshotId: number;
  generatedAt: number;   // wall clock ms
  simTimeMs: number;     // sim time ms — Date.now() for now, SimulationClock later

  frustum: FrustumContents;
  notables: NotableObjectState[];
  behavior: UserBehavior;
  observer: ObserverState;
  upcoming: UpcomingPasses;
  changes: ViewChanges;
}

export interface FrustumContents {
  inViewCount: number;
  peripheralCount: number;
  byRegime: Record<OrbitalRegime, number>;
  byCategory: Record<ObjectCategory, number>;
  topGroups: FrustumGroup[];
}

export interface FrustumGroup {
  regime: OrbitalRegime;
  category: ObjectCategory;
  count: number;
}

export interface NotableObjectState {
  noradId: number;
  name: string;
  catalogIndex: number;
  altitudeKm: number;
  distanceFromCameraEr: number;
  inFrustum: boolean;
  inPeripheral: boolean;
  eclipsed: boolean;
  regime: OrbitalRegime;
  category: ObjectCategory;
}

export interface UserBehavior {
  cameraMode: CameraMode;
  angularVelocityRadPerSec: number;
  stationaryDurationSec: number;
  dominantRegimeInView: OrbitalRegime | null;
  selectedNoradId: number | null;
  selectedName: string | null;
}

export type TwilightPhase = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';
export type NakedEyeQuality = 'good' | 'marginal' | 'poor';

export interface ObserverState {
  active: boolean;
  lat: number | null;
  lon: number | null;
  twilightPhase: TwilightPhase | null;
  nakedEyeQuality: NakedEyeQuality | null;
  localSolarHourAngle: number | null;
}

export interface UpcomingPasses {
  hasObserver: boolean;
  currentPass: UpcomingPassInfo | null;
}

export interface UpcomingPassInfo {
  noradId: number;
  name: string;
  status: 'in_view' | 'upcoming' | 'computing' | 'none';
  aosTimeMs: number | null;
  losTimeMs: number | null;
  tcaTimeMs: number | null;
  maxElevationDeg: number | null;
  timeToAosMs: number | null;
  message: string | null;
}

export interface ViewChanges {
  inViewDelta: number;
  notableTransitions: NotableTransition[];
}

export interface NotableTransition {
  noradId: number;
  name: string;
  kind: 'entered_view' | 'exited_view' | 'entered_eclipse' | 'exited_eclipse';
}

// Internal type used between frustum.ts and notable.ts — not on the snapshot
export interface FrustumResult {
  contents: FrustumContents;
  inFrustumSet: Set<number>;
  inPeripheralSet: Set<number>;
}
