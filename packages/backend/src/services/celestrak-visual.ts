import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger.js';

const CELESTRAK_VISUAL_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json';

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 2_000;

type CelesTrakVisualRow = {
  NORAD_CAT_ID?: number | string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNoradIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new Error('CelesTrak visual response is not an array');
  }

  const ids = new Set<number>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;

    const maybeId = (row as CelesTrakVisualRow).NORAD_CAT_ID;
    const parsed =
      typeof maybeId === 'number'
        ? maybeId
        : typeof maybeId === 'string'
          ? Number(maybeId)
          : Number.NaN;

    if (Number.isInteger(parsed) && parsed > 0) {
      ids.add(parsed);
    }
  }

  const deduped = Array.from(ids).sort((a, b) => a - b);
  if (deduped.length === 0) {
    throw new Error('CelesTrak visual response contained no NORAD IDs');
  }

  return deduped;
}

export async function fetchCelesTrakVisualNoradIds(): Promise<number[]> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      logger.info(`CelesTrak visual fetch attempt ${attempt}/${RETRY_COUNT}`);
      const response = await axios.get<unknown>(CELESTRAK_VISUAL_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        decompress: true,
        headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'OrbitWatch/1.0' },
      });

      const ids = normalizeNoradIds(response.data);
      logger.info(`CelesTrak visual: received ${ids.length} NORAD IDs`);
      return ids;
    } catch (err) {
      lastError = err;
      const status = (err as AxiosError).response?.status;
      logger.warn(
        `CelesTrak visual attempt ${attempt} failed (HTTP ${status ?? 'timeout/network'})`,
      );
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : 'unknown error';
  throw new Error(`CelesTrak visual fetch failed after ${RETRY_COUNT} attempts: ${detail}`);
}
