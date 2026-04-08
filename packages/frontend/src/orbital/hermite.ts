import type { HorizonsEphemerisPoint } from '../data/types';

const EARTH_RADIUS_KM = 6371;

/**
 * Hermite cubic spline interpolation for deep-space ephemeris.
 *
 * JPL Horizons gives us position (km) + velocity (km/s) at each sample point,
 * which is exactly what Hermite splines need. This gives C1-continuous curves
 * that respect the actual trajectory physics — far better than linear lerp,
 * which would produce visible kinks at every sample boundary.
 *
 * Given two bracketing ephemeris points p0 and p1 with:
 *   - positions (x0,y0,z0) and (x1,y1,z1) in km, TEME frame
 *   - velocities (vx0,vy0,vz0) and (vx1,vy1,vz1) in km/s
 *
 * The Hermite basis for parameter s ∈ [0,1]:
 *   h00 =  2s³ - 3s² + 1   (blend start position)
 *   h10 =   s³ - 2s² + s   (blend start tangent)
 *   h01 = -2s³ + 3s²       (blend end position)
 *   h11 =   s³ -  s²       (blend end tangent)
 *
 * Tangents are velocity × interval_seconds (converts km/s → km over the span).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Interpolate position at `targetEpoch` (Unix ms) from a sorted ephemeris array.
 * Returns position in Earth radii (scene units), applying the ECI→Three.js axis swap.
 *
 * Returns null if:
 *   - The array is empty or has < 2 points
 *   - The target epoch is outside the available window (no extrapolation)
 */
export function interpolateEphemeris(
  points: HorizonsEphemerisPoint[],
  targetEpoch: number,
): Vec3 | null {
  if (points.length < 2) return null;

  const first = points[0];
  const last  = points[points.length - 1];

  // Outside window: don't extrapolate — return boundary values clamped
  if (targetEpoch <= first.epoch) {
    return toSceneCoords(first.x, first.y, first.z);
  }
  if (targetEpoch >= last.epoch) {
    return toSceneCoords(last.x, last.y, last.z);
  }

  // Binary search for bracketing interval
  let lo = 0;
  let hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid + 1].epoch <= targetEpoch) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const p0 = points[lo];
  const p1 = points[lo + 1];

  const h  = (p1.epoch - p0.epoch) / 1000; // interval in seconds
  const s  = (targetEpoch - p0.epoch) / (p1.epoch - p0.epoch); // normalised [0,1]

  // Hermite basis functions
  const s2  = s * s;
  const s3  = s2 * s;
  const h00 =  2 * s3 - 3 * s2 + 1;
  const h10 =      s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 =      s3 -     s2;

  // Scale velocities: km/s → km over the interval
  const tx = p0.vx * h;
  const ty = p0.vy * h;
  const tz = p0.vz * h;
  const tx1 = p1.vx * h;
  const ty1 = p1.vy * h;
  const tz1 = p1.vz * h;

  const x = h00 * p0.x + h10 * tx + h01 * p1.x + h11 * tx1;
  const y = h00 * p0.y + h10 * ty + h01 * p1.y + h11 * ty1;
  const z = h00 * p0.z + h10 * tz + h01 * p1.z + h11 * tz1;

  return toSceneCoords(x, y, z);
}

/**
 * Convert TEME km coordinates to Three.js scene units (Earth radii).
 * Axis swap: TEME X→X,  TEME Y→-Z (Three.js),  TEME Z→Y (Three.js)
 * (Matches the swap in SatelliteRenderer.updatePositions)
 */
function toSceneCoords(x: number, y: number, z: number): Vec3 {
  return {
    x:  x / EARTH_RADIUS_KM,
    y:  z / EARTH_RADIUS_KM,   // TEME Z → Three.js Y
    z: -y / EARTH_RADIUS_KM,   // TEME Y → Three.js -Z
  };
}

/**
 * Sample `n` evenly-spaced positions along the ephemeris (for orbit trail rendering).
 * Points outside the window are clamped to the boundary.
 */
export function sampleEphemerisTrail(
  points: HorizonsEphemerisPoint[],
  n: number,
): Vec3[] {
  if (points.length === 0) return [];
  const start = points[0].epoch;
  const end   = points[points.length - 1].epoch;
  const result: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + (i / (n - 1)) * (end - start);
    const pos = interpolateEphemeris(points, t);
    if (pos) result.push(pos);
  }
  return result;
}
