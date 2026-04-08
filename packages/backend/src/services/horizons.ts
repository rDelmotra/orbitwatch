import type { HorizonsEphemerisPoint } from '../types/index.js';

const HORIZONS_API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const FETCH_TIMEOUT_MS = 30_000;

// ============================================================
// J2000 → TEME frame conversion
//
// SGP4 outputs TEME (True Equator Mean Equinox) coordinates.
// JPL Horizons outputs J2000 (ICRF-aligned, Earth-centered).
// At lunar distance (~384,400 km) the offset is ~2,400 km —
// roughly one Moon diameter — so this conversion is required.
//
// We use a simplified IAU 1976 precession + IAU 1980 nutation
// model (truncated 4-term nutation series). Accuracy is ~arcsec,
// far better than required for a 3D visualization.
// ============================================================

const DEG_TO_RAD = Math.PI / 180;
const ARCSEC_TO_RAD = DEG_TO_RAD / 3600;
const J2000_EPOCH_JD = 2451545.0; // JD of J2000.0

function julianDate(epochMs: number): number {
  return epochMs / 86_400_000 + 2440587.5;
}

/** Julian centuries since J2000.0 */
function julianCenturies(jd: number): number {
  return (jd - J2000_EPOCH_JD) / 36525;
}

/** 3×3 rotation matrix around X axis by angle θ (radians) */
function rotX(theta: number): number[] {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}

/** 3×3 rotation matrix around Z axis by angle θ (radians) */
function rotZ(theta: number): number[] {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** Multiply two 3×3 matrices (row-major flat arrays) */
function matMul(A: number[], B: number[]): number[] {
  const R = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) {
        R[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
      }
    }
  }
  return R;
}

/** Apply 3×3 matrix to a [x, y, z] vector */
function matVec(M: number[], v: [number, number, number]): [number, number, number] {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
}

/**
 * Build the J2000 → TEME rotation matrix for a given epoch.
 *
 * We follow the Astronomical Almanac reduction:
 *   1. IAU 1976 precession  (zeta_A, z_A, theta_A)
 *   2. Truncated IAU 1980 nutation (delta_psi, delta_eps)
 *   3. True obliquity of ecliptic
 *
 * Matrix: R = Rx(-eps_true) · Rz(-delta_psi) · Rx(eps_mean) · [precession]
 * Simplified to use the four dominant nutation terms (>2" amplitude).
 */
function buildJ2000ToTEME(epochMs: number): number[] {
  const jd = julianDate(epochMs);
  const T = julianCenturies(jd);

  // ── IAU 1976 precession angles (arcseconds → radians) ────────────────────
  // Lieske et al. 1977
  const zetaA  = (2306.2181 + 0.30188 * T + 0.017998 * T * T) * T * ARCSEC_TO_RAD;
  const zA     = (2306.2181 + 1.09468 * T + 0.018203 * T * T) * T * ARCSEC_TO_RAD;
  const thetaA = (2004.3109 - 0.42665 * T - 0.041833 * T * T) * T * ARCSEC_TO_RAD;

  // Precession matrix: P = Rz(-zA) · Rx(thetaA) · Rz(-zetaA)
  const P = matMul(rotZ(-zA), matMul(rotX(thetaA), rotZ(-zetaA)));

  // ── Truncated IAU 1980 nutation (4 dominant terms) ───────────────────────
  // Mean argument of latitude of the Moon (F)
  const F  = (335778.877 + (1342 * 1296000 + 295263.137) * T - 13.257 * T * T) * ARCSEC_TO_RAD;
  // Mean elongation of the Moon from the Sun (D)
  const D  = (1072261.307 + (1236 * 1296000 + 1105601.328) * T - 6.891 * T * T) * ARCSEC_TO_RAD;
  // Longitude of ascending node of the Moon (Omega)
  const Om = (450160.280 - (5 * 1296000 + 482890.539) * T + 7.455 * T * T) * ARCSEC_TO_RAD;

  // Four dominant nutation terms (IAU 1980 series, in arcseconds)
  const deltaPsi =
    (-17.1996 * Math.sin(Om)
     - 1.3187 * Math.sin(-2 * D + 2 * F + 2 * Om)
     - 0.2274 * Math.sin(2 * F + 2 * Om)
     + 0.2062 * Math.sin(2 * Om)) * ARCSEC_TO_RAD;

  const deltaEps =
    (9.2025 * Math.cos(Om)
     + 0.5736 * Math.cos(-2 * D + 2 * F + 2 * Om)
     + 0.0977 * Math.cos(2 * F + 2 * Om)
     - 0.0895 * Math.cos(2 * Om)) * ARCSEC_TO_RAD;

  // Mean obliquity of ecliptic (arcsec → rad)
  const epsBar = (84381.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC_TO_RAD;
  const epsTrue = epsBar + deltaEps;

  // ── Nutation matrix ───────────────────────────────────────────────────────
  // N = Rx(-epsTrue) · Rz(-deltaPsi) · Rx(epsBar)
  const N = matMul(rotX(-epsTrue), matMul(rotZ(-deltaPsi), rotX(epsBar)));

  // ── Combined: TEME = N · P · J2000 ───────────────────────────────────────
  // (ignoring Earth rotation; we output inertial TEME, not ECEF)
  return matMul(N, P);
}

// ============================================================
// JPL Horizons text parser
// ============================================================

/**
 * Parse the $$SOE...$$EOE block from a Horizons VECTORS response.
 *
 * Example record (after $$SOE line):
 *   2460000.500000000 = A.D. 2023-Feb-25 00:00:00.0000 TDB
 *    X = 1.234567890123456E+05 Y =-2.345678901234567E+05 Z = 3.456789012345678E+04
 *    VX=-1.234567890123456E+00 VY= 2.345678901234567E-01 VZ=-3.456789012345678E-02
 */
function parseHorizonsText(text: string): Array<{ jd: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }> {
  const soeIdx = text.indexOf('$$SOE');
  const eoeIdx = text.indexOf('$$EOE');
  if (soeIdx === -1 || eoeIdx === -1) {
    throw new Error('Horizons response missing $$SOE/$$EOE markers');
  }

  const block = text.slice(soeIdx + 5, eoeIdx).trim();
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

  const results: Array<{ jd: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }> = [];

  for (let i = 0; i < lines.length; i += 4) {
    const jdLine  = lines[i];
    const posLine = lines[i + 1];
    const velLine = lines[i + 2];
    // lines[i+3] is LT/RG/RR — skip

    if (!jdLine || !posLine || !velLine) continue;

    const jd = parseFloat(jdLine.split('=')[0]);

    // Safer explicit float matching
    const flt = /([-+]?\d+\.?\d*[Ee][+-]\d+|[-+]?\d+\.\d*)/;
    const posMatch = posLine.match(new RegExp(`X\\s*=\\s*${flt.source}\\s+Y\\s*=\\s*${flt.source}\\s+Z\\s*=\\s*${flt.source}`, 'i'));
    const velMatch = velLine.match(new RegExp(`VX\\s*=\\s*${flt.source}\\s+VY\\s*=\\s*${flt.source}\\s+VZ\\s*=\\s*${flt.source}`, 'i'));

    if (!posMatch || !velMatch || isNaN(jd)) continue;

    results.push({
      jd,
      x:  parseFloat(posMatch[1]),
      y:  parseFloat(posMatch[2]),
      z:  parseFloat(posMatch[3]),
      vx: parseFloat(velMatch[1]),
      vy: parseFloat(velMatch[2]),
      vz: parseFloat(velMatch[3]),
    });
  }

  return results;
}

// ============================================================
// Public API
// ============================================================

/**
 * Fetch ephemeris vectors from JPL Horizons and convert to TEME frame.
 *
 * @param commandId    Horizons COMMAND string (e.g. '-1024' for Artemis II)
 * @param start        Fetch window start
 * @param stop         Fetch window end
 * @param stepMinutes  Sampling interval in minutes (default 10)
 */
export async function fetchHorizonsVectors(
  commandId: string,
  start: Date,
  stop: Date,
  stepMinutes = 10,
): Promise<HorizonsEphemerisPoint[]> {
  const fmt = (d: Date) =>
    `'${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}'`;

  // Horizons requires single-quoted values for COMMAND, CENTER, times, and STEP_SIZE.
  // URLSearchParams percent-encodes the quotes, which Horizons accepts.
  const params = new URLSearchParams({
    format:      'text',
    COMMAND:     `'${commandId}'`,
    EPHEM_TYPE:  'VECTORS',
    CENTER:      `'500@399'`,     // Geocenter
    REF_PLANE:   'FRAME',
    REF_SYSTEM:  'J2000',
    VEC_TABLE:   '2',             // Position + velocity
    START_TIME:  fmt(start),
    STOP_TIME:   fmt(stop),
    STEP_SIZE:   `'${stepMinutes} m'`,
    VEC_LABELS:  'YES',
    OUT_UNITS:   'KM-S',
    CSV_FORMAT:  'NO',
  });

  const url = `${HORIZONS_API}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let text: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Horizons HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const raw = parseHorizonsText(text);
  if (raw.length === 0) throw new Error('Horizons returned 0 valid ephemeris points');

  // Convert J2000 → TEME using epoch-specific rotation matrix
  // Precompute one matrix per point (changes slowly, but correctness matters)
  return raw.map(({ jd, x, y, z, vx, vy, vz }) => {
    const epochMs = (jd - 2440587.5) * 86_400_000;
    const M = buildJ2000ToTEME(epochMs);
    const [tx, ty, tz]     = matVec(M, [x, y, z]);
    const [tvx, tvy, tvz]  = matVec(M, [vx, vy, vz]);
    return { epoch: epochMs, x: tx, y: ty, z: tz, vx: tvx, vy: tvy, vz: tvz };
  });
}
