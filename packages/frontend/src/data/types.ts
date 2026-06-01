export interface TLEInput {
    noradId: number
    line1: string
    line2: string
}

export type ObjectCategory = 'active_satellite' | 'inactive_satellite' | 'rocket_body' | 'debris' | 'unknown' | 'deep_space';
export type OrbitalRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'OTHER';

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
    | { type: 'PROPAGATE'; timestamp: number; seq: number }

export type WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | {
      type: 'POSITIONS';
      positions: Float32Array;
      velocities: Float32Array;
      validFlags: Uint8Array;
      startIndex: number;
      timestamp: number;
      seq: number;
    }
