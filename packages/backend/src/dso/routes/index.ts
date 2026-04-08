/**
 * DSO route scaffold.
 *
 * Owns:
 * - read-only HTTP layer for DSO data
 * - route-local request/response wiring
 *
 * Does not own:
 * - direct provider calls
 * - refresh orchestration
 * - snapshot publishing
 * - imports from TLE-specific types or updater logic
 *
 * Filled in by:
 * - a later phase that adds DSO API routes backed by published cache artifacts
 */
export {};
