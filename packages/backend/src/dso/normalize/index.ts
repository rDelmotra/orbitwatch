/**
 * DSO normalization scaffold.
 *
 * Owns:
 * - provider-to-OrbitWatch data conversion
 * - canonical DSO ephemeris normalization rules
 *
 * Does not own:
 * - provider fetching
 * - snapshot publishing
 * - HTTP route behavior
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds canonical DSO normalization contracts and helpers
 */
export * from './types.js';
export * from './convert.js';
export * from './validate.js';
