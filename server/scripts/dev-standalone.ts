/**
 * Standalone dev harness (D-021): the FULL product with zero infrastructure —
 * no Docker, no Redis, nothing persisted.
 *
 *  - MongoDB:  in-memory (mongodb-memory-server)
 *  - Queue:    QUEUE_DRIVER=inline — the real worker pipeline runs in-process
 *  - AI:       mock provider unless AI_PROVIDER=real is set (demo filenames work:
 *              flagme / flaky / failme / badreq)
 *
 * Pair with the Vite dev server for the UI:  cd web && npm run dev
 *
 *   npx tsx scripts/dev-standalone.ts
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();
process.env.NODE_ENV ??= 'development';
process.env.QUEUE_DRIVER ??= 'inline';
process.env.AI_PROVIDER ??= 'mock';

// Imported only after the overrides — the env schema reads process.env at import time.
await import('../src/api/index');
