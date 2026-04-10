import * as satellite from 'satellite.js';
import {
  isEclipsedFromComponents,
  isObserverInDarkFromComponents,
} from './lighting';
import {
  evaluateVisualVisibility,
  type VisualVisibilityReason,
  VISUAL_ELEVATION_THRESHOLD_DEG,
  VISUAL_RANGE_MAX_KM,
} from './visual-visibility';

const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_REFINEMENT_ITERATIONS = 32;
const VISUAL_PASS_BACKTRACK_MS = 2 * 60 * 60 * 1000;
const MAX_MAX_ELEVATION_SCAN_STEP_MS = 5_000;

function toJulianDate(date: Date): number {
  return date.getTime() / 86400000.0 + 2440587.5;
}

function getGAST(date: Date): number {
  const jd = toJulianDate(date);
  const du = jd - 2451545.0;
  const t = du / 36525.0;
  const gmstDeg = 280.46061837
    + 360.98564736629 * du
    + 0.000387933 * t * t
    - t * t * t / 38710000.0;
  return (((gmstDeg % 360) + 360) % 360) * (Math.PI / 180.0);
}

export const VISUAL_PASS_ELEVATION_THRESHOLD_DEG = VISUAL_ELEVATION_THRESHOLD_DEG;
export const VISUAL_PASS_PREDICTION_HORIZON_MS = 24 * 60 * 60 * 1000;
export const VISUAL_PASS_SAMPLE_CADENCE_MS = 15_000;
export const VISUAL_PASS_CROSSING_TOLERANCE_MS = 250;
export const VISUAL_PASS_TRAIL_POINT_COUNT = 180;

export interface ObserverLocation {
  lat: number;
  lon: number;
  alt: number;
}

export type PassState = 'upcoming' | 'in_view';
export type PassPredictionMode = 'visual' | 'geometry';

export interface PassWindow {
  aosTimeMs: number;
  tcaTimeMs: number;
  losTimeMs: number;
  maxElevationDeg: number;
  durationMs: number;
}

export interface VisualPassPrediction {
  state: PassState;
  generatedAtMs: number;
  timeToViewMs: number;
  timeRemainingMs: number;
  window: PassWindow;
  trailPositionsTeme: Float32Array;
}

export type VisualPassNoPassReason =
  | VisualVisibilityReason
  | 'no_geometry_pass'
  | 'no_visibility_pass'
  | 'outside_horizon'
  | 'propagation_failed';

export type VisualPassPredictionResult =
  | { kind: 'ready'; prediction: VisualPassPrediction }
  | { kind: 'no_pass'; reason: VisualPassNoPassReason; message: string };

export interface PredictVisualPassInput {
  line1: string;
  line2: string;
  observer: ObserverLocation;
  nowMs?: number;
  elevationThresholdDeg?: number;
  isCurated?: boolean;
  mode?: PassPredictionMode;
  predictionHorizonMs?: number;
  sampleCadenceMs?: number;
  crossingToleranceMs?: number;
  trailPointCount?: number;
}

export interface PassPredictionWorkerRequest {
  type: 'PREDICT';
  requestId: number;
  noradId: number;
  line1: string;
  line2: string;
  observer: ObserverLocation;
  nowMs: number;
  isCurated: boolean;
}

export type PassPredictionWorkerResponse =
  | {
    type: 'RESULT';
    requestId: number;
    noradId: number;
    result: VisualPassPredictionResult;
  }
  | {
    type: 'ERROR';
    requestId: number;
    noradId: number;
    message: string;
  };

interface LookSample {
  timeMs: number;
  elevationRad: number;
  elevationSin: number;
  rangeKm: number;
  positionEciEr: satellite.EciVec3<number>;
  visibility: ReturnType<typeof evaluateVisualVisibility>;
  geometryEligible: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toObserverGeodetic(observer: ObserverLocation): satellite.GeodeticLocation {
  return {
    latitude: observer.lat * DEG_TO_RAD,
    longitude: observer.lon * DEG_TO_RAD,
    height: observer.alt,
  };
}

function getObserverEciEr(observer: ObserverLocation, date: Date): satellite.EciVec3<number> {
  const lat = observer.lat * DEG_TO_RAD;
  const lon = observer.lon * DEG_TO_RAD;
  const r = (EARTH_RADIUS_KM + observer.alt) / EARTH_RADIUS_KM;
  const ecefX = r * Math.cos(lat) * Math.cos(lon);
  const ecefY = r * Math.cos(lat) * Math.sin(lon);
  const ecefZ = r * Math.sin(lat);
  const theta = getGAST(date);

  return {
    x: ecefX * Math.cos(theta) - ecefY * Math.sin(theta),
    y: ecefX * Math.sin(theta) + ecefY * Math.cos(theta),
    z: ecefZ,
  };
}

function getSunDirectionEciUnit(date: Date): satellite.EciVec3<number> {
  const jd = date.getTime() / 86400000.0 + 2440587.5;
  const t = (jd - 2451545.0) / 36525.0;
  const l0 = (280.46646 + 36000.76983 * t + 0.0003032 * t * t) * DEG_TO_RAD;
  const m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * DEG_TO_RAD;
  const c = (
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m)
    + (0.019993 - 0.000101 * t) * Math.sin(2 * m)
    + 0.000289 * Math.sin(3 * m)
  ) * DEG_TO_RAD;
  const sunLon = l0 + c;
  const eps = (
    23.439291111
    - 0.013004167 * t
    - 0.0000001639 * t * t
    + 0.0000005036 * t * t * t
  ) * DEG_TO_RAD;

  const x = Math.cos(sunLon);
  const y = Math.sin(sunLon) * Math.cos(eps);
  const z = Math.sin(sunLon) * Math.sin(eps);
  const len = Math.sqrt((x * x) + (y * y) + (z * z));

  if (len === 0) {
    return { x: 1, y: 0, z: 0 };
  }

  const invLen = 1 / len;
  return { x: x * invLen, y: y * invLen, z: z * invLen };
}

function createNoPass(reason: VisualPassNoPassReason, message: string): VisualPassPredictionResult {
  return { kind: 'no_pass', reason, message };
}

function createLookSampler(
  satrec: satellite.SatRec,
  observer: ObserverLocation,
  observerGeodetic: satellite.GeodeticLocation,
  mode: PassPredictionMode,
  isCurated: boolean,
  elevationThresholdSin: number,
): (timeMs: number) => LookSample | null {
  const cache = new Map<number, LookSample | null>();

  return (timeMs: number): LookSample | null => {
    const t = Math.round(timeMs);
    const cached = cache.get(t);
    if (cached !== undefined) {
      return cached;
    }

    const date = new Date(t);
    const propagated = satellite.propagate(satrec, date);
    const positionEci = propagated?.position;
    if (!positionEci) {
      cache.set(t, null);
      return null;
    }

    const gmst = satellite.gstime(date);
    const positionEcf = satellite.eciToEcf(positionEci, gmst);
    const lookAngles = satellite.ecfToLookAngles(observerGeodetic, positionEcf);
    const elevationSin = Math.sin(lookAngles.elevation);
    const rangeKm = lookAngles.rangeSat;
    const satEciEr: satellite.EciVec3<number> = {
      x: positionEci.x / EARTH_RADIUS_KM,
      y: positionEci.y / EARTH_RADIUS_KM,
      z: positionEci.z / EARTH_RADIUS_KM,
    };

    const observerEciEr = getObserverEciEr(observer, date);
    const sunEci = getSunDirectionEciUnit(date);
    const observerDark = isObserverInDarkFromComponents(
      observerEciEr.x,
      observerEciEr.y,
      observerEciEr.z,
      sunEci.x,
      sunEci.y,
      sunEci.z,
    );
    const satelliteEclipsed = isEclipsedFromComponents(
      satEciEr.x,
      satEciEr.y,
      satEciEr.z,
      sunEci.x,
      sunEci.y,
      sunEci.z,
    );

    const visibility = evaluateVisualVisibility({
      isCurated,
      elevationSin,
      rangeKm,
      observerDark: mode === 'geometry' ? true : observerDark,
      satelliteEclipsed: mode === 'geometry' ? false : satelliteEclipsed,
      elevationThresholdSin,
    });

    const sample: LookSample = {
      timeMs: t,
      elevationRad: lookAngles.elevation,
      elevationSin,
      rangeKm,
      positionEciEr: satEciEr,
      visibility,
      geometryEligible: elevationSin >= elevationThresholdSin && rangeKm <= VISUAL_RANGE_MAX_KM,
    };
    cache.set(t, sample);
    return sample;
  };
}

function findVisibilityCrossingForward(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  endMs: number,
  stepMs: number,
  entering: boolean,
  toleranceMs: number,
): number | null {
  let prev = sampleAt(startMs);
  if (!prev) {
    return null;
  }

  for (let t = startMs + stepMs; t <= endMs; t += stepMs) {
    const curr = sampleAt(t);
    if (!curr) {
      continue;
    }

    const prevVisible = prev.visibility.visible;
    const currVisible = curr.visibility.visible;
    const hasBracket = entering
      ? (!prevVisible && currVisible)
      : (prevVisible && !currVisible);

    if (hasBracket) {
      return refineVisibilityCrossing(sampleAt, prev.timeMs, curr.timeMs, entering, toleranceMs);
    }
    prev = curr;
  }

  return null;
}

function findVisibilityCrossingBackwardEntering(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  lowerBoundMs: number,
  stepMs: number,
  toleranceMs: number,
): number | null {
  let later = sampleAt(startMs);
  if (!later || !later.visibility.visible) {
    return null;
  }

  for (let t = startMs - stepMs; t >= lowerBoundMs; t -= stepMs) {
    const earlier = sampleAt(t);
    if (!earlier) {
      continue;
    }

    if (!earlier.visibility.visible && later.visibility.visible) {
      return refineVisibilityCrossing(sampleAt, earlier.timeMs, later.timeMs, true, toleranceMs);
    }
    later = earlier;
  }

  return null;
}

function refineVisibilityCrossing(
  sampleAt: (timeMs: number) => LookSample | null,
  loMs: number,
  hiMs: number,
  entering: boolean,
  toleranceMs: number,
): number | null {
  let lo = loMs;
  let hi = hiMs;

  const loSample = sampleAt(lo);
  const hiSample = sampleAt(hi);
  if (!loSample || !hiSample) {
    return null;
  }

  for (let i = 0; i < MAX_REFINEMENT_ITERATIONS && hi - lo > toleranceMs; i++) {
    const mid = (lo + hi) * 0.5;
    const midSample = sampleAt(mid);
    if (!midSample) {
      return null;
    }

    if (entering) {
      if (midSample.visibility.visible) {
        hi = mid;
      } else {
        lo = mid;
      }
    } else if (midSample.visibility.visible) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return Math.round((lo + hi) * 0.5);
}

function findMaxElevationTime(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  endMs: number,
  cadenceMs: number,
): number {
  const stepMs = Math.max(1_000, Math.min(cadenceMs, MAX_MAX_ELEVATION_SCAN_STEP_MS));
  let bestTimeMs = startMs;
  let bestElevation = Number.NEGATIVE_INFINITY;

  for (let t = startMs; t <= endMs; t += stepMs) {
    const sample = sampleAt(t);
    if (!sample) {
      continue;
    }
    if (sample.elevationRad > bestElevation) {
      bestElevation = sample.elevationRad;
      bestTimeMs = sample.timeMs;
    }
  }

  const endSample = sampleAt(endMs);
  if (endSample && endSample.elevationRad > bestElevation) {
    bestTimeMs = endSample.timeMs;
  }

  return bestTimeMs;
}

function buildTrailPositionsTeme(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  endMs: number,
  targetPointCount: number,
): Float32Array {
  const durationMs = Math.max(0, endMs - startMs);
  const pointCount = Math.max(2, targetPointCount);
  const coords: number[] = [];
  let lastGood: LookSample | null = null;

  for (let i = 0; i < pointCount; i++) {
    const t = durationMs === 0
      ? startMs
      : startMs + (i / (pointCount - 1)) * durationMs;
    const sample = sampleAt(t);
    if (sample) {
      lastGood = sample;
    }

    if (!lastGood) {
      continue;
    }

    coords.push(
      lastGood.positionEciEr.x,
      lastGood.positionEciEr.y,
      lastGood.positionEciEr.z,
    );
  }

  if (coords.length < 6) {
    return new Float32Array();
  }

  return new Float32Array(coords);
}

function getConstraintReasonInWindow(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  endMs: number,
  cadenceMs: number,
): { sawGeometryCandidate: boolean; reason: VisualVisibilityReason | null } {
  let sawGeometryCandidate = false;
  const reasonCounts = new Map<VisualVisibilityReason, number>();

  for (let t = startMs; t <= endMs; t += cadenceMs) {
    const sample = sampleAt(t);
    if (!sample) {
      continue;
    }

    if (!sample.geometryEligible) {
      continue;
    }
    sawGeometryCandidate = true;

    const reason = sample.visibility.reason;
    if (!reason) {
      continue;
    }
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  let dominantReason: VisualVisibilityReason | null = null;
  let dominantCount = 0;
  for (const [reason, count] of reasonCounts.entries()) {
    if (count > dominantCount) {
      dominantReason = reason;
      dominantCount = count;
    }
  }

  return { sawGeometryCandidate, reason: dominantReason };
}

function messageForNoPassReason(reason: VisualPassNoPassReason): string {
  switch (reason) {
    case 'not_curated':
      return 'Selected object is not in curated naked-eye candidates.';
    case 'below_elevation':
      return 'No pass reaches 10° elevation in the prediction window.';
    case 'out_of_range':
      return 'No pass stays within naked-eye range constraints in the prediction window.';
    case 'observer_daylight':
      return 'Observer is not in darkness during geometric pass opportunities.';
    case 'satellite_eclipsed':
      return 'Satellite remains eclipsed during geometric pass opportunities.';
    case 'outside_horizon':
      return 'Pass extends beyond prediction horizon; increase horizon to continue.';
    case 'propagation_failed':
      return 'Unable to propagate orbit for pass prediction.';
    case 'no_geometry_pass':
      return 'No pass above 10° elevation in the prediction window.';
    case 'no_visibility_pass':
    default:
      return 'No naked-eye visible pass found in the prediction window.';
  }
}

export function predictVisualPass(input: PredictVisualPassInput): VisualPassPredictionResult {
  const nowMs = input.nowMs ?? Date.now();
  const isCurated = input.isCurated ?? true;
  if (!isCurated) {
    return createNoPass('not_curated', messageForNoPassReason('not_curated'));
  }

  const mode = input.mode ?? 'visual';
  const elevationThresholdDeg = input.elevationThresholdDeg ?? VISUAL_PASS_ELEVATION_THRESHOLD_DEG;
  const elevationThresholdSin = Math.sin(elevationThresholdDeg * DEG_TO_RAD);
  const horizonMs = input.predictionHorizonMs ?? VISUAL_PASS_PREDICTION_HORIZON_MS;
  const cadenceMs = input.sampleCadenceMs ?? VISUAL_PASS_SAMPLE_CADENCE_MS;
  const toleranceMs = input.crossingToleranceMs ?? VISUAL_PASS_CROSSING_TOLERANCE_MS;
  const trailPointCount = input.trailPointCount ?? VISUAL_PASS_TRAIL_POINT_COUNT;
  const endMs = nowMs + horizonMs;

  const satrec = satellite.twoline2satrec(input.line1, input.line2);
  const observerGeodetic = toObserverGeodetic(input.observer);
  const sampleAt = createLookSampler(
    satrec,
    input.observer,
    observerGeodetic,
    mode,
    isCurated,
    elevationThresholdSin,
  );

  const nowSample = sampleAt(nowMs);
  if (!nowSample) {
    return createNoPass('propagation_failed', messageForNoPassReason('propagation_failed'));
  }

  const isInViewNow = nowSample.visibility.visible;
  let aosTimeMs: number | null = null;
  let losTimeMs: number | null = null;

  if (isInViewNow) {
    losTimeMs = findVisibilityCrossingForward(
      sampleAt,
      nowMs,
      endMs,
      cadenceMs,
      false,
      toleranceMs,
    );
    if (losTimeMs === null) {
      return createNoPass('outside_horizon', messageForNoPassReason('outside_horizon'));
    }

    const backtrackLower = Math.max(nowMs - VISUAL_PASS_BACKTRACK_MS, nowMs - horizonMs);
    aosTimeMs = findVisibilityCrossingBackwardEntering(
      sampleAt,
      nowMs,
      backtrackLower,
      cadenceMs,
      toleranceMs,
    ) ?? nowMs;
  } else {
    aosTimeMs = findVisibilityCrossingForward(
      sampleAt,
      nowMs,
      endMs,
      cadenceMs,
      true,
      toleranceMs,
    );
    if (aosTimeMs === null) {
      const constraints = getConstraintReasonInWindow(sampleAt, nowMs, endMs, cadenceMs);
      if (!constraints.sawGeometryCandidate) {
        return createNoPass('no_geometry_pass', messageForNoPassReason('no_geometry_pass'));
      }
      const reason = constraints.reason ?? 'no_visibility_pass';
      return createNoPass(reason, messageForNoPassReason(reason));
    }

    losTimeMs = findVisibilityCrossingForward(
      sampleAt,
      aosTimeMs,
      endMs,
      cadenceMs,
      false,
      toleranceMs,
    );
    if (losTimeMs === null) {
      return createNoPass('outside_horizon', messageForNoPassReason('outside_horizon'));
    }
  }

  const tcaTimeMs = findMaxElevationTime(sampleAt, aosTimeMs, losTimeMs, cadenceMs);
  const tcaSample = sampleAt(tcaTimeMs);
  const maxElevationDeg = (tcaSample?.elevationRad ?? 0) * RAD_TO_DEG;
  const durationMs = Math.max(0, losTimeMs - aosTimeMs);
  const state: PassState = isInViewNow ? 'in_view' : 'upcoming';
  const trailStartMs = isInViewNow ? nowMs : aosTimeMs;

  const trailPositionsTeme = buildTrailPositionsTeme(
    sampleAt,
    trailStartMs,
    losTimeMs,
    clamp(trailPointCount, 24, 360),
  );

  return {
    kind: 'ready',
    prediction: {
      state,
      generatedAtMs: nowMs,
      timeToViewMs: isInViewNow ? 0 : Math.max(0, aosTimeMs - nowMs),
      timeRemainingMs: isInViewNow ? Math.max(0, losTimeMs - nowMs) : durationMs,
      window: {
        aosTimeMs,
        tcaTimeMs,
        losTimeMs,
        maxElevationDeg,
        durationMs,
      },
      trailPositionsTeme,
    },
  };
}
