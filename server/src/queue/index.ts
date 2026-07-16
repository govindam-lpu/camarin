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
 * ioredis buffers commands while Redis is unreachable instead of failing them —
 * unbounded, that turns "Redis is down" into hung HTTP requests. A timeout converts
 * it into a clean failure the caller can handle (upload degrades to a retryable
 * failed job, D-018; health reports redis: false).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Enqueue a processing job. Retry policy lives here, not in the worker:
 * transient failures re-attempt with exponential backoff (3s -> 6s -> 12s by default);
 * the worker escalates permanent errors via UnrecoverableError to skip remaining attempts. (D-009)
 */
export async function enqueueProcessingJob(jobId: string): Promise<void> {
  await withTimeout(
    getQueue().add(
      'process-image',
      { jobId },
      {
        attempts: env.JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
        removeOnComplete: { count: 1000, age: 24 * 3600 },
        removeOnFail: { count: 5000 },
      },
    ),
    5000,
    'queue enqueue',
  );
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/** Health-check ping over the queue's existing Redis connection (bounded, never hangs). */
export async function pingRedis(): Promise<boolean> {
  try {
    const client = (await withTimeout(
      Promise.resolve(getQueue().client),
      1500,
      'redis client',
    )) as unknown as Redis;
    return (await withTimeout(client.ping(), 1500, 'redis ping')) === 'PONG';
  } catch {
    return false;
  }
}
