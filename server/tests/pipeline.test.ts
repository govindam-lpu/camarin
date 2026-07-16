import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Job } from '../src/models/Job';
import { Notification } from '../src/models/Notification';
import { AiProviderError } from '../src/providers/ai/errors';
import {
  computeFlaggedCategories,
  markJobFailed,
  processJob,
  type PipelineDeps,
} from '../src/worker/pipeline';
import { clearDb, setupTestDb, teardownTestDb } from './helpers/db';
import {
  createTestJob,
  createTestUser,
  fakePng,
  fakeProvider,
  fakeStorage,
  SAFE_LIKELIHOODS,
} from './helpers/fixtures';

beforeAll(setupTestDb);
afterAll(teardownTestDb);
beforeEach(clearDb);

function depsFor(job: { file: { storageKey: string } }, provider = fakeProvider()): PipelineDeps & {
  provider: ReturnType<typeof fakeProvider>;
} {
  return {
    provider,
    storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
  };
}

describe('computeFlaggedCategories (spec rule D-012)', () => {
  it('flags LIKELY and VERY_LIKELY categories', () => {
    expect(
      computeFlaggedCategories({ ...SAFE_LIKELIHOODS, adult: 'LIKELY', violence: 'VERY_LIKELY' }),
    ).toEqual(['adult', 'violence']);
  });

  it('does NOT flag POSSIBLE (spec: only LIKELY / VERY_LIKELY)', () => {
    expect(computeFlaggedCategories({ ...SAFE_LIKELIHOODS, racy: 'POSSIBLE' })).toEqual([]);
  });

  it('does not flag UNKNOWN / UNLIKELY / VERY_UNLIKELY', () => {
    expect(
      computeFlaggedCategories({ ...SAFE_LIKELIHOODS, adult: 'UNKNOWN', spoof: 'UNLIKELY' }),
    ).toEqual([]);
  });

  it('handles missing input', () => {
    expect(computeFlaggedCategories(null)).toEqual([]);
    expect(computeFlaggedCategories(undefined)).toEqual([]);
    expect(computeFlaggedCategories({})).toEqual([]);
  });
});

describe('processJob — happy path', () => {
  it('runs all three steps in order, persists results, completes the job', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const deps = depsFor(job);

    await processJob(job.id, deps);

    const updated = (await Job.findById(job.id))!;
    expect(updated.status).toBe('completed');
    expect(updated.attemptsMade).toBe(1);
    expect(updated.startedAt).toBeTruthy();
    expect(updated.completedAt).toBeTruthy();

    expect(updated.steps.caption.status).toBe('completed');
    expect(updated.steps.caption.text).toBe('a test caption');
    expect(updated.steps.labels.status).toBe('completed');
    expect(updated.steps.labels.items).toHaveLength(1);
    expect(updated.steps.labels.items![0]).toMatchObject({ name: 'Thing', score: 0.9 });
    expect(updated.steps.safety.status).toBe('completed');
    expect(updated.steps.safety.safe).toBe(true);

    expect(updated.flagged).toBe(false);
    expect(updated.flaggedCategories).toEqual([]);

    expect(deps.provider.calls).toEqual({ caption: 1, detectLabels: 1, checkSafety: 1 });

    // No notifications for a clean completion.
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('is idempotent: a redelivered completed job is skipped entirely', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const deps = depsFor(job);

    await processJob(job.id, deps);
    await processJob(job.id, deps); // redelivery

    expect(deps.provider.calls).toEqual({ caption: 1, detectLabels: 1, checkSafety: 1 });
    const updated = (await Job.findById(job.id))!;
    expect(updated.attemptsMade).toBe(1);
  });

  it('silently skips a job whose document was deleted', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const deps = depsFor(job);
    await Job.deleteOne({ _id: job._id });

    await expect(processJob(job.id, deps)).resolves.toBeUndefined();
  });
});

describe('processJob — flagged content', () => {
  it('flags the job and notifies the user when SafeSearch returns LIKELY', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { filename: 'holiday.png' });
    const deps = depsFor(
      job,
      fakeProvider({
        checkSafety: async () => ({
          likelihoods: { ...SAFE_LIKELIHOODS, adult: 'LIKELY', racy: 'POSSIBLE' },
        }),
      }),
    );

    await processJob(job.id, deps);

    const updated = (await Job.findById(job.id))!;
    expect(updated.status).toBe('completed');
    expect(updated.flagged).toBe(true);
    expect(updated.flaggedCategories).toEqual(['adult']); // racy=POSSIBLE must not flag
    expect(updated.steps.safety.safe).toBe(false);

    const notifications = await Notification.find({ userId: user._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('job_flagged');
    expect(notifications[0]!.message).toContain('holiday.png');
    expect(notifications[0]!.message).toContain('adult');
    expect(notifications[0]!.read).toBe(false);
  });
});

describe('processJob — step failure & checkpointing', () => {
  it('records the failing step and rethrows for the retry layer', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const boom = new AiProviderError('labels exploded', {
      retryable: true,
      code: 'TEST_BOOM',
      provider: 'fake',
    });
    const deps = depsFor(
      job,
      fakeProvider({
        detectLabels: async () => {
          throw boom;
        },
      }),
    );

    await expect(processJob(job.id, deps)).rejects.toThrow('labels exploded');

    const updated = (await Job.findById(job.id))!;
    expect(updated.status).toBe('processing'); // finality is the worker layer's call
    expect(updated.steps.caption.status).toBe('completed'); // checkpoint persisted
    expect(updated.steps.labels.status).toBe('failed');
    expect(updated.steps.labels.error).toBe('labels exploded');
    expect(updated.steps.safety.status).toBe('pending'); // never reached
  });

  it('resumes from the failed step on the next attempt (completed steps are not re-run)', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    let labelCalls = 0;
    const deps = depsFor(
      job,
      fakeProvider({
        detectLabels: async () => {
          labelCalls += 1;
          if (labelCalls === 1) {
            throw new AiProviderError('transient', {
              retryable: true,
              code: 'TEST_TRANSIENT',
              provider: 'fake',
            });
          }
          return { items: [{ name: 'RecoveredThing', score: 0.8 }] };
        },
      }),
    );

    await expect(processJob(job.id, deps)).rejects.toThrow('transient'); // attempt 1
    await processJob(job.id, deps); // attempt 2

    const updated = (await Job.findById(job.id))!;
    expect(updated.status).toBe('completed');
    expect(updated.attemptsMade).toBe(2);
    // caption ran once (checkpoint skip on attempt 2), labels ran twice:
    expect(deps.provider.calls.caption).toBe(1);
    expect(labelCalls).toBe(2);
    expect(updated.steps.caption.attempts).toBe(1);
    expect(updated.steps.labels.attempts).toBe(2);
    expect(updated.steps.labels.items![0]!.name).toBe('RecoveredThing');
  });

  it('classifies a missing stored file as a non-retryable failure', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const deps: PipelineDeps = { provider: fakeProvider(), storage: fakeStorage() }; // empty storage

    await expect(processJob(job.id, deps)).rejects.toThrow(/Object not found/);
  });
});

describe('markJobFailed', () => {
  it('marks the job failed with the classified error and notifies the user', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { status: 'processing' });
    const err = new AiProviderError('quota exceeded', {
      retryable: true,
      code: 'HF_RATE_LIMITED',
      provider: 'huggingface',
    });

    await markJobFailed(job.id, err);

    const updated = (await Job.findById(job.id))!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toMatchObject({
      code: 'HF_RATE_LIMITED',
      message: 'quota exceeded',
      retryable: true,
    });
    expect(updated.completedAt).toBeTruthy();

    const notifications = await Notification.find({ userId: user._id, type: 'job_failed' });
    expect(notifications).toHaveLength(1);
  });

  it('is idempotent: repeated calls (handler + stalled-job reconciler) do not double-notify', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { status: 'processing' });

    await markJobFailed(job.id, new Error('first'));
    await markJobFailed(job.id, new Error('second'));

    const updated = (await Job.findById(job.id))!;
    expect(updated.error?.message).toBe('first');
    expect(await Notification.countDocuments({ type: 'job_failed' })).toBe(1);
  });

  it('never downgrades a completed job to failed', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { status: 'completed' });

    await markJobFailed(job.id, new Error('too late'));

    expect((await Job.findById(job.id))!.status).toBe('completed');
    expect(await Notification.countDocuments()).toBe(0);
  });
});
