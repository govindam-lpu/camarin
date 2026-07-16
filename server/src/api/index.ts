import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectMongo } from '../lib/db';
import { logger } from '../lib/logger';
import { closeQueue } from '../queue';
import { createApp } from './app';

async function main(): Promise<void> {
  await connectMongo();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, aiProvider: env.AI_PROVIDER, storage: env.STORAGE_DRIVER }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'api shutting down');
    server.close(() => {
      void Promise.allSettled([closeQueue(), mongoose.disconnect()]).then(() => process.exit(0));
    });
    // Hard exit if in-flight requests refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
