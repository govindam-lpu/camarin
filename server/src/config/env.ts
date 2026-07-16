import { existsSync } from 'node:fs';
import { z } from 'zod';

// Native .env loading (Node >= 20.6) — no dotenv dependency needed.
// Checks server/.env first, then the repo root .env (compose passes real env vars instead).
for (const candidate of ['.env', '../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

/** Treat empty strings from .env templates ("KEY=") as absent. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const booleanString = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    JWT_SECRET: z.string().min(1).default('change-me-in-production'),
    JWT_EXPIRES_IN: z.string().default('24h'),

    MONGO_URI: z.string().default('mongodb://localhost:27017/mediapipeline'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    MAX_FILE_SIZE_MB: z.coerce.number().positive().default(5),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_DIR: z.string().default('./data/uploads'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: booleanString,

    AI_PROVIDER: z.enum(['mock', 'real']).default('mock'),
    HF_TOKEN: optionalString,
    HF_CAPTION_URL: z.string().default('https://router.huggingface.co/v1/chat/completions'),
    HF_CAPTION_MODEL: z.string().default('google/gemma-3-4b-it'),
    GCV_API_KEY: optionalString,
    GCV_ENDPOINT: z.string().default('https://vision.googleapis.com/v1/images:annotate'),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
    JOB_BACKOFF_MS: z.coerce.number().int().positive().default(3000),
    MOCK_DELAY_MS: z.coerce.number().int().nonnegative().default(900),

    LOG_LEVEL: z.string().default('info'),
    /** Directory of the built SPA; served statically when present. */
    PUBLIC_DIR: optionalString,
  })
  .superRefine((cfg, ctx) => {
    // Fail fast on configs that would only blow up later, at request/process time.
    if (cfg.NODE_ENV === 'production' && cfg.JWT_SECRET === 'change-me-in-production') {
      ctx.addIssue({ code: 'custom', message: 'JWT_SECRET must be set to a real secret in production' });
    }
    if (cfg.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: 'custom', message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
    if (cfg.AI_PROVIDER === 'real') {
      if (!cfg.HF_TOKEN) ctx.addIssue({ code: 'custom', message: 'HF_TOKEN is required when AI_PROVIDER=real' });
      if (!cfg.GCV_API_KEY) ctx.addIssue({ code: 'custom', message: 'GCV_API_KEY is required when AI_PROVIDER=real' });
    }
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Logger isn't constructed yet (it depends on this module) — console is correct here.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  // eslint-disable-next-line no-console
  for (const issue of parsed.error.issues) console.error(`  - ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const MAX_FILE_SIZE_BYTES = Math.floor(env.MAX_FILE_SIZE_MB * 1024 * 1024);
