import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Backup safety net for Space-Track's rate limit.
// The primary guard is isCacheFresh() in file-cache.ts (24h TTL).
// This lockfile is a secondary defence for edge cases where the cache write
// failed (e.g. disk full) but the fetch succeeded — without it the process
// could hammer Space-Track on every restart until disk space is freed.
//
// MIN_INTERVAL_MS is set to 20h (slightly under 24h) so the daily cron at
// 02:00 UTC can always fire without hitting this guard.

const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours

function getLockfilePath(): string {
  const cacheDir = process.env.CACHE_DIR ?? './data';
  return path.resolve(cacheDir, 'spacetrack-last-fetch.txt');
}

/**
 * Returns true if a Space-Track request is allowed right now.
 * Always call this before authenticating with Space-Track.
 */
export function isSpaceTrackAllowed(): boolean {
  const lockfile = getLockfilePath();
  if (!fs.existsSync(lockfile)) {
    return true; // no record of a previous fetch → allowed
  }
  try {
    const raw = fs.readFileSync(lockfile, 'utf8').trim();
    const lastFetch = parseInt(raw, 10);
    if (isNaN(lastFetch)) return true;
    const elapsed = Date.now() - lastFetch;
    if (elapsed < MIN_INTERVAL_MS) {
      const remainingMin = Math.ceil((MIN_INTERVAL_MS - elapsed) / 60_000);
      logger.info(`Space-Track rate limit: ${remainingMin}min until next allowed fetch`);
      return false;
    }
    return true;
  } catch {
    return true; // if we can't read the file, allow the request
  }
}

/**
 * Record that a Space-Track request was just made.
 * Call this immediately after a successful Space-Track API call.
 */
export function recordSpaceTrackFetch(): void {
  const lockfile = getLockfilePath();
  try {
    fs.mkdirSync(path.dirname(lockfile), { recursive: true });
    fs.writeFileSync(lockfile, String(Date.now()), 'utf8');
  } catch (err) {
    logger.warn('Could not write Space-Track rate-limit lockfile:', err);
  }
}
