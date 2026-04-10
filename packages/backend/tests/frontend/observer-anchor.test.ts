import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getObserverSceneAnchor } from '../../../frontend/src/orbital/coordinates.ts';

const EARTH_RADIUS_KM = 6371;

describe('getObserverSceneAnchor', () => {
  it('returns unit up vector aligned with observer position', () => {
    const anchor = getObserverSceneAnchor(28.6139, 77.2090, 0.25, new Date('2026-04-10T22:45:00.000Z'));
    const positionLen = anchor.position.length();
    const upLen = anchor.up.length();
    const alignment = anchor.position.clone().normalize().dot(anchor.up);

    assert.ok(Math.abs(positionLen - ((EARTH_RADIUS_KM + 0.25) / EARTH_RADIUS_KM)) < 1e-9);
    assert.ok(Math.abs(upLen - 1) < 1e-12);
    assert.ok(alignment > 0.999999999999);
  });

  it('moves observer radius according to altitude', () => {
    const low = getObserverSceneAnchor(0, 0, 0, new Date('2026-04-10T22:45:00.000Z'));
    const high = getObserverSceneAnchor(0, 0, 1.5, new Date('2026-04-10T22:45:00.000Z'));

    assert.ok(high.position.length() > low.position.length());
  });
});
