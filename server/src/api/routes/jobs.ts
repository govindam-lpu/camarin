import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { isTest, MAX_FILE_SIZE_BYTES } from '../../config/env';
import { ApiError } from '../../lib/errors';
import { ALLOWED_MIME_TYPES, sniffImage } from '../../lib/imageSniff';
import { logger } from '../../lib/logger';
import { Job, JOB_STATUSES, PIPELINE_STEPS, type JobDoc } from '../../models/Job';
import { getStorage, StorageNotFoundError } from '../../providers/storage';
import { enqueueProcessingJob } from '../../queue';
import { serializeJobDetail, serializeJobSummary } from '../serializers';
import { requireAuth } from '../middleware/auth';

const router: Router = Router();
router.use(requireAuth);

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads, try again later' } },
});

/**
 * Upload validation, gate 1 & 2 of three (D-015):
 *  - multer fileSize limit -> 413 FILE_TOO_LARGE (spec: enforce 5MB at the API layer)
 *  - MIME whitelist -> 400 UNSUPPORTED_MEDIA_TYPE
 * Gate 3 (magic-byte content sniff) runs in the handler, where the buffer exists.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        ApiError.badRequest(
          'UNSUPPORTED_MEDIA_TYPE',
          `Unsupported file type "${file.mimetype}" — allowed: JPG, PNG, WEBP`,
        ),
      );
    }
  },
});

/** Multer decodes non-ASCII original filenames as latin1; fix the mojibake. */
function decodeOriginalName(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf8');
}

async function loadOwnedJob(req: Request): Promise<JobDoc> {
  const id = req.params.id!;
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Job not found');
  const job = await Job.findOne({ _id: id, userId: req.user!._id });
  if (!job) throw ApiError.notFound('Job not found');
  return job;
}

/**
 * POST /api/jobs — upload an image, get a job ID back immediately (never blocks on AI).
 * Order: store file -> create job (pending) -> enqueue -> 201.
 * An enqueue failure (Redis blip) marks the job failed-but-retryable instead of 500ing:
 * the file is already durable, so the UI Retry button is the recovery path. (D-018)
 */
router.post('/', uploadLimiter, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) throw ApiError.badRequest('NO_FILE', 'Attach an image in the "file" form field');

  const sniffed = sniffImage(file.buffer);
  if (!sniffed) {
    throw ApiError.badRequest(
      'INVALID_IMAGE_CONTENT',
      'File content is not a valid JPG, PNG, or WEBP image (renamed file?)',
    );
  }

  const jobId = new mongoose.Types.ObjectId();
  const storageKey = `jobs/${jobId.toHexString()}.${sniffed.ext}`;

  await getStorage().put(storageKey, file.buffer);

  const job = await Job.create({
    _id: jobId,
    userId: req.user!._id,
    status: 'pending',
    file: {
      originalName: decodeOriginalName(file.originalname),
      mime: sniffed.mime,
      size: file.size,
      storageKey,
    },
    queuedAt: new Date(),
  });

  try {
    await enqueueProcessingJob(job.id);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'failed to enqueue job');
    job.status = 'failed';
    job.set('error', {
      message: 'Could not queue the job for processing — use Retry',
      code: 'QUEUE_ENQUEUE_FAILED',
      retryable: true,
    });
    await job.save();
  }

  res.status(201).json({ job: serializeJobSummary(job) });
});

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  flagged: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** GET /api/jobs — the user's jobs, newest first. */
router.get('/', async (req, res) => {
  const { status, flagged, page, limit } = listQuerySchema.parse(req.query);

  const filter: Record<string, unknown> = { userId: req.user!._id };
  if (status) filter.status = status;
  if (flagged) filter.flagged = flagged === 'true';

  const [jobs, total, activeCount] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Job.countDocuments(filter),
    // Across ALL the user's jobs (not just this filter/page): lets the client decide
    // whether to keep polling without a second request. (D-006)
    Job.countDocuments({ userId: req.user!._id, status: { $in: ['pending', 'processing'] } }),
  ]);

  res.json({
    jobs: jobs.map(serializeJobSummary),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    activeCount,
  });
});

/** GET /api/jobs/:id — full results (caption, labels, safety, per-step telemetry). */
router.get('/:id', async (req, res) => {
  const job = await loadOwnedJob(req);
  res.json({ job: serializeJobDetail(job) });
});

/**
 * POST /api/jobs/:id/retry — manual retry of a failed job with a fresh attempt budget.
 * Completed steps keep their results (checkpoint resume, D-008); failed/pending steps reset.
 */
router.post('/:id/retry', async (req, res) => {
  const job = await loadOwnedJob(req);

  if (job.status !== 'failed') {
    throw ApiError.conflict(
      'JOB_NOT_RETRYABLE',
      `Only failed jobs can be retried (current status: ${job.status})`,
    );
  }

  for (const name of PIPELINE_STEPS) {
    const step = job.steps[name];
    if (step.status !== 'completed') {
      step.status = 'pending';
      step.error = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.durationMs = undefined;
      // step.attempts is cumulative across retries on purpose — it's telemetry.
    }
  }

  job.status = 'pending';
  job.set('error', undefined);
  job.attemptsMade = 0;
  job.manualRetries += 1;
  job.queuedAt = new Date();
  job.completedAt = undefined;
  await job.save();

  try {
    await enqueueProcessingJob(job.id);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'failed to re-enqueue job on retry');
    job.status = 'failed';
    job.set('error', {
      message: 'Could not queue the job for processing — use Retry',
      code: 'QUEUE_ENQUEUE_FAILED',
      retryable: true,
    });
    await job.save();
  }

  res.json({ job: serializeJobSummary(job) });
});

/**
 * GET /api/jobs/:id/image — authenticated byte stream (D-013). The SPA fetches this
 * with the Bearer header and renders a blob URL (an <img src> can't carry auth headers).
 */
router.get('/:id/image', async (req, res) => {
  const job = await loadOwnedJob(req);

  let data: Buffer;
  try {
    data = await getStorage().get(job.file.storageKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw ApiError.notFound('Stored file is missing');
    }
    throw err;
  }

  res.setHeader('Content-Type', job.file.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(data);
});

export default router;
