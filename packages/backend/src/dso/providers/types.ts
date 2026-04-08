/**
 * DSO provider-facing contracts.
 *
 * Owns:
 * - source adapter fetch result shapes
 * - provider-native vector sample types
 *
 * Does not own:
 * - Express integration
 * - cache files
 * - manifests
 * - imports from TLE-specific types or updater logic
 */

import type { DsoProvider } from '../registry/index.js';

export interface ProviderSample {
  timestamp: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface ProviderFetchResult {
  provider: DsoProvider;
  providerObjectId: string;
  sourceFrame: string;
  sourceUnits: string;
  fetchedAt: string;
  sourceRevisionAt: string | null;
  samples: ProviderSample[];
}
