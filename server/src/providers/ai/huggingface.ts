import { AiProviderError } from './errors';
import type { CaptionResult, ImageInput } from './types';

export interface HfConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

/**
 * Image captioning via the Hugging Face Inference API (BLIP by default; the exact
 * model/endpoint is configurable via HF_CAPTION_URL since serverless availability shifts).
 *
 * The famous failure mode: a cold model returns 503 + `estimated_time` while it loads.
 * That is classified retryable — BullMQ's exponential backoff (D-009) rides it out.
 */
export async function hfCaption(input: ImageInput, cfg: HfConfig): Promise<CaptionResult> {
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': input.mime,
      },
      body: new Uint8Array(input.data),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new AiProviderError(`Hugging Face request failed: ${(err as Error).message}`, {
      retryable: true,
      code: 'HF_NETWORK',
      provider: 'huggingface',
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 300);

    if (res.status === 503) {
      throw new AiProviderError(`Hugging Face model is cold-starting (503): ${snippet}`, {
        retryable: true,
        code: 'HF_MODEL_LOADING',
        provider: 'huggingface',
        status: 503,
      });
    }
    if (res.status === 429) {
      throw new AiProviderError('Hugging Face rate limit hit (429)', {
        retryable: true,
        code: 'HF_RATE_LIMITED',
        provider: 'huggingface',
        status: 429,
      });
    }
    if (res.status >= 500) {
      throw new AiProviderError(`Hugging Face server error (${res.status}): ${snippet}`, {
        retryable: true,
        code: 'HF_SERVER_ERROR',
        provider: 'huggingface',
        status: res.status,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new AiProviderError('Hugging Face auth failed — check HF_TOKEN', {
        retryable: false,
        code: 'HF_AUTH_FAILED',
        provider: 'huggingface',
        status: res.status,
      });
    }
    if (res.status === 404 || res.status === 410) {
      throw new AiProviderError(
        'Caption model not available on the inference endpoint — set HF_CAPTION_URL to a hosted model',
        { retryable: false, code: 'HF_MODEL_UNAVAILABLE', provider: 'huggingface', status: res.status },
      );
    }
    throw new AiProviderError(`Hugging Face request rejected (${res.status}): ${snippet}`, {
      retryable: false,
      code: 'HF_BAD_REQUEST',
      provider: 'huggingface',
      status: res.status,
    });
  }

  const json: unknown = await res.json().catch(() => null);
  // BLIP-style image-to-text responds `[{ "generated_text": "..." }]`; be lenient about shape.
  const text =
    Array.isArray(json) && typeof (json[0] as { generated_text?: unknown })?.generated_text === 'string'
      ? ((json[0] as { generated_text: string }).generated_text)
      : typeof (json as { generated_text?: unknown })?.generated_text === 'string'
        ? (json as { generated_text: string }).generated_text
        : null;

  if (!text?.trim()) {
    throw new AiProviderError(
      `Unexpected Hugging Face response shape: ${JSON.stringify(json)?.slice(0, 300)}`,
      { retryable: false, code: 'HF_UNEXPECTED_RESPONSE', provider: 'huggingface' },
    );
  }

  return { text: text.trim() };
}
