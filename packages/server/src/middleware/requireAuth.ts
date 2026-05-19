/**
 * requireAuth — Express middleware that verifies the session JWT,
 * attaches the resolved user to `res.locals.session`, and 401s on
 * failure. Routes that need the caller's identity import this.
 */

import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../auth/AuthService';

export const COOKIE_NAME = 'chaindrop_session';

export interface ResolvedSession {
  dbUserId: number;
  userId: string;
  playerName: string;
}

export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const token = cookies[COOKIE_NAME];
    const verified = auth.verify(token);
    if (!verified) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'ログインが必要です' });
      return;
    }
    res.locals.session = {
      dbUserId: verified.dbUserId,
      userId: verified.user.userId,
      playerName: verified.user.playerName,
    } satisfies ResolvedSession;
    next();
  };
}
