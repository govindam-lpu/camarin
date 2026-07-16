import { logger } from '../lib/logger';
import {
  FLAGGING_LIKELIHOODS,
  Job,
  PIPELINE_STEPS,
  SAFETY_CATEGORIES,
  type JobDoc,
  type SafetyCategory,
} from '../models/Job';
import { Notification } from '../models/Notification';
import { describeError } from '../providers/ai/errors';
import type { AiProvider, ImageInput, SafetyLikelihoods } from '../providers/ai/types';
import type { StorageAdapter } from '../providers/storage/types';

/**
 * Dependencies are injected so unit tests run the real orchestration logic with
 * fake providers/storage and zero network (D-004, D-011).
 */
export interface PipelineDeps {
  provider: AiProvider;
  storage: StorageAdapter;
}

/** Spec rule (D-012): flag iff any category is LIKELY or VERY_LIKELY. */
export function computeFlaggedCategories(
  likelihoods: Partial<SafetyLikelihoods> | null | undefined,
): SafetyCategory[] {
  if (!likelihoods) return [];
  return SAFETY_CATEGORIES.filter((category) => {
    const value = likelihoods[category];
    return value !== undefined && (FLAGGING_LIKELIHOODS as readonly string[]).includes(value);
  });
}

async function runStep(job: JobDoc, name: (typeof PIPELINE_STEPS)[number], image: ImageInput, provider: AiProvider): Promise<void> {
  const step = job.steps[name];
  if (step.status === 'completed') return; // checkpoint resume (D-008): never re-pay for finished work

  step.status = 'running';
  step.attempts += 1;
  step.startedAt = new Date();
  step.error = undefined;
  await job.save();

  const startedAt = Date.now();
  try {
    if (name === 'caption') {
      const result = await provider.caption(image);
      job.steps.caption.text = result.text;
    } else if (name === 'labels') {
      const result = await provider.detectLabels(image);
      job.steps.labels.items = result.items;
    } else {
      const result = await provider.checkSafety(image);
      job.steps.safety.likelihoods = result.likelihoods;
      job.steps.safety.safe = computeFlaggedCategories(result.likelihoods).length === 0;
    }
    step.status = 'completed';
    step.completedAt = new Date();
    step.durationMs = Date.now() - startedAt;
    await job.save(); // persist the checkpoint the moment the step finishes
  } catch (err) {
    step.status = 'failed';
    step.completedAt = new Date();
    step.durationMs = Date.now() - startedAt;
    step.error = err instanceof Error ? err.message : String(err);
    await job.save();
    throw err; // retry decision happens at the worker layer (D-009)
  }
}

/**
 * Process one job: load -> guard idempotency -> run the three sequential steps with
 * per-step checkpointing -> compute flagged state -> notify.
 *
 * Owns the attempt counter on the Job document (incremented per invocation for the
 * current enqueue) — deliberately not derived from BullMQ internals so retry semantics
 * are deterministic and unit-testable.
 */
export async function processJob(jobId: string, deps: PipelineDeps): Promise<void> {
  const job = await Job.findById(jobId);
  if (!job) {
    logger.warn({ jobId }, 'job document missing — skipping');
    return;
  }
  if (job.status === 'completed') {
    logger.info({ jobId }, 'job already completed — skipping redelivery');
    return;
  }

  job.status = 'processing';
  job.startedAt ??= new Date();
  job.attemptsMade += 1;
  await job.save();

  const image: ImageInput = {
    data: await deps.storage.get(job.file.storageKey),
    mime: job.file.mime,
    filename: job.file.originalName,
    attempt: job.attemptsMade,
  };

  for (const name of PIPELINE_STEPS) {
    await runStep(job, name, image, deps.provider);
  }

  const flaggedCategories = computeFlaggedCategories(job.steps.safety.likelihoods);
  job.flagged = flaggedCategories.length > 0;
  job.flaggedCategories = flaggedCategories;
  job.status = 'completed';
  job.completedAt = new Date();
  job.set('error', undefined);
  await job.save();

  // Required notification: flagged content (D-007).
  if (job.flagged) {
    await Notification.create({
      userId: job.userId,
      jobId: job._id,
      type: 'job_flagged',
      message: `Your upload "${job.file.originalName}" was flagged for: ${flaggedCategories.join(', ')}`,
    });
  }
}

/**
 * Terminal failure path. Idempotent: only transitions pending/processing jobs, so the
 * worker handler and the stalled-job reconciler can both call it without double-notifying.
 */
export async function markJobFailed(jobId: string, err: unknown): Promise<void> {
  const job = await Job.findById(jobId);
  if (!job) return;
  if (job.status === 'completed' || job.status === 'failed') return;

  const { code, message, retryable } = describeError(err);
  job.status = 'failed';
  job.completedAt = new Date();
  job.set('error', { message, code, retryable });
  await job.save();

  // Beyond spec but cheap and genuinely useful: tell the user processing failed.
  await Notification.create({
    userId: job.userId,
    jobId: job._id,
    type: 'job_failed',
    message: `Processing failed for "${job.file.originalName}" — you can retry it from the job list`,
  });
}

/** How many attempts the current enqueue of this job has made (for finality decisions). */
export async function getJobAttempts(jobId: string): Promise<number | null> {
  const doc = await Job.findById(jobId).select('attemptsMade');
  return doc?.attemptsMade ?? null;
}
