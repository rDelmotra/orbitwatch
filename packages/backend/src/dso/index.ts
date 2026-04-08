/**
 * Deep-space object (DSO) backend namespace.
 *
 * Owns:
 * - the single stable import root for all DSO backend modules
 * - namespaced re-exports for future DSO implementation phases
 *
 * Does not own:
 * - runtime orchestration
 * - HTTP route mounting
 * - cache behavior
 * - provider logic
 *
 * Filled in by:
 * - later DSO phases that add concrete contracts and implementations
 *
 * Guardrail:
 * - this barrel must remain side-effect free
 */
export * as registry from './registry/index.js';
export * as providers from './providers/index.js';
export * as normalize from './normalize/index.js';
export * as snapshot from './snapshot/index.js';
export * as worker from './worker/index.js';
export * as routes from './routes/index.js';
