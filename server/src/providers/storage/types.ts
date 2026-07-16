/**
 * Storage abstraction (D-003): `local` disk for docker-compose (api & worker share a
 * volume), `s3` for any S3-compatible endpoint in production (GCS HMAC / R2 / B2 / MinIO).
 *
 * Buffers, not streams, by design: files are capped at 5MB and the AI providers need
 * whole buffers anyway (base64 / raw body). (D-014)
 */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found in storage: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}
