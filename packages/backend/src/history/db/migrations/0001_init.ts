// ============================================================
// Migration 0001 — initial schema (plain Postgres; Timescale-agnostic)
//
// This file is intentionally VANILLA Postgres so it succeeds on any PG instance.
// The TimescaleDB upgrade (hypertable + columnar compression) is applied
// separately and BEST-EFFORT by migrate.ts:tryEnableTimescale() — so history
// still works on a non-Timescale Postgres (Phase-1 forward volume is tiny),
// and lights up fully when Timescale is present.
//
// Migrations are TS modules (not .sql files) because the backend build is
// `tsc` only — it does not copy non-TS assets into dist/, so a .sql read at
// runtime would 404 in production. A template-literal keeps the SQL readable.
//
// Shape: a classic star — static per-object metadata in object_dim, the
// time-varying daily elset in omm_daily. Mean elements are typed columns (not
// JSONB) so they compress well at full-history scale and reconstruct directly
// into an OMMJsonObject. The UNIQUE (norad_id, utc_day) is the daily-downsample
// key AND the ON CONFLICT target AND (being a btree on those columns) the index
// the as-of DISTINCT ON query rides.
// ============================================================

export const sql = `
CREATE TABLE IF NOT EXISTS object_dim (
  norad_id     INTEGER PRIMARY KEY,
  object_name  TEXT NOT NULL DEFAULT '',
  object_id    TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  launch_date  DATE,
  rcs_size     TEXT,
  first_seen   DATE NOT NULL,
  last_seen    DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS omm_daily (
  norad_id            INTEGER          NOT NULL,
  utc_day             DATE             NOT NULL,
  epoch               TIMESTAMPTZ      NOT NULL,
  mean_motion         DOUBLE PRECISION NOT NULL,
  eccentricity        DOUBLE PRECISION NOT NULL,
  inclination         DOUBLE PRECISION NOT NULL,
  ra_of_asc_node      DOUBLE PRECISION NOT NULL,
  arg_of_pericenter   DOUBLE PRECISION NOT NULL,
  mean_anomaly        DOUBLE PRECISION NOT NULL,
  bstar               DOUBLE PRECISION NOT NULL,
  mean_motion_dot     DOUBLE PRECISION NOT NULL,
  mean_motion_ddot    DOUBLE PRECISION NOT NULL,
  ephemeris_type      SMALLINT         NOT NULL DEFAULT 0,
  element_set_no      INTEGER          NOT NULL DEFAULT 0,
  rev_at_epoch        INTEGER          NOT NULL DEFAULT 0,
  classification_type CHAR(1)          NOT NULL DEFAULT 'U',
  period              DOUBLE PRECISION NOT NULL DEFAULT 0,
  apogee_km           DOUBLE PRECISION NOT NULL DEFAULT 0,
  perigee_km          DOUBLE PRECISION NOT NULL DEFAULT 0,
  category            TEXT             NOT NULL DEFAULT 'unknown',
  regime              TEXT             NOT NULL DEFAULT 'OTHER',
  source              TEXT             NOT NULL DEFAULT 'unknown',
  ingested_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT omm_daily_norad_day_uniq UNIQUE (norad_id, utc_day)
);
`;

export const name = '0001_init';
