/**
 * DSO snapshot scaffold.
 *
 * Owns:
 * - versioned file layout for published DSO artifacts
 * - publish/read helpers for DSO cache snapshots
 *
 * Does not own:
 * - provider-specific knowledge
 * - source fetching
 * - HTTP response shaping
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds manifest, catalog, and snapshot publish helpers
 */
export * from './types.js';
export * from './store.js';
