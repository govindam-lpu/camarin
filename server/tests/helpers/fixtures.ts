import mongoose from 'mongoose';
import { Job, type JobDoc, type JobShape } from '../../src/models/Job';
import { User, type UserDoc } from '../../src/models/User';
import type {
  AiProvider,
  SafetyLikelihoods,
} from '../../src/providers/ai/types';
import type { StorageAdapter } from '../../src/providers/storage/types';
import { StorageNotFoundError } from '../../src/providers/storage/types';

/* ── Image byte fixtures ─────────────────────────────────────────────────────
 * Valid magic bytes followed by junk — enough for the sniffer (we never decode). */

export function fakePng(size = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8), 1),
  ]);
}

export function fakeJpeg(size = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(Math.max(0, size - 4), 1),
  ]);
}

export function fakeWebp(size = 64): Buffer {
  const body = Buffer.alloc(Math.max(0, size - 12), 1);
  const riff = Buffer.from('RIFF');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length + 4);
  return Buffer.concat([riff, len, Buffer.from('WEBP'), body]);
}

/* ── In-memory fakes for injected dependencies ──────────────────────────── */

export function fakeStorage(initial?: Record<string, Buffer>): StorageAdapter & {
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>(Object.entries(initial ?? {}));
  return {
    files,
    async put(key, data) {
      files.set(key, data);
    },
    async get(key) {
      const hit = files.get(key);
      if (!hit) throw new StorageNotFoundError(key);
      return hit;
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

export const SAFE_LIKELIHOODS: SafetyLikelihoods = {
  adult: 'VERY_UNLIKELY',
  spoof: 'VERY_UNLIKELY',
  medical: 'VERY_UNLIKELY',
  violence: 'VERY_UNLIKELY',
  racy: 'VERY_UNLIKELY',
};

/** Happy-path provider with per-method call counters; override any method per test. */
export function fakeProvider(overrides?: Partial<AiProvider>): AiProvider & {
  calls: { caption: number; detectLabels: number; checkSafety: number };
} {
  const calls = { caption: 0, detectLabels: 0, checkSafety: 0 };
  return {
    name: 'fake',
    calls,
    async caption(input) {
      calls.caption += 1;
      if (overrides?.caption) return overrides.caption(input);
      return { text: 'a test caption' };
    },
    async detectLabels(input) {
      calls.detectLabels += 1;
      if (overrides?.detectLabels) return overrides.detectLabels(input);
      return { items: [{ name: 'Thing', score: 0.9 }] };
    },
    async checkSafety(input) {
      calls.checkSafety += 1;
      if (overrides?.checkSafety) return overrides.checkSafety(input);
      return { likelihoods: { ...SAFE_LIKELIHOODS } };
    },
  };
}

/* ── Document factories ─────────────────────────────────────────────────── */

export async function createTestUser(email = 'worker-tests@example.com'): Promise<UserDoc> {
  return User.create({ email, passwordHash: 'x'.repeat(60) });
}

export async function createTestJob(
  userId: mongoose.Types.ObjectId,
  overrides: Partial<Omit<JobShape, 'file'>> & { filename?: string } = {},
): Promise<JobDoc> {
  const { filename, ...rest } = overrides;
  const id = new mongoose.Types.ObjectId();
  return Job.create({
    _id: id,
    userId,
    status: 'pending',
    file: {
      originalName: filename ?? 'photo.png',
      mime: 'image/png',
      size: 64,
      storageKey: `jobs/${id.toHexString()}.png`,
    },
    queuedAt: new Date(),
    ...rest,
  });
}
