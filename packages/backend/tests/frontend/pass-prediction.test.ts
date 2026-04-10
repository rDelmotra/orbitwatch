import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as satellite from 'satellite.js';
import {
  predictVisualPass,
  VISUAL_PASS_ELEVATION_THRESHOLD_DEG,
} from '../../../frontend/src/orbital/passPrediction.ts';

const ISS_LINE1 = '1 25544U 98067A   24100.54791667  .00016717  00000+0  30743-3 0  9993';
const ISS_LINE2 = '2 25544  51.6425 231.3018 0006703  82.5725  23.5457 15.50012330444756';

const OBSERVER = { lat: 0, lon: 0, alt: 0 };
const BASE_TIME_MS = Date.parse('2024-04-10T12:00:00.000Z');

function elevationDegAt(timeMs: number): number | null {
  const satrec = satellite.twoline2satrec(ISS_LINE1, ISS_LINE2);
  const date = new Date(timeMs);
  const propagated = satellite.propagate(satrec, date);
  const positionEci = propagated?.position;
  if (!positionEci) {
    return null;
  }

  const observerGd: satellite.GeodeticLocation = {
    latitude: OBSERVER.lat * (Math.PI / 180),
    longitude: OBSERVER.lon * (Math.PI / 180),
    height: OBSERVER.alt,
  };
  const gmst = satellite.gstime(date);
  const positionEcf = satellite.eciToEcf(positionEci, gmst);
  const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);
  return lookAngles.elevation * (180 / Math.PI);
}

describe('predictVisualPass', () => {
  it('returns an ordered pass window with valid metrics', () => {
    const result = predictVisualPass({
      line1: ISS_LINE1,
      line2: ISS_LINE2,
      observer: OBSERVER,
      mode: 'geometry',
      nowMs: BASE_TIME_MS,
      elevationThresholdDeg: VISUAL_PASS_ELEVATION_THRESHOLD_DEG,
      predictionHorizonMs: 48 * 60 * 60 * 1000,
      sampleCadenceMs: 20_000,
      crossingToleranceMs: 200,
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;

    const { prediction } = result;
    const { window } = prediction;
    assert.ok(window.aosTimeMs < window.tcaTimeMs);
    assert.ok(window.tcaTimeMs < window.losTimeMs);
    assert.ok(window.durationMs > 0);
    assert.ok(window.maxElevationDeg >= VISUAL_PASS_ELEVATION_THRESHOLD_DEG);
    assert.ok(prediction.trailPositionsTeme.length >= 6);

    if (prediction.state === 'upcoming') {
      assert.ok(prediction.timeToViewMs > 0);
      assert.equal(prediction.timeRemainingMs, window.durationMs);
    } else {
      assert.equal(prediction.timeToViewMs, 0);
      assert.ok(prediction.timeRemainingMs > 0);
      assert.ok(prediction.timeRemainingMs <= window.durationMs);
    }
  });

  it('refines AOS/LOS around the 10-degree threshold', () => {
    const result = predictVisualPass({
      line1: ISS_LINE1,
      line2: ISS_LINE2,
      observer: OBSERVER,
      mode: 'geometry',
      nowMs: BASE_TIME_MS,
      elevationThresholdDeg: VISUAL_PASS_ELEVATION_THRESHOLD_DEG,
      predictionHorizonMs: 48 * 60 * 60 * 1000,
      sampleCadenceMs: 20_000,
      crossingToleranceMs: 200,
    });

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;

    const threshold = VISUAL_PASS_ELEVATION_THRESHOLD_DEG;
    const beforeAos = elevationDegAt(result.prediction.window.aosTimeMs - 1000);
    const afterAos = elevationDegAt(result.prediction.window.aosTimeMs + 1000);
    const beforeLos = elevationDegAt(result.prediction.window.losTimeMs - 1000);
    const afterLos = elevationDegAt(result.prediction.window.losTimeMs + 1000);

    if (beforeAos === null || afterAos === null || beforeLos === null || afterLos === null) {
      assert.fail('Expected elevation samples around AOS/LOS thresholds.');
    }

    assert.ok(beforeAos < threshold + 0.6);
    assert.ok(afterAos >= threshold - 0.6);
    assert.ok(beforeLos >= threshold - 0.6);
    assert.ok(afterLos < threshold + 0.6);
  });

  it('returns no_pass when the search window is too short', () => {
    const result = predictVisualPass({
      line1: ISS_LINE1,
      line2: ISS_LINE2,
      observer: OBSERVER,
      mode: 'geometry',
      nowMs: BASE_TIME_MS,
      predictionHorizonMs: 1_000,
      sampleCadenceMs: 1_000,
      crossingToleranceMs: 200,
    });

    assert.equal(result.kind, 'no_pass');
    if (result.kind === 'no_pass') {
      assert.ok(
        result.reason === 'no_geometry_pass'
        || result.reason === 'outside_horizon',
      );
    }
  });

  it('returns explicit not_curated reason when object is outside curated list', () => {
    const result = predictVisualPass({
      line1: ISS_LINE1,
      line2: ISS_LINE2,
      observer: OBSERVER,
      nowMs: BASE_TIME_MS,
      isCurated: false,
    });

    assert.equal(result.kind, 'no_pass');
    if (result.kind === 'no_pass') {
      assert.equal(result.reason, 'not_curated');
    }
  });
});
