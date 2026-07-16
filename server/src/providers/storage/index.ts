import { env } from '../../config/env';
import { createLocalStorage } from './local';
import { createS3Storage } from './s3';
import type { StorageAdapter } from './types';

let storage: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (!storage) {
    storage =
      env.STORAGE_DRIVER === 's3'
        ? createS3Storage({
            endpoint: env.S3_ENDPOINT!,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET!,
            accessKeyId: env.S3_ACCESS_KEY_ID!,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
          })
        : createLocalStorage(env.LOCAL_STORAGE_DIR);
  }
  return storage;
}

export { StorageNotFoundError, type StorageAdapter } from './types';
