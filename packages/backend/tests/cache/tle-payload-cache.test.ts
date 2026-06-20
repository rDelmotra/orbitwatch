import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';
import { buildTlePayload } from '../../src/cache/tle-payload-cache.ts';

describe('buildTlePayload', () => {
  const version = '2026-06-19T20:17:56.660Z';
  const objects = [
    { noradId: 25544, name: 'ISS (ZARYA)' },
    { noradId: 20580, name: 'HST' },
  ];
  const rawArray = JSON.stringify(objects);

  it('gzips an envelope that decompresses to {version,count,data}', () => {
    const { gzip } = buildTlePayload(rawArray, version, objects.length);
    const decoded = JSON.parse(zlib.gunzipSync(gzip).toString('utf8'));

    assert.equal(decoded.version, version);
    assert.equal(decoded.count, objects.length);
    assert.deepEqual(decoded.data, objects);
  });

  it('produces a quoted-version ETag', () => {
    const { etag } = buildTlePayload(rawArray, version, objects.length);
    assert.equal(etag, `"${version}"`);
  });

  it('emits valid JSON for an empty array', () => {
    const { gzip } = buildTlePayload('[]', version, 0);
    const decoded = JSON.parse(zlib.gunzipSync(gzip).toString('utf8'));
    assert.deepEqual(decoded, { version, count: 0, data: [] });
  });
});
