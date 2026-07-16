import { promises as fs } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app';
import { Job } from '../src/models/Job';
import { Notification } from '../src/models/Notification';
import { User } from '../src/models/User';
import { clearDb, setupTestDb, teardownTestDb } from './helpers/db';
import { fakeJpeg, fakePng, fakeWebp } from './helpers/fixtures';

// No Redis in unit tests: the queue module is mocked, enqueue calls are asserted (D-004).
vi.mock('../src/queue', () => ({
  JOB_QUEUE_NAME: 'media-jobs',
  enqueueProcessingJob: vi.fn(async () => {}),
  pingRedis: vi.fn(async () => true),
  getQueue: vi.fn(),
  closeQueue: vi.fn(async () => {}),
  createRedisConnection: vi.fn(),
}));

import { enqueueProcessingJob } from '../src/queue';

const app = createApp();

async function signup(email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/api/auth/signup').send({ email, password });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

function uploadPng(token: string, filename = 'photo.png', buffer: Buffer = fakePng()) {
  return request(app)
    .post('/api/jobs')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, { filename, contentType: 'image/png' });
}

beforeAll(setupTestDb);
afterAll(async () => {
  await teardownTestDb();
  await fs.rm('./.test-uploads', { recursive: true, force: true });
});
beforeEach(async () => {
  await clearDb();
  vi.mocked(enqueueProcessingJob).mockClear();
  vi.mocked(enqueueProcessingJob).mockResolvedValue(undefined);
});

describe('auth', () => {
  it('signs up, returns a token, and restores the session via /me', async () => {
    const token = await signup();
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('user@example.com');
  });

  it('rejects duplicate emails with 409 EMAIL_TAKEN', async () => {
    await signup();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'user@example.com', password: 'password123' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates email format and password length', async () => {
    const bad = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const short = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'ok@example.com', password: 'short' });
    expect(short.status).toBe(400);
  });

  it('logs in with correct credentials, rejects wrong ones with one generic message', async () => {
    await signup();
    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401);

    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'password123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message); // no enumeration
  });

  it('rejects unauthenticated requests to every protected endpoint', async () => {
    for (const [method, path] of [
      ['post', '/api/jobs'],
      ['get', '/api/jobs'],
      ['get', '/api/jobs/000000000000000000000000'],
      ['post', '/api/jobs/000000000000000000000000/retry'],
      ['get', '/api/jobs/000000000000000000000000/image'],
      ['get', '/api/notifications'],
      ['post', '/api/notifications/read'],
      ['get', '/api/auth/me'],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('upload validation (spec: enforce at the API layer)', () => {
  it('accepts a PNG and returns the pending job immediately with the queue notified', async () => {
    const token = await signup();
    const res = await uploadPng(token);

    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('pending');
    expect(res.body.job.id).toBeTruthy();
    expect(res.body.job.file.mime).toBe('image/png');
    expect(enqueueProcessingJob).toHaveBeenCalledExactlyOnceWith(res.body.job.id);
  });

  it('accepts JPG and WEBP too', async () => {
    const token = await signup();
    const jpg = await request(app)
      .post('/api/jobs')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fakeJpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(jpg.status).toBe(201);

    const webp = await request(app)
      .post('/api/jobs')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fakeWebp(), { filename: 'photo.webp', contentType: 'image/webp' });
    expect(webp.status).toBe(201);
  });

  it('rejects disallowed MIME types with a clear error', async () => {
    const token = await signup();
    const res = await request(app)
      .post('/api/jobs')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('GIF89a...'), { filename: 'anim.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.body.error.message).toContain('JPG, PNG, WEBP');
  });

  it('rejects content that is not really an image, even with a valid MIME + extension', async () => {
    const token = await signup();
    const res = await uploadPng(token, 'sneaky.png', Buffer.from('plain text pretending'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_CONTENT');
    expect(enqueueProcessingJob).not.toHaveBeenCalled();
  });

  it('rejects files over 5MB with 413', async () => {
    const token = await signup();
    const res = await uploadPng(token, 'huge.png', fakePng(5 * 1024 * 1024 + 1024));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects a missing file part', async () => {
    const token = await signup();
    const res = await request(app).post('/api/jobs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });

  it('marks the job failed-but-retryable when enqueueing fails (file already durable, D-018)', async () => {
    const token = await signup();
    vi.mocked(enqueueProcessingJob).mockRejectedValueOnce(new Error('redis down'));

    const res = await uploadPng(token);
    expect(res.status).toBe(201); // not a 500 — the upload itself succeeded
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.error.code).toBe('QUEUE_ENQUEUE_FAILED');
    expect(res.body.job.error.retryable).toBe(true);
  });
});

describe('jobs list & detail', () => {
  it('lists own jobs newest-first with activeCount for poll control', async () => {
    const token = await signup();
    await uploadPng(token, 'first.png');
    await uploadPng(token, 'second.png');

    const res = await request(app).get('/api/jobs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.jobs[0].file.originalName).toBe('second.png');
    expect(res.body.total).toBe(2);
    expect(res.body.activeCount).toBe(2); // both still pending
  });

  it('filters by status and flagged', async () => {
    const token = await signup();
    const upload = await uploadPng(token);
    await Job.updateOne(
      { _id: upload.body.job.id },
      { status: 'completed', flagged: true, flaggedCategories: ['adult'] },
    );
    await uploadPng(token, 'pending.png');

    const flagged = await request(app)
      .get('/api/jobs?flagged=true')
      .set('Authorization', `Bearer ${token}`);
    expect(flagged.body.jobs).toHaveLength(1);
    expect(flagged.body.jobs[0].flagged).toBe(true);

    const completed = await request(app)
      .get('/api/jobs?status=completed')
      .set('Authorization', `Bearer ${token}`);
    expect(completed.body.jobs).toHaveLength(1);
  });

  it('returns full step detail for an owned job', async () => {
    const token = await signup();
    const upload = await uploadPng(token);

    const res = await request(app)
      .get(`/api/jobs/${upload.body.job.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.job.steps.caption.status).toBe('pending');
    expect(res.body.job.steps.labels.status).toBe('pending');
    expect(res.body.job.steps.safety.status).toBe('pending');
  });

  it("hides other users' jobs (404, not 403 — no existence leak)", async () => {
    const tokenA = await signup('a@example.com');
    const tokenB = await signup('b@example.com');
    const upload = await uploadPng(tokenA);

    const res = await request(app)
      .get(`/api/jobs/${upload.body.job.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('404s malformed job ids instead of 500ing', async () => {
    const token = await signup();
    const res = await request(app)
      .get('/api/jobs/definitely-not-an-objectid')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('serves the stored image bytes back to the owner only', async () => {
    const token = await signup();
    const bytes = fakePng(256);
    const upload = await uploadPng(token, 'mine.png', bytes);

    const res = await request(app)
      .get(`/api/jobs/${upload.body.job.id}/image`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);

    const tokenB = await signup('b@example.com');
    const forbidden = await request(app)
      .get(`/api/jobs/${upload.body.job.id}/image`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(forbidden.status).toBe(404);
  });
});

describe('manual retry endpoint', () => {
  it('rejects retry for non-failed jobs with 409', async () => {
    const token = await signup();
    const upload = await uploadPng(token);

    const res = await request(app)
      .post(`/api/jobs/${upload.body.job.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JOB_NOT_RETRYABLE');
  });

  it('resets only non-completed steps, clears the error, re-enqueues (checkpoint resume)', async () => {
    const token = await signup();
    const upload = await uploadPng(token);
    const jobId = upload.body.job.id as string;

    // Simulate: caption succeeded, labels failed, job failed after retries.
    await Job.updateOne(
      { _id: jobId },
      {
        status: 'failed',
        attemptsMade: 3,
        error: { message: 'labels blew up', code: 'TEST', retryable: true },
        'steps.caption': {
          status: 'completed',
          attempts: 1,
          text: 'already captioned',
          durationMs: 42,
        },
        'steps.labels': { status: 'failed', attempts: 3, error: 'labels blew up' },
      },
    );
    vi.mocked(enqueueProcessingJob).mockClear();

    const res = await request(app)
      .post(`/api/jobs/${jobId}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('pending');
    expect(res.body.job.error).toBeNull();
    expect(res.body.job.manualRetries).toBe(1);
    expect(enqueueProcessingJob).toHaveBeenCalledExactlyOnceWith(jobId);

    const doc = (await Job.findById(jobId))!;
    expect(doc.attemptsMade).toBe(0); // fresh budget
    expect(doc.steps.caption.status).toBe('completed'); // kept — will be skipped by the pipeline
    expect(doc.steps.caption.text).toBe('already captioned');
    expect(doc.steps.labels.status).toBe('pending'); // reset
    expect(doc.steps.labels.error).toBeFalsy();
  });
});

describe('notifications', () => {
  it('lists notifications with unread count and marks them read', async () => {
    const token = await signup();
    const user = (await User.findOne({ email: 'user@example.com' }))!;
    const upload = await uploadPng(token);

    await Notification.create([
      { userId: user._id, jobId: upload.body.job.id, type: 'job_flagged', message: 'flagged!' },
      {
        userId: user._id,
        jobId: upload.body.job.id,
        type: 'job_failed',
        message: 'failed!',
        read: true,
      },
    ]);

    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.notifications).toHaveLength(2);
    expect(list.body.unreadCount).toBe(1);

    const markAll = await request(app)
      .post('/api/notifications/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ all: true });
    expect(markAll.status).toBe(200);

    const after = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.unreadCount).toBe(0);
  });
});

describe('health & misc', () => {
  it('reports health without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mongo: true, redis: true });
  });

  it('404s unknown API routes in the uniform error shape', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
