import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageNotFoundError, type StorageAdapter } from './types';

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Works against any S3-compatible endpoint: GCS (HMAC interop), R2, B2, MinIO. (D-003) */
export function createS3Storage(cfg: S3StorageConfig): StorageAdapter {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });

  return {
    async put(key, data) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: data }));
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        if (!res.Body) throw new StorageNotFoundError(key);
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'NoSuchKey' || name === 'NotFound') throw new StorageNotFoundError(key);
        throw err;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}
