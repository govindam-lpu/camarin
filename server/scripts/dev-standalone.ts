/**
 * Standalone dev harness: boots the API against an IN-MEMORY MongoDB so the UI can be
 * developed with zero local infrastructure (no Docker, no Redis, nothing persisted).
 *
 * Without Redis, uploads still work — enqueueing times out and the job degrades to
 * failed-but-retryable (D-018), which is itself a useful state to develop against.
 * For the full pipeline use `docker compose up`.
 *
 *   npx tsx scripts/dev-standalone.ts
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();
process.env.NODE_ENV ??= 'development';

// Imported only after MONGO_URI is set — the env schema reads it at import time.
await import('../src/api/index');
