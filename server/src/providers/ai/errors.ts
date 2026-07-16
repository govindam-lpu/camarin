import { StorageNotFoundError } from '../storage/types';

/**
 * Typed provider failure carrying the retry decision (D-009).
 * Retryable: rate limits, 5xx, network faults, HF cold starts.
 * Permanent: bad credentials, missing models, malformed requests.
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  readonly provider: string;
  readonly status?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; code: string; provider: string; status?: number },
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = opts.retryable;
    this.code = opts.code;
    this.provider = opts.provider;
    this.status = opts.status;
  }
}

/**
 * Central retry classification. Unknown errors default to retryable: transient until
 * proven otherwise — a genuine bug still exhausts its attempts and fails cleanly,
 * while a mis-classified transient would fail user jobs needlessly.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AiProviderError) return err.retryable;
  if (err instanceof StorageNotFoundError) return false; // a missing file won't reappear
  return true;
}

/** Normalize any pipeline error into what the Job document records. */
export function describeError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof AiProviderError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof StorageNotFoundError) {
    return { code: 'FILE_MISSING', message: err.message, retryable: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNKNOWN', message, retryable: true };
}
