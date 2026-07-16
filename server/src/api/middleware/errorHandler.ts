import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { env } from '../../config/env';
import { ApiError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/** Terminal 404 for unknown /api routes (mounted after all API routers). */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.path}` },
  });
}

/**
 * Single funnel translating every failure into the uniform `{ error: { code, message } }`
 * shape. Express 5 forwards rejected promises from async handlers here automatically —
 * no asyncHandler wrappers needed.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
    return;
  }

  if (err instanceof MulterError) {
    // Spec: enforce the 5MB limit at the API layer -> 413 with a clear message.
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File exceeds the ${env.MAX_FILE_SIZE_MB}MB limit`,
        },
      });
      return;
    }
    res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    return;
  }

  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
