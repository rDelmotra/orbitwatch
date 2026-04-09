/**
 * DSO registry module scaffold.
 *
 * Owns:
 * - checked-in DSO definitions
 * - control-plane metadata for supported deep-space objects
 *
 * Does not own:
 * - runtime state
 * - manifests
 * - cache files
 * - provider fetch logic
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that introduces the DSO registry contracts and entries
 */
export * from './types.js';
export * from './entries.js';
