import fs from 'fs';
import path from 'path';
import type { HorizonsEphemerisResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';

export const HORIZONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheDir(): string {
  return path.resolve(process.env.CACHE_DIR ?? './data');
}

function horizonsCachePath(commandId: string): string {
  // Sanitize commandId for use as filename (e.g. '-1024' → 'horizons--1024.json')
  const safe = commandId.replace(/[^a-zA-Z0-9_\-.]/g, '_');
  return path.join(getCacheDir(), `horizons-${safe}.json`);
}

function ensureCacheDir(): void {
  fs.mkdirSync(getCacheDir(), { recursive: true });
}

/** Returns true if the horizons cache for this commandId exists and is within TTL. */
export function isHorizonsCacheFresh(commandId: string): boolean {
  const p = horizonsCachePath(commandId);
  if (!fs.existsSync(p)) return false;
  const mtime = fs.statSync(p).mtimeMs;
  return Date.now() - mtime < HORIZONS_CACHE_TTL_MS;
}

/** Read cached ephemeris for a commandId. Returns null if missing or unreadable. */
export function readHorizonsCache(commandId: string): HorizonsEphemerisResponse | null {
  const p = horizonsCachePath(commandId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as HorizonsEphemerisResponse;
  } catch (err) {
    logger.error(`Failed to read Horizons cache for ${commandId}:`, err);
    return null;
  }
}

/** Atomically write ephemeris cache for a commandId (.tmp → rename). */
export function writeHorizonsCache(commandId: string, data: HorizonsEphemerisResponse): void {
  ensureCacheDir();
  const p = horizonsCachePath(commandId);
  const tmp = p + '.tmp';
  const json = JSON.stringify(data);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, p);
  logger.info(
    `Horizons cache written: commandId=${commandId}, ${data.points.length} points`,
  );
}
