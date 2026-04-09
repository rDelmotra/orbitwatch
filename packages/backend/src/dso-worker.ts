import 'dotenv/config';
import { startDsoWorkerLoop } from './dso/worker/index.js';
import { logger } from './utils/logger.js';

const worker = startDsoWorkerLoop();

function requestStop(signal: NodeJS.Signals): void {
  logger.info(`Received ${signal}; stopping DSO worker`);
  worker.stop();
}

process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

worker.run.catch((error) => {
  logger.error('DSO worker exited with an unrecoverable error:', error);
  process.exitCode = 1;
});
