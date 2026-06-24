import * as m0001 from './0001_init.js';

// ============================================================
// Ordered migration list. The runner (migrate.ts) applies each entry not yet in
// schema_migrations, in array order, each in its own transaction. Append new
// migrations here — never edit an applied one.
// ============================================================

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  { name: m0001.name, sql: m0001.sql },
];
