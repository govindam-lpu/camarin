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
 * Inline driver (dev harness only, D-021): runs the real worker pipeline in-process —
 * same processor, same classification/finality semantics; only the transport
 * (cross-process delivery, persistence, backoff pacing) is skipped.
 */
async function runInline(jobId: string): Promise<void> {
  // Lazy imports so bullmq-mode API processes never load the pipeline stack.
  const [{ createJobProcessor }, { getAiProvider }, { getStorage }, { UnrecoverableError }] =
    await Promise.all([
      import('../worker/processor'),
      import('../providers/ai'),
      import('../providers/storage'),
      import('bullmq'),
    ]);
  const runAttempt = createJobProcessor({ provider: getAiProvider(), storage: getStorage() });

  for (let attempt = 1; attempt <= env.JOB_ATTEMPTS; attempt += 1) {
    try {
      await runAttempt(jobId, env.JOB_ATTEMPTS);
      return;
    } catch (err) {
      // Terminal outcomes are already recorded in Mongo by the processor.
      if (err instanceof UnrecoverableError || attempt >= env.JOB_ATTEMPTS) return;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/**
 * Enqueue a processing job. Retry policy lives here, not in the worker:
 * transient failures re-attempt with exponential backoff (3s -> 6s -> 12s by default);
 * the worker escalates permanent errors via UnrecoverableError to skip remaining attempts. (D-009)
 */
export async function enqueueProcessingJob(jobId: string): Promise<void> {
  if (env.QUEUE_DRIVER === 'inline') {
    setImmediate(() => void runInline(jobId));
    return;
  }
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
  // Inline driver: the queue IS this process — reporting its health is reporting ours.
  if (env.QUEUE_DRIVER === 'inline') return true;
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
