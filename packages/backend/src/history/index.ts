/**
 * Historical OMM database namespace (Phase 1 — forward-only, full-history-ready).
 *
 * Public surface consumed by the rest of the backend:
 *   isHistoryEnabled() / isHistoryReady() — feature/availability gates
 *   initHistory()                         — boot: migrate + Timescale upgrade
 *   ingestCurrentGp()                     — daily forward-collection hook
 *   historyRouter                         — /api/history routes
 *   closeHistory()                        — graceful shutdown / tests
 *
 * History is ADDITIVE and OPTIONAL: with DATABASE_URL unset, every entry point
 * no-ops or 503s and the existing TLE/DSO backend is untouched. This barrel is
 * side-effect free (the pool is created lazily, never at import).
 */
export { isHistoryEnabled, isHistoryReady, closeHistory } from './db/pool.js';
export { initHistory } from './db/migrate.js';
export { ingestCurrentGp, ingestEnriched } from './ingest/sink.js';
export type { RawGpRecord } from './ingest/sink.js';
export { default as historyRouter } from './routes/index.js';
export type { HistoryCoverage } from './types.js';
