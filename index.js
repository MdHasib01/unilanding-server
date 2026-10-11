import { createApp } from './src/app.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { startJobs, stopJobs } from './src/jobs/index.js';

// A rejected promise must never take the process down in a multi-tenant server;
// safeAsync() catches side effects, this is the backstop for everything else.
process.on('unhandledRejection', (reason) =>
  logger.error({ err: { message: reason?.message || String(reason), stack: reason?.stack } }, 'unhandledRejection')
);
process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaughtException — exiting');
  process.exit(1);
});

const app = createApp();

await connectDB();
startJobs();

const server = app.listen(env.PORT, '0.0.0.0', () =>
  logger.info(`UniLanding API listening on http://localhost:${env.PORT}`)
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info(`${signal} received — shutting down`);
    stopJobs();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    // Don't let a hung connection block the shutdown forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
