import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageNotFoundError, type StorageAdapter } from './types';

export function createLocalStorage(baseDir: string): StorageAdapter {
  const resolvedBase = path.resolve(baseDir);

  // Keys are server-generated (`jobs/<objectId>.<ext>`), but defense-in-depth costs 3 lines.
  const resolveKey = (key: string): string => {
    const full = path.resolve(resolvedBase, key);
    if (full !== resolvedBase && !full.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Storage key escapes base directory: ${key}`);
    }
    return full;
  };

  return {
    async put(key, data) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, data);
    },

    async get(key) {
      try {
        return await fs.readFile(resolveKey(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageNotFoundError(key);
        throw err;
      }
    },

    async delete(key) {
      await fs.rm(resolveKey(key), { force: true });
    },
  };
}
