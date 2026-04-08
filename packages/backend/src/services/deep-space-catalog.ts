import type { DeepSpaceCatalogEntry } from '../types/index.js';

/**
 * Static registry of deep-space objects tracked via JPL Horizons.
 * To add a new mission: append one entry here. No other code changes needed.
 *
 * horizonsId: Horizons COMMAND string (negative integers = spacecraft)
 * noradId:    Space-Track NORAD ID to suppress from the TLE pipeline, or null if none.
 *
 * Artemis II launched April 1, 2026. Horizons ID is -1024 (Orion spacecraft).
 * Ephemeris coverage: 2026-Apr-02 01:59 → ~2026-Apr-10 23:53 (10-day mission).
 */
export const DEEP_SPACE_OBJECTS: DeepSpaceCatalogEntry[] = [
  {
    horizonsId: '-1024',
    noradId: null,
    name: 'Artemis II (Orion)',
    category: 'deep_space',
    regime: 'LUNAR',
    mission: 'Artemis II',
    targetBody: 'Moon',
    missionStart: '2026-04-02T02:00:00Z',  // post-ICPS separation
    // missionEnd omitted — mission is active. Horizons coverage extends as
    // new tracking data arrives. Set missionEnd after splashdown (~Apr 11).
  },
];

/** NORAD IDs that must be excluded from the TLE pipeline (empty for now — Artemis has no TLE). */
export const deepSpaceNoradIds: Set<number> = new Set(
  DEEP_SPACE_OBJECTS.filter((o) => o.noradId !== null).map((o) => o.noradId as number),
);

export function getDeepSpaceCatalog(): DeepSpaceCatalogEntry[] {
  return DEEP_SPACE_OBJECTS;
}
