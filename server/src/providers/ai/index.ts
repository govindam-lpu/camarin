import { env } from '../../config/env';
import { gcvCheckSafety, gcvDetectLabels, type GcvConfig } from './googleVision';
import { hfCaption, type HfConfig } from './huggingface';
import { createMockProvider } from './mock';
import type { AiProvider } from './types';

function createRealProvider(): AiProvider {
  // Config presence is validated at boot by the env schema (fail fast).
  const hf: HfConfig = {
    url: env.HF_CAPTION_URL,
    model: env.HF_CAPTION_MODEL,
    token: env.HF_TOKEN!,
    timeoutMs: env.AI_TIMEOUT_MS,
  };
  const gcv: GcvConfig = {
    endpoint: env.GCV_ENDPOINT,
    apiKey: env.GCV_API_KEY!,
    timeoutMs: env.AI_TIMEOUT_MS,
  };

  return {
    name: 'real (huggingface + google-vision)',
    caption: (input) => hfCaption(input, hf),
    detectLabels: (input) => gcvDetectLabels(input, gcv),
    checkSafety: (input) => gcvCheckSafety(input, gcv),
  };
}

export function getAiProvider(): AiProvider {
  return env.AI_PROVIDER === 'real' ? createRealProvider() : createMockProvider();
}

export * from './types';
export { AiProviderError, describeError, isRetryableError } from './errors';
