import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractCoverageBoundsFromError,
  deriveClampedRetryWindowFromError,
} from '../../../src/dso/providers/horizons-coverage.ts';
import type { DsoRegistryEntry } from '../../../src/dso/registry/types.ts';

const baseEntry: DsoRegistryEntry = {
  dsoId: 'artemis-ii',
  slug: 'artemis-ii',
  displayName: 'Artemis II',
  provider: 'horizons',
  providerObjectId: '-1024',
  enabled: true,
  targetBody: 'moon',
  regime: 'LUNAR',
  sampleStepSec: 600,
  refreshIntervalSec: 21_600,
  validPastWindowSec: 864_000,
  validFutureWindowSec: 21_600,
  mission: 'Artemis II',
  description: null,
  searchAliases: ['artemis'],
  launchDate: '2026-04-03',
};

describe('Horizons coverage bound parsing', () => {
  it('parses lower coverage bound from "prior to" errors', () => {
    const bounds = extractCoverageBoundsFromError(
      'No ephemeris for target "Artemis II" prior to A.D. 2026-APR-02 01:58:32.3050 TDB',
    );

    assert.ok(bounds);
    assert.equal(bounds.earliestAvailable?.toISOString(), '2026-04-02T01:58:32.305Z');
    assert.equal(bounds.latestAvailable, null);
  });

  it('parses upper coverage bound from "after" errors', () => {
    const bounds = extractCoverageBoundsFromError(
      'No ephemeris for target "Artemis II" after A.D. 2026-APR-10 23:54:30.8476 TDB',
    );

    assert.ok(bounds);
    assert.equal(bounds.earliestAvailable, null);
    assert.equal(bounds.latestAvailable?.toISOString(), '2026-04-10T23:54:30.847Z');
  });
});

describe('Horizons clamped retry window derivation', () => {
  it('derives a clamped retry window from upper coverage bound', () => {
    const requestedStart = new Date('2026-04-03T19:29:54.875Z');
    const requestedEnd = new Date('2026-04-12T19:29:54.875Z');

    const clamped = deriveClampedRetryWindowFromError(
      baseEntry,
      requestedStart,
      requestedEnd,
      'No ephemeris for target "Artemis II" after A.D. 2026-APR-10 23:54:30.8476 TDB',
    );

    assert.ok(clamped);
    assert.equal(clamped.windowStart.toISOString(), requestedStart.toISOString());
    assert.equal(clamped.windowEnd.toISOString(), '2026-04-10T23:44:30.847Z');
  });

  it('returns null when the clamped window becomes invalid', () => {
    const requestedStart = new Date('2026-04-10T23:50:00.000Z');
    const requestedEnd = new Date('2026-04-10T23:56:00.000Z');

    const clamped = deriveClampedRetryWindowFromError(
      baseEntry,
      requestedStart,
      requestedEnd,
      'No ephemeris for target "Artemis II" after A.D. 2026-APR-10 23:54:30.8476 TDB',
    );

    assert.equal(clamped, null);
  });

  it('returns null when the error has no parseable coverage bounds', () => {
    const requestedStart = new Date('2026-04-03T00:00:00.000Z');
    const requestedEnd = new Date('2026-04-05T00:00:00.000Z');

    const clamped = deriveClampedRetryWindowFromError(
      baseEntry,
      requestedStart,
      requestedEnd,
      'Unknown target object in Horizons response',
    );

    assert.equal(clamped, null);
  });
});
