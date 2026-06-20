import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCatalogResult } from './tle-client';
import type { EnrichedTLEObject } from './types';

function obj(
  noradId: number,
  category: EnrichedTLEObject['category'],
  regime: EnrichedTLEObject['regime'],
): EnrichedTLEObject {
  return {
    noradId,
    name: `OBJ-${noradId}`,
    line1: `1 ${noradId}`,
    line2: `2 ${noradId}`,
    objectType: 'satellite',
    category,
    regime,
    countryCode: 'US',
    launchDate: null,
    period: 90,
    apogee: 400,
    perigee: 400,
    inclination: 51,
    rcsSize: null,
    epoch: '2026-06-19T00:00:00.000Z',
  };
}

describe('buildCatalogResult', () => {
  it('maps catalog to TLE inputs and tallies category/regime counts', () => {
    const catalogData = [
      obj(1, 'active_satellite', 'LEO'),
      obj(2, 'active_satellite', 'LEO'),
      obj(3, 'debris', 'GEO'),
    ];

    const result = buildCatalogResult(catalogData);

    assert.equal(result.catalogData, catalogData);
    assert.deepEqual(result.tles, [
      { noradId: 1, line1: '1 1', line2: '2 1' },
      { noradId: 2, line1: '1 2', line2: '2 2' },
      { noradId: 3, line1: '1 3', line2: '2 3' },
    ]);
    assert.equal(result.categoryCounts.active_satellite, 2);
    assert.equal(result.categoryCounts.debris, 1);
    assert.equal(result.categoryCounts.rocket_body, 0);
    assert.equal(result.regimeCounts.LEO, 2);
    assert.equal(result.regimeCounts.GEO, 1);
    assert.equal(result.regimeCounts.MEO, 0);
  });

  it('returns zeroed counts for an empty catalog', () => {
    const result = buildCatalogResult([]);
    assert.deepEqual(result.tles, []);
    assert.equal(result.categoryCounts.active_satellite, 0);
    assert.equal(result.regimeCounts.LEO, 0);
  });
});
