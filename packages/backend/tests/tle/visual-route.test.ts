import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildVisualEndpointResponse,
  resolveVisualPayload,
} from '../../src/routes/tle-visual.ts';

interface VisualNoradCache {
  version: string;
  ids: number[];
}

function makeCache(version: string, ids: number[]): VisualNoradCache {
  return { version, ids };
}

describe('resolveVisualPayload', () => {
  it('serves fresh cache without refreshing upstream', async () => {
    const cached = makeCache('2026-04-10T00:00:00.000Z', [25544, 20580]);
    let refreshCalled = 0;

    const result = await resolveVisualPayload(cached, true, async () => {
      refreshCalled += 1;
      return makeCache('2026-04-10T01:00:00.000Z', [25544]);
    });

    assert.equal(refreshCalled, 0);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.source, 'cache');
      assert.equal(result.stale, false);
      assert.equal(result.refreshError, null);
      assert.deepEqual(result.payload, cached);
    }
  });

  it('refreshes from upstream when cache is missing/stale', async () => {
    const fresh = makeCache('2026-04-10T02:00:00.000Z', [25544, 28654]);

    const result = await resolveVisualPayload(null, false, async () => fresh);

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.source, 'celestrak');
      assert.equal(result.stale, false);
      assert.equal(result.refreshError, null);
      assert.deepEqual(result.payload, fresh);
    }
  });

  it('serves stale cache when upstream refresh fails', async () => {
    const cached = makeCache('2026-04-10T00:30:00.000Z', [25544, 33591]);

    const result = await resolveVisualPayload(cached, false, async () => {
      throw new Error('upstream timeout');
    });

    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.source, 'cache');
      assert.equal(result.stale, true);
      assert.equal(result.refreshError, 'upstream timeout');
      assert.deepEqual(result.payload, cached);
    }
  });

  it('returns error when upstream fails and no cache exists', async () => {
    const result = await resolveVisualPayload(null, false, async () => {
      throw new Error('upstream unavailable');
    });

    assert.equal(result.kind, 'error');
    if (result.kind === 'error') {
      assert.equal(result.message, 'upstream unavailable');
    }
  });
});

describe('buildVisualEndpointResponse', () => {
  it('produces the route response shape', () => {
    const payload = makeCache('2026-04-10T03:00:00.000Z', [25544, 28654, 43013]);
    const response = buildVisualEndpointResponse(payload, 'cache', true);

    assert.deepEqual(response, {
      version: '2026-04-10T03:00:00.000Z',
      count: 3,
      ids: [25544, 28654, 43013],
      source: 'cache',
      stale: true,
    });
  });
});
