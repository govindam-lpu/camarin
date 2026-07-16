import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { ApiError } from '../../lib/errors';
import { User } from '../../models/User';

export function signToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Bearer-token auth (D-002). The user is re-loaded per request: one indexed point
 * read buys instant lockout of deleted users despite still-valid tokens.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Authorization: Bearer <token> header');
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice('Bearer '.length), env.JWT_SECRET) as jwt.JwtPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
  if (!payload.sub) throw ApiError.unauthorized('Malformed token');

  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('User no longer exists');

  req.user = user;
  next();
}
