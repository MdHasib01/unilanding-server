import { logger } from '../config/logger.js';

const tasks = [];

/**
 * Cron registration. Jobs are added in Phase 9 (domain verification, courier
 * sync, CAPI retry, stats rollup, plan expiry); this keeps the boot path stable
 * until then.
 */
export function startJobs() {
  if (tasks.length === 0) {
    logger.debug('no scheduled jobs registered');
    return;
  }
  for (const t of tasks) t.start();
  logger.info(`started ${tasks.length} scheduled job(s)`);
}

export function stopJobs() {
  for (const t of tasks) t.stop();
}
