/**
 * DSO worker scaffold.
 *
 * Owns:
 * - orchestration of DSO refresh and reconciliation loops
 * - worker lifecycle boundaries for asynchronous DSO ingestion
 *
 * Does not own:
 * - HTTP route definitions
 * - API payload shaping
 * - provider-specific parsing details
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds the DSO worker entrypoint and reconcile logic
 */
import { convertProviderFetchToDsoSnapshot, validateDsoSnapshot } from '../normalize/index.js';
import {
  getEnabledDsoRegistryEntries,
  type DsoRegistryEntry,
} from '../registry/index.js';
import { getDsoProviderAdapter } from '../providers/index.js';
import {
  publishDsoFailureState,
  publishDsoSnapshot,
  publishDsoWorkerHeartbeat,
  readDsoManifest,
  type DsoManifest,
  type DsoObjectStatus,
} from '../snapshot/index.js';
import { logger } from '../../utils/logger.js';

const FALLBACK_LOOP_INTERVAL_MS = 60_000;
const LOOP_JITTER_RATIO = 0.1;
const MIN_LOOP_INTERVAL_MS = 1_000;

export interface DsoWorkerLoopOptions {
  sleep?: (ms: number) => Promise<void>;
  onIterationError?: (error: unknown) => void;
}

export interface DsoWorkerControls {
  stop: () => void;
  run: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseIsoTimestamp(value: string | null): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function computeWindow(entry: DsoRegistryEntry, now: Date): { windowStart: Date; windowEnd: Date } {
  return {
    windowStart: new Date(now.getTime() - entry.validPastWindowSec * 1000),
    windowEnd: new Date(now.getTime() + entry.validFutureWindowSec * 1000),
  };
}

export function shouldRefreshDsoEntry(
  entry: DsoRegistryEntry,
  status: DsoObjectStatus | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!entry.enabled) {
    return false;
  }

  if (!status?.currentSnapshotVersion || !status.lastSuccessAt) {
    return true;
  }

  const nowMs = now.getTime();
  const lastSuccessMs = parseIsoTimestamp(status.lastSuccessAt);
  const validToMs = parseIsoTimestamp(status.validTo);
  const refreshIntervalMs = entry.refreshIntervalSec * 1000;

  if (!Number.isFinite(lastSuccessMs)) {
    return true;
  }

  if (nowMs - lastSuccessMs >= refreshIntervalMs) {
    return true;
  }

  if (!Number.isFinite(validToMs)) {
    return true;
  }

  return validToMs - nowMs <= refreshIntervalMs;
}

function computeLoopDelayMs(entries: readonly DsoRegistryEntry[]): number {
  const shortestRefreshMs = entries.reduce<number>(
    (shortest, entry) => Math.min(shortest, entry.refreshIntervalSec * 1000),
    Number.POSITIVE_INFINITY,
  );

  const baseMs = Number.isFinite(shortestRefreshMs) ? shortestRefreshMs : FALLBACK_LOOP_INTERVAL_MS;
  const jitterFraction = (Math.random() * 2 - 1) * LOOP_JITTER_RATIO;
  return Math.max(MIN_LOOP_INTERVAL_MS, Math.round(baseMs * (1 + jitterFraction)));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshDsoEntry(
  entry: DsoRegistryEntry,
  currentManifest: DsoManifest,
  workerLastRunAt: string,
): Promise<DsoManifest> {
  const startedAt = Date.now();
  const now = new Date();
  const { windowStart, windowEnd } = computeWindow(entry, now);
  const provider = getDsoProviderAdapter(entry.provider);

  logger.info(
    `DSO refresh starting: dsoId=${entry.dsoId} provider=${entry.provider} windowStart=${windowStart.toISOString()} windowEnd=${windowEnd.toISOString()}`,
  );

  try {
    const providerFetch = await provider.fetchEphemeris(entry, windowStart, windowEnd);
    const snapshot = convertProviderFetchToDsoSnapshot(entry, providerFetch, windowStart, windowEnd);
    validateDsoSnapshot(snapshot);

    const { manifest } = await publishDsoSnapshot(entry, snapshot, currentManifest, workerLastRunAt);
    const durationMs = Date.now() - startedAt;

    logger.info(
      `DSO refresh succeeded: dsoId=${entry.dsoId} provider=${entry.provider} durationMs=${durationMs} snapshotVersion=${snapshot.snapshotVersion}`,
    );

    return manifest;
  } catch (error) {
    const failureAt = new Date().toISOString();
    const { manifest } = await publishDsoFailureState(
      entry,
      currentManifest,
      failureAt,
      workerLastRunAt,
    );
    const durationMs = Date.now() - startedAt;

    logger.error(
      `DSO refresh failed: dsoId=${entry.dsoId} provider=${entry.provider} durationMs=${durationMs} error=${formatErrorMessage(error)}`,
    );

    return manifest;
  }
}

export async function reconcileDsoWorkerOnce(
  now: Date = new Date(),
): Promise<DsoManifest> {
  const enabledEntries = getEnabledDsoRegistryEntries();
  const workerLastRunAt = now.toISOString();

  let manifest = (await readDsoManifest()) ?? null;
  ({ manifest } = await publishDsoWorkerHeartbeat(manifest, workerLastRunAt));

  for (const entry of enabledEntries) {
    const status = manifest.objects[entry.dsoId];
    if (!shouldRefreshDsoEntry(entry, status, now)) {
      continue;
    }

    manifest = await refreshDsoEntry(entry, manifest, workerLastRunAt);
  }

  return manifest;
}

export function startDsoWorkerLoop(options: DsoWorkerLoopOptions = {}): DsoWorkerControls {
  const enabledEntries = getEnabledDsoRegistryEntries();
  const delaySleep = options.sleep ?? sleep;
  let stopRequested = false;

  const run = (async () => {
    logger.info(
      `DSO worker starting with ${enabledEntries.length} enabled object(s): ${enabledEntries.map((entry) => entry.dsoId).join(', ') || 'none'}`,
    );

    while (!stopRequested) {
      try {
        await reconcileDsoWorkerOnce();
      } catch (error) {
        logger.error(`DSO worker iteration crashed: ${formatErrorMessage(error)}`);
        options.onIterationError?.(error);
      }

      if (stopRequested) {
        break;
      }

      const delayMs = computeLoopDelayMs(enabledEntries);
      logger.info(`DSO worker sleeping for ${delayMs}ms before next reconcile`);
      await delaySleep(delayMs);
    }

    logger.info('DSO worker stopped');
  })();

  return {
    stop: () => {
      stopRequested = true;
    },
    run,
  };
}
