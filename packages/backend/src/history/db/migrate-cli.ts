import 'dotenv/config';
import { isHistoryEnabled, closeHistory } from './pool.js';
import { initHistory } from './migrate.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// Manual migration entry point: `npm run history:migrate -w @orbitwatch/backend`.
//
// Migrations also run automatically at server boot (initHistory in index.ts);
// this CLI is for running them explicitly (e.g. a Railway one-off shell) without
// starting the server. Requires DATABASE_URL.
// ============================================================

async function main(): Promise<void> {
  if (!isHistoryEnabled()) {
    logger.error('history:migrate — DATABASE_URL is not set; nothing to do.');
    process.exitCode = 1;
    return;
  }

  await initHistory();
  logger.info('history:migrate — schema is up to date.');
  await closeHistory();
}

main().catch(async (err) => {
  logger.error('history:migrate failed:', (err as Error).message);
  await closeHistory();
  process.exitCode = 1;
});
