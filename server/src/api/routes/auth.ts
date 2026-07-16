import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { isTest } from '../../config/env';
import { ApiError } from '../../lib/errors';
import { User } from '../../models/User';
import { requireAuth, signToken } from '../middleware/auth';
import { serializeUser } from '../serializers';

const router: Router = Router();

// Brute-force protection on credential endpoints; disabled under test.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
});

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const BCRYPT_COST = 12;

router.post('/signup', authLimiter, async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await User.create({ email, passwordHash });

  res.status(201).json({ token: signToken(user.id), user: serializeUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);

  const user = await User.findOne({ email });
  // Same message for unknown email and wrong password — no account enumeration via login.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  res.json({ token: signToken(user.id), user: serializeUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.user!) });
});

export default router;
