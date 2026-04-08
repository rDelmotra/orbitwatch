/**
 * DSO provider adapter scaffold.
 *
 * Owns:
 * - source-specific adapters for DSO truth providers
 * - provider-facing fetch contracts
 *
 * Does not own:
 * - Express integration
 * - cache files
 * - manifests
 * - route response shaping
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds Horizons and future provider adapters
 */
export * from './types.js';
