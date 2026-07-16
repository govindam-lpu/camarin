import { Job as BullJob, QueueEvents, Worker } from 'bullmq';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectMongo } from '../lib/db';
import { logger } from '../lib/logger';
import { getAiProvider } from '../providers/ai';
import { getStorage } from '../providers/storage';
import {
  closeQueue,
  createRedisConnection,
  getQueue,
  JOB_QUEUE_NAME,
  type ProcessJobPayload,
} from '../queue';
import { markJobFailed, type PipelineDeps } from './pipeline';
import { createJobProcessor } from './processor';

/**
 * Worker entrypoint. Same codebase as the API, second process (D-010).
 * Concurrency = parallel jobs per process; scale processes horizontally for more.
 */
async function main(): Promise<void> {
  await connectMongo();

  const deps: PipelineDeps = { provider: getAiProvider(), storage: getStorage() };
  const runAttempt = createJobProcessor(deps);

  const worker = new Worker<ProcessJobPayload>(
    JOB_QUEUE_NAME,
    async (bullJob) => {
      await runAttempt(bullJob.data.jobId, bullJob.opts.attempts ?? env.JOB_ATTEMPTS);
    },
    {
      connection: createRedisConnection(),
      concurrency: env.WORKER_CONCURRENCY,
    },
  );

  worker.on('error', (err) => logger.error({ err }, 'worker error'));
  worker.on('failed', (bullJob, err) =>
    logger.warn({ bullJobId: bullJob?.id, err: err.message }, 'queue job failed'),
  );

  /**
   * Reconciler for deaths the handler can't see: if this process is SIGKILLed mid-job,
   * BullMQ's stalled-job detection eventually fails the queue job — without ever
   * re-entering our catch block. This listener keeps Mongo truthful so no job is
   * stuck "processing" forever. markJobFailed is idempotent, so overlap with the
   * handler's own failure path is harmless.
   */
  const queueEvents = new QueueEvents(JOB_QUEUE_NAME, { connection: createRedisConnection() });
  queueEvents.on('failed', ({ jobId: bullId, failedReason }) => {
    void (async () => {
      try {
        const bullJob = await BullJob.fromId(getQueue(), bullId);
        if (!bullJob?.data?.jobId) return;
        // Only act on truly-final failures (guards against event-semantics surprises).
        if ((await bullJob.getState()) !== 'failed') return;
        await markJobFailed(bullJob.data.jobId, new Error(failedReason || 'Job failed in queue'));
      } catch (err) {
        logger.error({ err, bullId }, 'failed-event reconciler error');
      }
    })();
  });

  logger.info(
    {
      queue: JOB_QUEUE_NAME,
      concurrency: env.WORKER_CONCURRENCY,
      aiProvider: deps.provider.name,
      storage: env.STORAGE_DRIVER,
      attempts: env.JOB_ATTEMPTS,
      backoffMs: env.JOB_BACKOFF_MS,
    },
    'worker started',
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down (finishing in-flight jobs)');
    void (async () => {
      await worker.close(); // waits for active jobs to finish
      await queueEvents.close();
      await closeQueue();
      await mongoose.disconnect();
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
