import cron from 'node-cron';
import { fetchFromSpaceTrack } from '../services/spacetrack.js';
import { fetchCelesTrakTLEs } from '../services/celestrak.js';
import { classifyObject } from '../services/classifier.js';
import { writeCache, readCache, isCacheFresh } from '../cache/file-cache.js';
import {
  EnrichedTLEObject,
  SpaceTrackGPElement,
  SpaceTrackSatCatEntry,
  CelesTrakGPElement,
  ClassifiableObject,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { deepSpaceNoradIds, getDeepSpaceCatalog } from '../services/deep-space-catalog.js';
import { fetchHorizonsVectors } from '../services/horizons.js';
import { isHorizonsCacheFresh, readHorizonsCache, writeHorizonsCache } from '../cache/horizons-cache.js';

// Cron schedule: "0 2 * * *" = 02:00 UTC every day.
// Chosen to avoid peak hours and stay well away from adjacent cron runs.
const CRON_SCHEDULE = '0 2 * * *';

// ============================================================
// Helpers — normalise epoch strings to ISO-8601 with Z suffix
// ============================================================

function normaliseEpoch(epoch: string): string {
  // Both sources use "2024-03-15T12:00:00.000000" or "2024-03-15 12:00:00"
  // Normalise to "2024-03-15T12:00:00.000000Z"
  return epoch.replace(' ', 'T').replace(/(\.\d+)?$/, (m) => (m || '') + 'Z');
}

// ============================================================
// Space-Track path (primary)
// All numeric fields from Space-Track arrive as strings — parse them here
// before passing to the classifier or writing to the enriched object.
// ============================================================

function buildFromSpaceTrack(
  gpElements: SpaceTrackGPElement[],
  satcatEntries: SpaceTrackSatCatEntry[],
): EnrichedTLEObject[] {
  // Build O(1) lookup from SATCAT by NORAD_CAT_ID
  const satcatMap = new Map<string, SpaceTrackSatCatEntry>(
    satcatEntries.map((s) => [s.NORAD_CAT_ID, s]),
  );

  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    // Skip objects without TLE lines — they can't be propagated.
    if (!gp.TLE_LINE1 || !gp.TLE_LINE2) continue;

    // Exclude deep-space NORAD IDs — SGP4 produces garbage for lunar trajectories.
    if (deepSpaceNoradIds.has(parseInt(gp.NORAD_CAT_ID, 10))) continue;

    // Space-Track returns numeric fields as strings — parse explicitly.
    const period      = parseFloat(gp.PERIOD);
    const eccentricity = parseFloat(gp.ECCENTRICITY);
    const apogee      = parseFloat(gp.APOAPSIS);
    const perigee     = parseFloat(gp.PERIAPSIS);
    const inclination = parseFloat(gp.INCLINATION);

    // Malformed elements occasionally appear — skip them.
    if (isNaN(period) || isNaN(eccentricity)) continue;

    const satcat = satcatMap.get(gp.NORAD_CAT_ID);

    const classifiable: ClassifiableObject = {
      period,
      eccentricity,
      objectType:    gp.OBJECT_TYPE,
      opsStatusCode: satcat?.OPS_STATUS_CODE,  // undefined if no SATCAT entry
    };

    const { category, regime } = classifyObject(classifiable);

    // Derive ObjectType from category (avoids re-parsing OBJECT_TYPE)
    const objectType =
      category === 'active_satellite' || category === 'inactive_satellite' ? 'satellite'
      : category === 'rocket_body'  ? 'rocket_body'
      : category === 'debris'       ? 'debris'
      : 'unknown';

    enriched.push({
      noradId:     parseInt(gp.NORAD_CAT_ID, 10),
      name:        gp.OBJECT_NAME.trim(),
      line1:       gp.TLE_LINE1,
      line2:       gp.TLE_LINE2,
      objectType,
      category,
      regime,
      countryCode:  gp.COUNTRY_CODE || '',
      launchDate:   gp.LAUNCH_DATE  || null,
      period:       isNaN(period)   ? 0 : period,
      apogee:       isNaN(apogee)   ? 0 : apogee,
      perigee:      isNaN(perigee)  ? 0 : perigee,
      inclination:  isNaN(inclination) ? 0 : inclination,
      rcsSize:      gp.RCS_SIZE     || null,
      epoch:        normaliseEpoch(gp.EPOCH),
    });
  }

  return enriched;
}

// ============================================================
// CelesTrak fallback path
// CelesTrak returns proper JSON numbers — no parsing needed.
// OPS_STATUS_CODE is unavailable, so payloads classify as "unknown" unless
// OBJECT_TYPE itself makes the category unambiguous (debris / rocket_body).
// ============================================================

function buildFromCelesTrak(gpElements: CelesTrakGPElement[]): EnrichedTLEObject[] {
  const enriched: EnrichedTLEObject[] = [];

  for (const gp of gpElements) {
    if (!gp.TLE_LINE1 || !gp.TLE_LINE2) continue;

    // Exclude deep-space NORAD IDs — SGP4 produces garbage for lunar trajectories.
    if (deepSpaceNoradIds.has(gp.NORAD_CAT_ID)) continue;

    const classifiable: ClassifiableObject = {
      period:      gp.PERIOD,
      eccentricity: gp.ECCENTRICITY,
      objectType:  gp.OBJECT_TYPE,
      // No opsStatusCode — payloads will classify as "unknown"
    };

    const { category, regime } = classifyObject(classifiable);

    const objectType =
      category === 'active_satellite' || category === 'inactive_satellite' ? 'satellite'
      : category === 'rocket_body'  ? 'rocket_body'
      : category === 'debris'       ? 'debris'
      : 'unknown';

    enriched.push({
      noradId:     gp.NORAD_CAT_ID,
      name:        gp.OBJECT_NAME.trim(),
      line1:       gp.TLE_LINE1,
      line2:       gp.TLE_LINE2,
      objectType,
      category,
      regime,
      countryCode:  gp.COUNTRY_CODE    ?? '',
      launchDate:   gp.LAUNCH_DATE     ?? null,
      period:       gp.PERIOD,
      apogee:       gp.APOAPSIS,
      perigee:      gp.PERIAPSIS,
      inclination:  gp.INCLINATION,
      rcsSize:      gp.RCS_SIZE        ?? null,
      epoch:        normaliseEpoch(gp.EPOCH),
    });
  }

  return enriched;
}

// ============================================================
// Main update cycle
// ============================================================

/**
 * Run one full update cycle: try Space-Track first, fall back to CelesTrak.
 *
 * The cycle is skipped entirely if the cache is still fresh (< 24 h old).
 * This makes the function safe to call at startup AND from the cron job
 * without any separate rate-limit bookkeeping.
 */
export async function runUpdateCycle(): Promise<void> {
  // Guard: skip if cache is still within TTL.
  // This prevents hammering Space-Track if the process restarts repeatedly
  // or the cron fires unexpectedly.
  if (isCacheFresh()) {
    const v = readCache();
    logger.info(`Cache is fresh — skipping fetch (${v?.length ?? 0} objects cached)`);
    return;
  }

  const start = Date.now();
  logger.info('TLE update cycle starting');

  let enriched: EnrichedTLEObject[] | null = null;
  let source = 'unknown';

  // ── Primary: Space-Track ────────────────────────────────────────────────
  try {
    logger.info('Attempting Space-Track fetch (primary source)');
    const { gp, satcat } = await fetchFromSpaceTrack();
    enriched = buildFromSpaceTrack(gp, satcat);
    source = 'space-track';
  } catch (primaryErr) {
    logger.error(
      'Space-Track fetch failed — falling back to CelesTrak:',
      (primaryErr as Error).message,
    );

    // ── Fallback: CelesTrak ───────────────────────────────────────────────
    try {
      logger.info('Attempting CelesTrak fetch (fallback source)');
      const gp = await fetchCelesTrakTLEs();
      enriched = buildFromCelesTrak(gp);
      source = 'celestrak';
    } catch (fallbackErr) {
      logger.error('CelesTrak fallback also failed:', (fallbackErr as Error).message);
      // Both sources failed — preserve existing cache.
    }
  }

  if (!enriched) {
    const existing = readCache();
    if (existing) {
      logger.warn(`All sources failed — continuing to serve stale cache (${existing.length} objects)`);
    } else {
      logger.warn('All sources failed and no cache exists — API will return 503');
    }
    return;
  }

  writeCache(enriched);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(
    `TLE update complete: ${enriched.length} objects from ${source} in ${elapsed}s`,
  );
}

/**
 * Fetch and cache ephemeris from JPL Horizons for all deep-space catalog entries.
 *
 * Strategy:
 *   - If missionStart/missionEnd are set, fetch the full mission arc at 30-min
 *     steps (gives ~480 points for a 10-day mission — ~40 KB JSON).
 *   - Completed missions (missionEnd in the past AND cache exists) are skipped
 *     entirely — the trajectory won't change.
 *   - Active missions (missionEnd in future or absent) extend the window to
 *     now+48h and are refreshed daily.
 *   - Fallback (no mission dates): now−24h → now+48h at 10-min steps.
 *
 * Sequential with a 1s pause between requests to be polite to the JPL API.
 */
export async function runHorizonsUpdateCycle(): Promise<void> {
  const objects = getDeepSpaceCatalog();
  if (objects.length === 0) return;

  logger.info(`Horizons update: checking ${objects.length} deep-space object(s)`);
  const now = new Date();

  for (const [i, obj] of objects.entries()) {
    // Completed missions with existing cache: trajectory is immutable, skip.
    const missionEndMs = obj.missionEnd ? new Date(obj.missionEnd).getTime() : null;
    const isComplete = missionEndMs !== null && missionEndMs < now.getTime();
    if (isComplete && readHorizonsCache(obj.horizonsId)) {
      logger.info(`Horizons: ${obj.name} mission complete + cached — skipping`);
      continue;
    }

    // Active/ongoing: respect 24h TTL to avoid hammering JPL.
    if (isHorizonsCacheFresh(obj.horizonsId)) {
      logger.info(`Horizons cache fresh — skipping ${obj.name} (${obj.horizonsId})`);
      continue;
    }

    // Determine fetch window.
    // For missions with missionStart: fetch full arc from mission start.
    // For active missions (no missionEnd): clamp end to `now` since Horizons
    // only has data up to current tracking uploads. Adding a buffer beyond
    // the last data point would cause Horizons to reject the request.
    const windowStart = obj.missionStart
      ? new Date(obj.missionStart)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let windowEnd: Date;
    if (obj.missionEnd) {
      // Completed mission: fetch the full arc
      windowEnd = new Date(obj.missionEnd);
    } else if (obj.missionStart) {
      // Active mission: fetch from mission start to now (Horizons coverage grows daily)
      windowEnd = now;
    } else {
      // No mission dates at all: rolling 72h window
      windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    }

    // Use 30-min steps for full-arc missions, 10-min for rolling windows.
    const stepMinutes = obj.missionStart ? 30 : 10;

    try {
      logger.info(`Fetching Horizons ephemeris for ${obj.name} (${obj.horizonsId}), window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}, step: ${stepMinutes}m`);
      const points = await fetchHorizonsVectors(obj.horizonsId, windowStart, windowEnd, stepMinutes);

      writeHorizonsCache(obj.horizonsId, {
        commandId:   obj.horizonsId,
        windowStart: windowStart.getTime(),
        windowEnd:   windowEnd.getTime(),
        step:        stepMinutes * 60 * 1000,
        points,
      });

      logger.info(`Horizons: cached ${points.length} points for ${obj.name}`);
    } catch (err) {
      logger.error(`Horizons fetch failed for ${obj.name} (${obj.horizonsId}):`, (err as Error).message);
      // Non-fatal: stale cache (or no cache) will be served; the next cycle will retry.
    }

    // Polite delay between objects — skip after the last one.
    if (i < objects.length - 1) {
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Schedule the daily cron job and optionally trigger an immediate fetch.
 *
 * @param runNow - Pass true when the cache is missing or stale at startup.
 */
export function scheduleTLEUpdater(runNow: boolean): void {
  if (runNow) {
    logger.info('Cache missing or stale at startup — triggering immediate fetch');
    // Run both independently: TLE fetch guards its own freshness, Horizons guards its own.
    runUpdateCycle().catch((err) => logger.error('Startup TLE fetch error:', err));
    runHorizonsUpdateCycle().catch((err) => logger.error('Startup Horizons fetch error:', err));
  }

  const job = cron.schedule(CRON_SCHEDULE, () => {
    logger.info(`Cron triggered (${CRON_SCHEDULE})`);
    // Both run every cron tick; each checks its own TTL internally and skips if fresh.
    runUpdateCycle().catch((err) => logger.error('Cron TLE cycle error:', err));
    runHorizonsUpdateCycle().catch((err) => logger.error('Cron Horizons cycle error:', err));
  });

  logger.info(`TLE updater scheduled: ${CRON_SCHEDULE} (daily at 02:00 UTC)`);
  job.start();
}
