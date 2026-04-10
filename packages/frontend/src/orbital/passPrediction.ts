import * as satellite from 'satellite.js';

const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_REFINEMENT_ITERATIONS = 32;
const VISUAL_PASS_BACKTRACK_MS = 2 * 60 * 60 * 1000;

export const VISUAL_PASS_ELEVATION_THRESHOLD_DEG = 10;
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

export type VisualPassPredictionResult =
  | { kind: 'ready'; prediction: VisualPassPrediction }
  | { kind: 'no_pass'; message: string };

export interface PredictVisualPassInput {
  line1: string;
  line2: string;
  observer: ObserverLocation;
  nowMs?: number;
  elevationThresholdDeg?: number;
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
  positionEci: satellite.EciVec3<number>;
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

function createLookSampler(
  satrec: satellite.SatRec,
  observer: satellite.GeodeticLocation,
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
    const lookAngles = satellite.ecfToLookAngles(observer, positionEcf);
    const sample: LookSample = {
      timeMs: t,
      elevationRad: lookAngles.elevation,
      positionEci,
    };
    cache.set(t, sample);
    return sample;
  };
}

function findCrossingForward(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  endMs: number,
  stepMs: number,
  thresholdRad: number,
  rising: boolean,
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

    const prevAbove = prev.elevationRad >= thresholdRad;
    const currAbove = curr.elevationRad >= thresholdRad;
    const hasBracket = rising
      ? (!prevAbove && currAbove)
      : (prevAbove && !currAbove);

    if (hasBracket) {
      return refineThresholdCrossing(
        sampleAt,
        prev.timeMs,
        curr.timeMs,
        thresholdRad,
        rising,
        toleranceMs,
      );
    }
    prev = curr;
  }

  return null;
}

function findRisingCrossingBackward(
  sampleAt: (timeMs: number) => LookSample | null,
  startMs: number,
  lowerBoundMs: number,
  stepMs: number,
  thresholdRad: number,
  toleranceMs: number,
): number | null {
  let later = sampleAt(startMs);
  if (!later || later.elevationRad < thresholdRad) {
    return null;
  }

  for (let t = startMs - stepMs; t >= lowerBoundMs; t -= stepMs) {
    const earlier = sampleAt(t);
    if (!earlier) {
      continue;
    }

    const earlierAbove = earlier.elevationRad >= thresholdRad;
    const laterAbove = later.elevationRad >= thresholdRad;
    if (!earlierAbove && laterAbove) {
      return refineThresholdCrossing(
        sampleAt,
        earlier.timeMs,
        later.timeMs,
        thresholdRad,
        true,
        toleranceMs,
      );
    }

    later = earlier;
  }

  return null;
}

function refineThresholdCrossing(
  sampleAt: (timeMs: number) => LookSample | null,
  loMs: number,
  hiMs: number,
  thresholdRad: number,
  rising: boolean,
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

    const midAbove = midSample.elevationRad >= thresholdRad;
    if (rising) {
      if (midAbove) {
        hi = mid;
      } else {
        lo = mid;
      }
    } else if (midAbove) {
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
  toleranceMs: number,
): number {
  let left = startMs;
  let right = endMs;

  for (let i = 0; i < MAX_REFINEMENT_ITERATIONS && right - left > toleranceMs; i++) {
    const m1 = left + (right - left) / 3;
    const m2 = right - (right - left) / 3;
    const s1 = sampleAt(m1);
    const s2 = sampleAt(m2);
    const e1 = s1?.elevationRad ?? Number.NEGATIVE_INFINITY;
    const e2 = s2?.elevationRad ?? Number.NEGATIVE_INFINITY;

    if (e1 < e2) {
      left = m1;
    } else {
      right = m2;
    }
  }

  return Math.round((left + right) * 0.5);
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
      lastGood.positionEci.x / EARTH_RADIUS_KM,
      lastGood.positionEci.y / EARTH_RADIUS_KM,
      lastGood.positionEci.z / EARTH_RADIUS_KM,
    );
  }

  if (coords.length < 6) {
    return new Float32Array();
  }

  return new Float32Array(coords);
}

export function predictVisualPass(input: PredictVisualPassInput): VisualPassPredictionResult {
  const nowMs = input.nowMs ?? Date.now();
  const horizonMs = input.predictionHorizonMs ?? VISUAL_PASS_PREDICTION_HORIZON_MS;
  const cadenceMs = input.sampleCadenceMs ?? VISUAL_PASS_SAMPLE_CADENCE_MS;
  const toleranceMs = input.crossingToleranceMs ?? VISUAL_PASS_CROSSING_TOLERANCE_MS;
  const thresholdRad = (input.elevationThresholdDeg ?? VISUAL_PASS_ELEVATION_THRESHOLD_DEG) * DEG_TO_RAD;
  const trailPointCount = input.trailPointCount ?? VISUAL_PASS_TRAIL_POINT_COUNT;
  const endMs = nowMs + horizonMs;

  const satrec = satellite.twoline2satrec(input.line1, input.line2);
  const observer = toObserverGeodetic(input.observer);
  const sampleAt = createLookSampler(satrec, observer);

  const nowSample = sampleAt(nowMs);
  if (!nowSample) {
    return { kind: 'no_pass', message: 'Unable to propagate orbit for pass prediction.' };
  }

  const isInViewNow = nowSample.elevationRad >= thresholdRad;
  let aosTimeMs: number | null = null;
  let losTimeMs: number | null = null;

  if (isInViewNow) {
    losTimeMs = findCrossingForward(
      sampleAt,
      nowMs,
      endMs,
      cadenceMs,
      thresholdRad,
      false,
      toleranceMs,
    );
    if (losTimeMs === null) {
      return { kind: 'no_pass', message: 'Current pass does not set within prediction horizon.' };
    }

    const backtrackLower = Math.max(nowMs - VISUAL_PASS_BACKTRACK_MS, nowMs - horizonMs);
    aosTimeMs = findRisingCrossingBackward(
      sampleAt,
      nowMs,
      backtrackLower,
      cadenceMs,
      thresholdRad,
      toleranceMs,
    ) ?? nowMs;
  } else {
    aosTimeMs = findCrossingForward(
      sampleAt,
      nowMs,
      endMs,
      cadenceMs,
      thresholdRad,
      true,
      toleranceMs,
    );
    if (aosTimeMs === null) {
      return { kind: 'no_pass', message: 'No pass above 10° elevation in the prediction window.' };
    }

    losTimeMs = findCrossingForward(
      sampleAt,
      aosTimeMs,
      endMs,
      cadenceMs,
      thresholdRad,
      false,
      toleranceMs,
    );
    if (losTimeMs === null) {
      return { kind: 'no_pass', message: 'Pass rises but does not set within prediction horizon.' };
    }
  }

  const tcaTimeMs = findMaxElevationTime(sampleAt, aosTimeMs, losTimeMs, toleranceMs);
  const tcaSample = sampleAt(tcaTimeMs);
  const maxElevationDeg = (tcaSample?.elevationRad ?? thresholdRad) * RAD_TO_DEG;
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
