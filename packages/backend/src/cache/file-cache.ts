import fs from 'fs';
import path from 'path';
import { EnrichedTLEObject, VersionInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

// ============================================================
// File-based cache
//
// Two files are maintained:
//   data/tle-cache.json   — full enriched TLE array (the large payload)
//   data/version.json     — lightweight metadata (version timestamp, count,
//                           byte size); clients poll this to decide if they
//                           need to refetch the full dataset.
//
// Cache TTL is 24 hours — Space-Track is the primary source and we must not
// hammer their API. CelesTrak (fallback) updates every 4–8 h but a 24h TTL
// is acceptable for orbital data at this scale.
// On startup the server checks the file mtime; if it is < CACHE_TTL_MS old
// the cache is considered fresh and no fetch is triggered.
// ============================================================

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheDir(): string {
  return path.resolve(process.env.CACHE_DIR ?? './data');
}

function tleCachePath(): string {
  return path.join(getCacheDir(), 'tle-cache.json');
}

function versionPath(): string {
  return path.join(getCacheDir(), 'version.json');
}

/** Ensure the cache directory exists. */
function ensureCacheDir(): void {
  fs.mkdirSync(getCacheDir(), { recursive: true });
}

// ============================================================
// Read helpers
// ============================================================

/** Returns true if the cache file exists AND its mtime is within the TTL. */
export function isCacheFresh(): boolean {
  const p = tleCachePath();
  if (!fs.existsSync(p)) return false;
  const mtime = fs.statSync(p).mtimeMs;
  return Date.now() - mtime < CACHE_TTL_MS;
}

/**
 * Read the cached TLE array from disk.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readCache(): EnrichedTLEObject[] | null {
  const p = tleCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as EnrichedTLEObject[];
  } catch (err) {
    logger.error('Failed to read TLE cache:', err);
    return null;
  }
}

/**
 * Read the version metadata from disk.
 * Returns null if the file doesn't exist.
 */
export function readVersion(): VersionInfo | null {
  const p = versionPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as VersionInfo;
  } catch {
    return null;
  }
}

// ============================================================
// Write helpers
// ============================================================

/**
 * Atomically write the enriched TLE array and version metadata to disk.
 *
 * Atomic strategy: write to a .tmp file first, then rename.  This prevents
 * the server from ever reading a half-written cache.
 */
export function writeCache(data: EnrichedTLEObject[]): void {
  ensureCacheDir();

  const json = JSON.stringify(data);
  const byteSize = Buffer.byteLength(json, 'utf8');
  const version = new Date().toISOString();

  // Write the main cache atomically
  const tleP = tleCachePath();
  const tleTmp = tleP + '.tmp';
  fs.writeFileSync(tleTmp, json, 'utf8');
  fs.renameSync(tleTmp, tleP);

  // Write version metadata (small, non-critical — no need for atomic write)
  const versionInfo: VersionInfo = { version, count: data.length, byteSize };
  fs.writeFileSync(versionPath(), JSON.stringify(versionInfo, null, 2), 'utf8');

  logger.info(
    `Cache written: ${data.length} objects, ${(byteSize / 1_048_576).toFixed(1)} MB, version=${version}`,
  );
}
