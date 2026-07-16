import { createHash } from 'node:crypto';
import { env } from '../../config/env';
import { SAFETY_CATEGORIES } from '../../models/Job';
import { AiProviderError } from './errors';
import type { AiProvider, ImageInput, SafetyLikelihoods } from './types';

/**
 * Deterministic fake provider (D-004): `docker compose up` works with zero API keys,
 * and unit tests get stable outputs with no network.
 *
 * Demo hooks by filename (D-005, documented in README):
 *   flagme* -> SafeSearch returns LIKELY adult  (flagged path + notification)
 *   failme* -> always-failing transient error   (retry exhaustion -> failed -> manual Retry)
 *   flaky*  -> fails attempt 1, succeeds after  (automatic retry with backoff)
 *   badreq* -> permanent error                  (fail-fast, no retries burned)
 */

const CAPTIONS = [
  'a scenic mountain landscape at golden hour with a winding trail',
  'a person working on a laptop at a wooden desk near a window',
  'a plate of fresh food photographed from above on a marble counter',
  'a city street at dusk with light trails from passing cars',
  'a close-up of a flower with soft bokeh in the background',
];

const LABEL_SETS = [
  [
    { name: 'Nature', score: 0.97 },
    { name: 'Mountain', score: 0.94 },
    { name: 'Sky', score: 0.91 },
    { name: 'Landscape', score: 0.88 },
    { name: 'Outdoor', score: 0.82 },
  ],
  [
    { name: 'Person', score: 0.96 },
    { name: 'Computer', score: 0.93 },
    { name: 'Desk', score: 0.89 },
    { name: 'Indoor', score: 0.85 },
    { name: 'Technology', score: 0.78 },
  ],
  [
    { name: 'Food', score: 0.98 },
    { name: 'Plate', score: 0.92 },
    { name: 'Cuisine', score: 0.9 },
    { name: 'Ingredient', score: 0.83 },
    { name: 'Tableware', score: 0.76 },
  ],
  [
    { name: 'Street', score: 0.95 },
    { name: 'City', score: 0.93 },
    { name: 'Vehicle', score: 0.87 },
    { name: 'Night', score: 0.84 },
    { name: 'Architecture', score: 0.8 },
  ],
];

/** Stable per-filename pick so re-runs of the same upload agree. */
function pick<T>(arr: readonly T[], seed: string): T {
  const n = createHash('sha1').update(seed).digest().readUInt32BE(0);
  return arr[n % arr.length]!;
}

function simulateLatency(): Promise<void> {
  if (env.MOCK_DELAY_MS <= 0) return Promise.resolve();
  // Small jitter so parallel jobs visibly interleave in the UI.
  const ms = env.MOCK_DELAY_MS / 2 + Math.random() * env.MOCK_DELAY_MS;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyFailureHooks(input: ImageInput): void {
  const name = input.filename.toLowerCase();
  if (name.includes('failme')) {
    throw new AiProviderError('Mock transient failure (filename contains "failme")', {
      retryable: true,
      code: 'MOCK_TRANSIENT_FAILURE',
      provider: 'mock',
    });
  }
  if (name.includes('badreq')) {
    throw new AiProviderError('Mock permanent failure (filename contains "badreq")', {
      retryable: false,
      code: 'MOCK_PERMANENT_FAILURE',
      provider: 'mock',
    });
  }
  if (name.includes('flaky') && input.attempt <= 1) {
    throw new AiProviderError('Mock flaky failure — succeeds on the next attempt', {
      retryable: true,
      code: 'MOCK_FLAKY_FAILURE',
      provider: 'mock',
    });
  }
}

export function createMockProvider(): AiProvider {
  return {
    name: 'mock',

    async caption(input) {
      await simulateLatency();
      applyFailureHooks(input); // hooks fire on the first step so failures demo early
      return { text: pick(CAPTIONS, input.filename) };
    },

    async detectLabels(input) {
      await simulateLatency();
      return { items: pick(LABEL_SETS, input.filename) };
    },

    async checkSafety(input) {
      await simulateLatency();
      const likelihoods = Object.fromEntries(
        SAFETY_CATEGORIES.map((c) => [c, 'VERY_UNLIKELY']),
      ) as SafetyLikelihoods;

      if (input.filename.toLowerCase().includes('flagme')) {
        likelihoods.adult = 'LIKELY';
        likelihoods.racy = 'POSSIBLE'; // POSSIBLE alone must NOT flag (D-012) — good demo data
      }
      return { likelihoods };
    },
  };
}
