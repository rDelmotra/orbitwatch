import axios, { AxiosError } from 'axios';
import { CelesTrakGPElement } from '../types/index.js';
import { logger } from '../utils/logger.js';

// CelesTrak's public GP element set endpoint — no auth required.
// "last-30-days" returns all objects whose TLEs were updated in the past 30 days,
// which covers active satellites, recent debris, rocket bodies (~22 000 objects).
const CELESTRAK_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json';

const REQUEST_TIMEOUT_MS = 30_000; // 30 s — CelesTrak can be slow under load
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5_000; // 5 s between retries; CelesTrak sends 503 during updates

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch raw GP array with retry logic. Throws after all retries are exhausted. */
async function fetchRaw(): Promise<CelesTrakGPElement[]> {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      logger.info(`CelesTrak fetch attempt ${attempt}/${RETRY_COUNT}`);
      const response = await axios.get<CelesTrakGPElement[]>(CELESTRAK_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        decompress: true,
        headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'OrbitWatch/1.0' },
      });
      logger.info(`CelesTrak: received ${response.data.length} elements`);
      return response.data;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      logger.warn(`CelesTrak attempt ${attempt} failed (HTTP ${status ?? 'timeout/network'})`);
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`CelesTrak fetch failed after ${RETRY_COUNT} attempts`);
}

/**
 * Fetch, filter, and deduplicate the full GP catalog from CelesTrak.
 *
 * 1. Fetch from CelesTrak (with retry).
 * 2. Drop objects with a DECAY_DATE — they have re-entered; their TLEs are
 *    stale and their positions would be nonsensical.
 * 3. Deduplicate by NORAD_CAT_ID, keeping the entry with the newest EPOCH.
 *    (The API should not return duplicates, but this is defensive.)
 */
export async function fetchCelesTrakTLEs(): Promise<CelesTrakGPElement[]> {
  const raw = await fetchRaw();

  // Remove objects that have already re-entered the atmosphere
  const extant = raw.filter((obj) => !obj.DECAY_DATE);
  logger.info(`Filtered ${raw.length - extant.length} decayed objects`);

  // Deduplicate by NORAD_CAT_ID, preferring the most recent EPOCH string
  // (ISO-8601 string comparison is valid here because the format is fixed-width)
  const byNorad = new Map<number, CelesTrakGPElement>();
  for (const obj of extant) {
    const existing = byNorad.get(obj.NORAD_CAT_ID);
    if (!existing || obj.EPOCH > existing.EPOCH) {
      byNorad.set(obj.NORAD_CAT_ID, obj);
    }
  }

  const deduped = Array.from(byNorad.values());
  if (extant.length !== deduped.length) {
    logger.info(`Removed ${extant.length - deduped.length} duplicate NORAD IDs`);
  }

  logger.info(`CelesTrak: ${deduped.length} unique in-orbit objects`);
  return deduped;
}
