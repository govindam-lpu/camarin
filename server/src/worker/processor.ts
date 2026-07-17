import { UnrecoverableError } from 'bullmq';
import { logger } from '../lib/logger';
import { isRetryableError } from '../providers/ai/errors';
import { getJobAttempts, markJobFailed, processJob, type PipelineDeps } from './pipeline';

/**
 * The per-attempt wrapper the BullMQ worker runs — extracted so retry semantics are
 * unit-testable without a queue (D-009, D-011).
 *
 * Contract:
 *  - success -> resolves
 *  - retryable failure with attempts left -> rethrows (BullMQ schedules a backoff retry)
 *  - retryable failure on the last attempt -> marks the job failed, rethrows
 *  - permanent failure -> marks the job failed, throws UnrecoverableError
 *    (BullMQ skips the remaining attempts)
 */
export function createJobProcessor(deps: PipelineDeps) {
  return async function runAttempt(jobId: string, attemptsAllowed: number): Promise<void> {
    try {
      await processJob(jobId, deps);
    } catch (err) {
      const retryable = isRetryableError(err);
      // Attempt count is our own Mongo counter (incremented by processJob), not BullMQ
      // internals — deterministic finality. If even that read fails, assume final: a
      // job marked failed too early is user-retryable; one stuck "processing" is not.
      const attempt = (await getJobAttempts(jobId).catch(() => null)) ?? attemptsAllowed;
      const isFinal = !retryable || attempt >= attemptsAllowed;

      logger.warn(
        { jobId, attempt, attemptsAllowed, retryable, isFinal, err: (err as Error).message },
        'job attempt failed',
      );

      if (isFinal) {
        // Guarded: a bookkeeping failure must not mask the real error. If this write
        // is lost, the QueueEvents reconciler is the backstop that keeps Mongo truthful.
        await markJobFailed(jobId, err).catch((markErr) =>
          logger.error(
            { jobId, err: (markErr as Error).message },
            'failed to record terminal job failure',
          ),
        );
      }
      if (!retryable) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
  };
}
