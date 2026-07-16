import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env';

export const JOB_QUEUE_NAME = 'media-jobs';

/** Payload carried by every queue message — the Mongo Job document is the source of truth. */
export interface ProcessJobPayload {
  jobId: string;
}

export function createRedisConnection(): Redis {
  // maxRetriesPerRequest: null is required by BullMQ (blocking commands).
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let queue: Queue<ProcessJobPayload> | null = null;

/** Lazy singleton so merely importing this module (e.g. in unit tests) opens no Redis connection. */
export function getQueue(): Queue<ProcessJobPayload> {
  if (!queue) {
    queue = new Queue<ProcessJobPayload>(JOB_QUEUE_NAME, { connection: createRedisConnection() });
  }
  return queue;
}

/**
 * Enqueue a processing job. Retry policy lives here, not in the worker:
 * transient failures re-attempt with exponential backoff (3s -> 6s -> 12s by default);
 * the worker escalates permanent errors via UnrecoverableError to skip remaining attempts. (D-009)
 */
export async function enqueueProcessingJob(jobId: string): Promise<void> {
  await getQueue().add(
    'process-image',
    { jobId },
    {
      attempts: env.JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
      removeOnComplete: { count: 1000, age: 24 * 3600 },
      removeOnFail: { count: 5000 },
    },
  );
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/** Health-check ping over the queue's existing Redis connection. */
export async function pingRedis(): Promise<boolean> {
  try {
    const client = (await getQueue().client) as unknown as Redis;
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
