export interface TLEInput {
    noradId: number
    line1: string
    line2: string
}

export type ObjectCategory = 'active_satellite' | 'inactive_satellite' | 'rocket_body' | 'debris' | 'unknown' | 'deep_space';
export type OrbitalRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'OTHER' | 'LUNAR';

export interface EnrichedTLEObject {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  objectType: 'satellite' | 'rocket_body' | 'debris' | 'unknown';
  category: ObjectCategory;
  regime: OrbitalRegime;
  countryCode: string;
  launchDate: string | null;
  period: number;
  apogee: number;
  perigee: number;
  inclination: number;
  rcsSize: string | null;
  epoch: string;
}

export type WorkerInMessage =
    | { type: 'INIT'; tles: TLEInput[]; startIndex: number }
    | { type: 'PROPAGATE'; timestamp: number }

export type WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | { type: 'POSITIONS'; positions: Float32Array; validFlags: Uint8Array; startIndex: number }

// ── Deep-space / JPL Horizons types ──────────────────────────────────────────

export interface DeepSpaceObject {
  source: 'horizons';
  horizonsId: string;
  noradId: number | null;
  name: string;
  category: 'deep_space';
  regime: 'LUNAR';
  mission?: string;
  targetBody?: string;
  missionStart?: string;
  missionEnd?: string;
}

export type TrackedObject = (EnrichedTLEObject & { source: 'tle' }) | DeepSpaceObject;

export interface HorizonsEphemerisPoint {
  epoch: number;             // Unix ms
  x: number; y: number; z: number;    // km, TEME Earth-centered
  vx: number; vy: number; vz: number; // km/s
}

export interface HorizonsEphemerisResponse {
  commandId: string;
  windowStart: number;       // Unix ms
  windowEnd: number;         // Unix ms
  step: number;              // ms
  points: HorizonsEphemerisPoint[];
}

// Shape returned by GET /api/dso/all
export interface DSOApiResponse {
  count: number;
  objects: DeepSpaceObject[];
  ephemeris: Record<string, HorizonsEphemerisPoint[]>; // keyed by horizonsId
}

