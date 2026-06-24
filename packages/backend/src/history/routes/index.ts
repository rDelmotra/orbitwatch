import { Router, type Request, type Response } from 'express';
import zlib from 'node:zlib';
import { getPool, isHistoryReady } from '../db/pool.js';
import { getCoverage } from '../db/queries.js';
import { getDaySnapshot } from '../serving/snapshot-cache.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// History HTTP routes (mounted at /api/history).
//
//   GET /coverage  → { from, to, objectCount, lastIngestAt }  (scrubber bounds)
//   GET /at?t=ISO  → the catalog as of that UTC day (same shape as /api/tle/all)
//
// Every handler 503s cleanly when history isn't ready, so mounting the router is
// always safe even with DATABASE_URL unset.
// ============================================================

const router = Router();

function serviceUnavailable(res: Response): void {
  res.status(503).json({ error: 'History is not available.' });
}

router.get('/coverage', async (_req: Request, res: Response) => {
  if (!isHistoryReady()) return serviceUnavailable(res);
  const pool = getPool();
  if (!pool) return serviceUnavailable(res);

  try {
    const coverage = await getCoverage(pool);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(coverage);
  } catch (err) {
    logger.error('GET /api/history/coverage failed:', (err as Error).message);
    serviceUnavailable(res);
  }
});

router.get('/at', async (req: Request, res: Response) => {
  if (!isHistoryReady()) return serviceUnavailable(res);
  const pool = getPool();
  if (!pool) return serviceUnavailable(res);

  let coverage;
  try {
    coverage = await getCoverage(pool);
  } catch (err) {
    logger.error('GET /api/history/at coverage check failed:', (err as Error).message);
    return serviceUnavailable(res);
  }

  if (!coverage.from || !coverage.to) {
    res.status(422).json({ error: 'No history has been collected yet.', coverage });
    return;
  }

  // Resolve `t` → a UTC day. Default to the latest covered day.
  const tRaw = typeof req.query.t === 'string' && req.query.t ? req.query.t : coverage.to;
  const parsed = new Date(tRaw);
  if (Number.isNaN(parsed.getTime())) {
    res.status(400).json({ error: 'Invalid `t` (expected an ISO date/time).' });
    return;
  }
  const day = parsed.toISOString().slice(0, 10);

  // 'YYYY-MM-DD' compares lexicographically == chronologically.
  if (day < coverage.from || day > coverage.to) {
    res.status(422).json({ error: `\`t\` is outside coverage [${coverage.from}, ${coverage.to}].`, coverage });
    return;
  }

  let snapshot;
  try {
    snapshot = await getDaySnapshot(day);
  } catch (err) {
    logger.error(`GET /api/history/at build failed for ${day}:`, (err as Error).message);
    return serviceUnavailable(res);
  }
  if (!snapshot) return serviceUnavailable(res);

  if (req.headers['if-none-match'] === snapshot.etag) {
    res.status(304).end();
    return;
  }

  // Past days are immutable → cache hard; today can still change → cache briefly.
  const isPast = day < new Date().toISOString().slice(0, 10);
  res.setHeader('Cache-Control', isPast ? 'public, max-age=86400' : 'public, max-age=60');
  res.setHeader('ETag', snapshot.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.acceptsEncodings(['gzip'])) {
    // Serve the pre-gzipped buffer directly; compression() skips re-encoding
    // because Content-Encoding is already set.
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', snapshot.gzip.length);
    res.end(snapshot.gzip);
    return;
  }

  // Rare client without gzip support — inflate the cached buffer.
  res.end(zlib.gunzipSync(snapshot.gzip));
});

export default router;
