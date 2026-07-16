import { LIKELIHOODS, SAFETY_CATEGORIES, type Likelihood } from '../../models/Job';
import { AiProviderError } from './errors';
import type { ImageInput, LabelsResult, SafetyLikelihoods, SafetyResult } from './types';

export interface GcvConfig {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * Google Cloud Vision via plain REST + API key — no service-account JSON to mount
 * into containers, one env var for reviewers to obtain (D-004).
 */

interface GcvAnnotateResponse {
  responses?: Array<{
    labelAnnotations?: Array<{ description?: string; score?: number }>;
    safeSearchAnnotation?: Partial<Record<string, string>>;
    error?: { code?: number; message?: string };
  }>;
}

// google.rpc.Code values that are worth retrying.
const RETRYABLE_RPC_CODES = new Set([
  4, // DEADLINE_EXCEEDED
  8, // RESOURCE_EXHAUSTED
  13, // INTERNAL
  14, // UNAVAILABLE
]);

async function annotate(
  input: ImageInput,
  features: Array<{ type: string; maxResults?: number }>,
  cfg: GcvConfig,
): Promise<NonNullable<GcvAnnotateResponse['responses']>[number]> {
  let res: Response;
  try {
    res = await fetch(`${cfg.endpoint}?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: input.data.toString('base64') }, features }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new AiProviderError(`Google Vision request failed: ${(err as Error).message}`, {
      retryable: true,
      code: 'GCV_NETWORK',
      provider: 'google-vision',
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 300);

    if (res.status === 429) {
      throw new AiProviderError('Google Vision rate limit / quota hit (429)', {
        retryable: true,
        code: 'GCV_RATE_LIMITED',
        provider: 'google-vision',
        status: 429,
      });
    }
    if (res.status >= 500) {
      throw new AiProviderError(`Google Vision server error (${res.status})`, {
        retryable: true,
        code: 'GCV_SERVER_ERROR',
        provider: 'google-vision',
        status: res.status,
      });
    }
    if (res.status === 403) {
      throw new AiProviderError(
        'Google Vision rejected the request (403) — is the API key valid and the Cloud Vision API enabled?',
        { retryable: false, code: 'GCV_FORBIDDEN', provider: 'google-vision', status: 403 },
      );
    }
    throw new AiProviderError(`Google Vision request rejected (${res.status}): ${snippet}`, {
      retryable: false,
      code: 'GCV_BAD_REQUEST',
      provider: 'google-vision',
      status: res.status,
    });
  }

  const json = (await res.json().catch(() => null)) as GcvAnnotateResponse | null;
  const first = json?.responses?.[0];
  if (!first) {
    throw new AiProviderError('Google Vision returned an empty response', {
      retryable: false,
      code: 'GCV_UNEXPECTED_RESPONSE',
      provider: 'google-vision',
    });
  }

  if (first.error) {
    const rpcCode = first.error.code ?? -1;
    throw new AiProviderError(`Google Vision annotation error: ${first.error.message ?? 'unknown'}`, {
      retryable: RETRYABLE_RPC_CODES.has(rpcCode),
      code: 'GCV_ANNOTATION_ERROR',
      provider: 'google-vision',
    });
  }

  return first;
}

export async function gcvDetectLabels(input: ImageInput, cfg: GcvConfig): Promise<LabelsResult> {
  const res = await annotate(input, [{ type: 'LABEL_DETECTION', maxResults: 10 }], cfg);
  const items = (res.labelAnnotations ?? [])
    .filter((l) => typeof l.description === 'string')
    .map((l) => ({ name: l.description!, score: Math.round((l.score ?? 0) * 1000) / 1000 }));
  return { items };
}

function normalizeLikelihood(value: string | undefined): Likelihood {
  return (LIKELIHOODS as readonly string[]).includes(value ?? '')
    ? (value as Likelihood)
    : 'UNKNOWN';
}

export async function gcvCheckSafety(input: ImageInput, cfg: GcvConfig): Promise<SafetyResult> {
  const res = await annotate(input, [{ type: 'SAFE_SEARCH_DETECTION' }], cfg);
  const annotation = res.safeSearchAnnotation;
  if (!annotation) {
    throw new AiProviderError('Google Vision returned no SafeSearch annotation', {
      retryable: false,
      code: 'GCV_UNEXPECTED_RESPONSE',
      provider: 'google-vision',
    });
  }

  const likelihoods = Object.fromEntries(
    SAFETY_CATEGORIES.map((c) => [c, normalizeLikelihood(annotation[c])]),
  ) as SafetyLikelihoods;

  return { likelihoods };
}
