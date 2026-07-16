import type { UserDoc } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth after JWT verification + user load. */
      user?: UserDoc;
    }
  }
}

export {};
