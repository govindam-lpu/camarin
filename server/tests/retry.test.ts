import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Job } from '../src/models/Job';
import { Notification } from '../src/models/Notification';
import { AiProviderError } from '../src/providers/ai/errors';
import { createMockProvider } from '../src/providers/ai/mock';
import { createJobProcessor } from '../src/worker/processor';
import { clearDb, setupTestDb, teardownTestDb } from './helpers/db';
import {
  createTestJob,
  createTestUser,
  fakePng,
  fakeProvider,
  fakeStorage,
} from './helpers/fixtures';

beforeAll(setupTestDb);
afterAll(teardownTestDb);
beforeEach(clearDb);

const ATTEMPTS = 3;

describe('createJobProcessor — retry semantics (D-009)', () => {
  it('transient failure: rethrows with attempts left, job NOT marked failed, succeeds on retry', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    let captionCalls = 0;
    const provider = fakeProvider({
      caption: async () => {
        captionCalls += 1;
        if (captionCalls === 1) {
          throw new AiProviderError('HF cold start', {
            retryable: true,
            code: 'HF_MODEL_LOADING',
            provider: 'huggingface',
            status: 503,
          });
        }
        return { text: 'recovered caption' };
      },
    });
    const runAttempt = createJobProcessor({
      provider,
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    // Attempt 1: fails transiently -> plain rethrow (BullMQ would schedule a backoff retry).
    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow('HF cold start');
    let doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('processing'); // NOT failed — attempts remain
    expect(doc.error?.message).toBeFalsy();

    // Attempt 2 (what BullMQ does after backoff): succeeds.
    await runAttempt(job.id, ATTEMPTS);
    doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('completed');
    expect(doc.attemptsMade).toBe(2);
    expect(doc.steps.caption.text).toBe('recovered caption');
  });

  it('permanent failure: fails immediately via UnrecoverableError without burning retries', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const provider = fakeProvider({
      caption: async () => {
        throw new AiProviderError('bad API key', {
          retryable: false,
          code: 'HF_AUTH_FAILED',
          provider: 'huggingface',
          status: 401,
        });
      },
    });
    const runAttempt = createJobProcessor({
      provider,
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    // First and only attempt -> UnrecoverableError tells BullMQ to skip remaining attempts.
    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toBeInstanceOf(UnrecoverableError);

    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('failed');
    expect(doc.attemptsMade).toBe(1); // no retries burned
    expect(doc.error).toMatchObject({ code: 'HF_AUTH_FAILED', retryable: false });
    expect(await Notification.countDocuments({ type: 'job_failed' })).toBe(1);
  });

  it('exhaustion: a persistent transient failure marks the job failed on the final attempt', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const provider = fakeProvider({
      caption: async () => {
        throw new AiProviderError('still rate limited', {
          retryable: true,
          code: 'GCV_RATE_LIMITED',
          provider: 'google-vision',
          status: 429,
        });
      },
    });
    const runAttempt = createJobProcessor({
      provider,
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    // Attempts 1 & 2: rethrow, job still retryable (not failed).
    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow('still rate limited');
    expect((await Job.findById(job.id))!.status).toBe('processing');
    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow('still rate limited');
    expect((await Job.findById(job.id))!.status).toBe('processing');

    // Attempt 3 (final): marked failed, error recorded as retryable (manual Retry makes sense).
    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow('still rate limited');
    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('failed');
    expect(doc.attemptsMade).toBe(3);
    expect(doc.error).toMatchObject({ code: 'GCV_RATE_LIMITED', retryable: true });
    expect(await Notification.countDocuments({ type: 'job_failed' })).toBe(1);
  });

  it('unknown errors default to retryable (transient until proven otherwise)', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const provider = fakeProvider({
      caption: async () => {
        throw new TypeError('surprise bug');
      },
    });
    const runAttempt = createJobProcessor({
      provider,
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow('surprise bug');
    // Not UnrecoverableError -> BullMQ retries; not failed yet.
    expect((await Job.findById(job.id))!.status).toBe('processing');
  });

  it('missing stored file: non-retryable, fails on attempt 1', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id);
    const runAttempt = createJobProcessor({
      provider: fakeProvider(),
      storage: fakeStorage(), // file vanished
    });

    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toBeInstanceOf(UnrecoverableError);
    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('failed');
    expect(doc.error?.code).toBe('FILE_MISSING');
  });
});

describe('mock provider demo hooks behave like real failure modes (D-005)', () => {
  it('"flaky" filename fails attempt 1 and succeeds on attempt 2', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { filename: 'flaky-cat.png' });
    const runAttempt = createJobProcessor({
      provider: createMockProvider(),
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow(/flaky/i);
    await runAttempt(job.id, ATTEMPTS);

    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('completed');
    expect(doc.attemptsMade).toBe(2);
  });

  it('"failme" filename exhausts all attempts and lands on failed', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { filename: 'failme.png' });
    const runAttempt = createJobProcessor({
      provider: createMockProvider(),
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    for (let i = 0; i < ATTEMPTS; i += 1) {
      await expect(runAttempt(job.id, ATTEMPTS)).rejects.toThrow();
    }
    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('failed');
    expect(doc.error?.code).toBe('MOCK_TRANSIENT_FAILURE');
  });

  it('"badreq" filename fails permanently on attempt 1', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { filename: 'badreq.png' });
    const runAttempt = createJobProcessor({
      provider: createMockProvider(),
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    await expect(runAttempt(job.id, ATTEMPTS)).rejects.toBeInstanceOf(UnrecoverableError);
    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('failed');
    expect(doc.attemptsMade).toBe(1);
    expect(doc.error?.retryable).toBe(false);
  });

  it('"flagme" filename produces a flagged job with an in-app notification', async () => {
    const user = await createTestUser();
    const job = await createTestJob(user._id, { filename: 'flagme-beach.png' });
    const runAttempt = createJobProcessor({
      provider: createMockProvider(),
      storage: fakeStorage({ [job.file.storageKey]: fakePng() }),
    });

    await runAttempt(job.id, ATTEMPTS);

    const doc = (await Job.findById(job.id))!;
    expect(doc.status).toBe('completed');
    expect(doc.flagged).toBe(true);
    expect(doc.flaggedCategories).toEqual(['adult']);
    expect(await Notification.countDocuments({ type: 'job_flagged' })).toBe(1);
  });
});
