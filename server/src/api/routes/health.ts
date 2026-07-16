import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../../config/env';
import { pingRedis } from '../../queue';

const router: Router = Router();

/** Liveness + dependency readiness. Used by Docker healthchecks and the deploy platform. */
router.get('/', async (_req, res) => {
  const mongo = mongoose.connection.readyState === 1;
  const redis = await pingRedis();

  const ok = mongo && redis;
  res.status(ok ? 200 : 503).json({
    ok,
    mongo,
    redis,
    // Lets the UI surface "mock mode" and its demo filenames to reviewers (D-005).
    aiProvider: env.AI_PROVIDER,
    uptimeSec: Math.round(process.uptime()),
  });
});

export default router;
