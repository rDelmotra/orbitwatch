import type { Pool } from 'pg';
import { getPool, markHistoryReady } from './pool.js';
import { migrations } from './migrations/index.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Migration runner + best-effort TimescaleDB upgrade.
//
// initHistory() is the single boot entry point: it applies the plain-Postgres
// migrations (transactional, recorded in schema_migrations) and then attempts
// the Timescale hypertable + compression upgrade (best-effort, idempotent). On a
// clean run it marks history READY so routes and the ingest hook switch on.
//
// Any throw here is caught by the caller (index.ts) and logged non-fatally — the
// TLE path is never affected. A configured-but-unreachable DB simply leaves
// history "not ready" (its routes 503).
// ============================================================

async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const m of migrations) {
    if (applied.has(m.name)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      await client.query('COMMIT');
      logger.info(`History migration applied: ${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`History migration ${m.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

/**
 * Convert omm_daily to a TimescaleDB hypertable with columnar compression.
 *
 * Every step is idempotent (IF NOT EXISTS / if_not_exists) so it's safe to run on
 * each boot, and the whole thing is BEST-EFFORT: if the timescaledb extension
 * isn't available (vanilla Postgres), the first step throws, we log once and stop
 * — omm_daily stays a plain table and history still works. Partitioning by
 * utc_day (a DATE) satisfies Timescale's rule that any unique index include the
 * partition column (our UNIQUE is on (norad_id, utc_day)).
 */
async function tryEnableTimescale(pool: Pool): Promise<void> {
  const steps: Array<[label: string, sql: string]> = [
    ['enable extension', 'CREATE EXTENSION IF NOT EXISTS timescaledb'],
    [
      'create hypertable',
      `SELECT create_hypertable('omm_daily', 'utc_day',
         chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE)`,
    ],
    [
      'enable compression',
      `ALTER TABLE omm_daily SET (
         timescaledb.compress,
         timescaledb.compress_segmentby = 'norad_id',
         timescaledb.compress_orderby = 'utc_day DESC'
       )`,
    ],
    [
      'add compression policy',
      `SELECT add_compression_policy('omm_daily', INTERVAL '14 days', if_not_exists => TRUE)`,
    ],
  ];

  for (const [label, sql] of steps) {
    try {
      await pool.query(sql);
    } catch (err) {
      logger.warn(
        `History: TimescaleDB step "${label}" skipped (${(err as Error).message}) — ` +
          'omm_daily remains a plain Postgres table',
      );
      return;
    }
  }
  logger.info('History: TimescaleDB hypertable + compression active on omm_daily');
}

/**
 * Boot entry point. Applies migrations, attempts the Timescale upgrade, and marks
 * history ready. Throws if the DB is unreachable / migrations fail (caller logs
 * non-fatally and leaves history disabled).
 */
export async function initHistory(): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error('History enabled but DB pool is unavailable');

  await runMigrations(pool);
  await tryEnableTimescale(pool);
  markHistoryReady();
}
