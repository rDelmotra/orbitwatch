import type { OMMJsonObject } from 'satellite.js';
import type { SpaceTrackGPElement, CelesTrakGPElement } from '../types/index.js';

// ============================================================
// OMM builder — maps a provider GP record to a satellite.js OMMJsonObject.
//
// We migrated off TLE_LINE1/2 strings because the 5-digit NORAD catalog limit
// (~2026-07-12) means new 6-digit objects won't be emitted in the legacy TLE
// format. OMM JSON carries arbitrary-length identifiers and is consumed directly
// by satellite.js json2satrec().
//
// Validation policy:
//   - Required (return null → caller skips the object) when any propagation
//     field is missing/non-finite: mean motion, eccentricity, the orbital
//     angles, BSTAR, both mean-motion derivatives, NORAD_CAT_ID, and EPOCH.
//   - Best-effort (default 0): ELEMENT_SET_NO and REV_AT_EPOCH — bookkeeping
//     fields that don't affect propagation; we don't drop objects when missing.
//
// Both providers expose the same field names; Space-Track sends strings,
// CelesTrak sends numbers. finiteFloat()/intOr() accept either.
// ============================================================

type GpElement = SpaceTrackGPElement | CelesTrakGPElement;

/** Parse to a finite number, or null when absent/blank/non-finite. */
function finiteFloat(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse to a finite integer, or `fallback` when absent/blank/non-finite. */
function intOr(value: string | number | undefined | null, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build an OMMJsonObject from a Space-Track or CelesTrak GP element.
 * `normEpoch` is the already-normalised ISO epoch (…Z).
 * Returns null if any field json2satrec() needs to propagate is invalid.
 */
export function buildOmm(gp: GpElement, normEpoch: string): OMMJsonObject | null {
  if (!gp.EPOCH) return null;

  const meanMotion     = finiteFloat(gp.MEAN_MOTION);
  const eccentricity   = finiteFloat(gp.ECCENTRICITY);
  const inclination    = finiteFloat(gp.INCLINATION);
  const raan           = finiteFloat(gp.RA_OF_ASC_NODE);
  const argPericenter  = finiteFloat(gp.ARG_OF_PERICENTER);
  const meanAnomaly    = finiteFloat(gp.MEAN_ANOMALY);
  const bstar          = finiteFloat(gp.BSTAR);
  const meanMotionDot  = finiteFloat(gp.MEAN_MOTION_DOT);
  const meanMotionDdot = finiteFloat(gp.MEAN_MOTION_DDOT);
  const noradCatId     = finiteFloat(gp.NORAD_CAT_ID);

  if (
    meanMotion === null || eccentricity === null || inclination === null ||
    raan === null || argPericenter === null || meanAnomaly === null ||
    bstar === null || meanMotionDot === null || meanMotionDdot === null ||
    noradCatId === null
  ) {
    return null;
  }

  return {
    OBJECT_NAME: gp.OBJECT_NAME.trim(),
    OBJECT_ID: gp.OBJECT_ID,
    EPOCH: normEpoch,
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: eccentricity,
    INCLINATION: inclination,
    RA_OF_ASC_NODE: raan,
    ARG_OF_PERICENTER: argPericenter,
    MEAN_ANOMALY: meanAnomaly,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: gp.CLASSIFICATION_TYPE === 'C' ? 'C' : 'U',
    NORAD_CAT_ID: noradCatId,
    ELEMENT_SET_NO: intOr(gp.ELEMENT_SET_NO, 0),
    REV_AT_EPOCH: intOr(gp.REV_AT_EPOCH, 0),
    BSTAR: bstar,
    MEAN_MOTION_DOT: meanMotionDot,
    MEAN_MOTION_DDOT: meanMotionDdot,
  };
}
