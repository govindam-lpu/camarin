import { AiProviderError } from './errors';
import type { CaptionResult, ImageInput } from './types';

export interface HfConfig {
  /** OpenAI-compatible chat completions endpoint on the HF router. */
  url: string;
  /** A hosted vision-language model id (see README: Assumptions & decisions). */
  model: string;
  token: string;
  timeoutMs: number;
}

const CAPTION_PROMPT =
  'Describe this image in one concise sentence, like an image caption. Respond with the caption only — no preamble, no quotes.';

/**
 * Image captioning via Hugging Face Inference (router).
 *
 * History (D-023): the spec suggested Salesforce/blip-image-captioning-base on the
 * classic serverless API — HF has since retired task-specific image-to-text serving
 * entirely (verified empirically: zero image-to-text models on hf-inference). The
 * current HF surface for captioning is a vision LLM through the router's
 * chat-completions API: same token, same free tier, provider-agnostic model routing.
 * This swap cost ~30 lines behind the provider seam (D-004) — which is why it exists.
 */
export async function hfCaption(input: ImageInput, cfg: HfConfig): Promise<CaptionResult> {
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${input.mime};base64,${input.data.toString('base64')}` },
              },
              { type: 'text', text: CAPTION_PROMPT },
            ],
          },
        ],
        max_tokens: 60,
        temperature: 0.2,
      }),
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
      throw new AiProviderError(`Hugging Face model unavailable/cold (503): ${snippet}`, {
        retryable: true,
        code: 'HF_MODEL_LOADING',
        provider: 'huggingface',
        status: 503,
      });
    }
    if (res.status === 429) {
      throw new AiProviderError('Hugging Face rate limit / credits exhausted (429)', {
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
    if (res.status === 404 || /model/i.test(snippet)) {
      throw new AiProviderError(
        `Caption model "${cfg.model}" not served right now — set HF_CAPTION_MODEL to a hosted vision model (${snippet})`,
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

  const json = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const raw = json?.choices?.[0]?.message?.content;
  const text =
    typeof raw === 'string'
      ? raw
          .trim()
          .replace(/^["'“]+|["'”]+$/g, '') // models love wrapping captions in quotes
          .replace(/\s+/g, ' ')
      : null;

  if (!text) {
    throw new AiProviderError(
      `Unexpected Hugging Face response shape: ${JSON.stringify(json)?.slice(0, 300)}`,
      { retryable: false, code: 'HF_UNEXPECTED_RESPONSE', provider: 'huggingface' },
    );
  }

  return { text };
}
