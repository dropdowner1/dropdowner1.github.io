/**
 * /api/auth/* routes — signup, login, logout, plus `GET /api/me`.
 *
 * The handlers thin-wrap `AuthService`: parse, run, translate the
 * service-level error code into an HTTP status, set/clear the
 * session cookie.
 */

import type { CookieOptions, Request, Response, Router } from 'express';
import express from 'express';
import type { AuthService } from '../auth/AuthService';
import type { AuthError, AuthSession } from '../auth/AuthService';
import { config } from '../config';
import { COOKIE_NAME, type ResolvedSession, requireAuth } from '../middleware/requireAuth';

export function authRouter(auth: AuthService): Router {
  const router = express.Router();

  router.post('/signup', (req, res) => {
    const result = auth.signup(req.body);
    if (!result.ok) return sendAuthError(res, result.code, result.detail);
    setSessionCookie(res, result.session);
    res.status(201).json({ user: result.session.user });
  });

  router.post('/login', (req, res) => {
    const result = auth.login(req.body);
    if (!result.ok) return sendAuthError(res, result.code, result.detail);
    setSessionCookie(res, result.session);
    res.status(200).json({ user: result.session.user });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, cookieBaseOpts());
    res.status(204).end();
  });

  router.get('/me', requireAuth(auth), (_req: Request, res: Response) => {
    const session = res.locals.session as ResolvedSession;
    res.json({ user: { userId: session.userId, playerName: session.playerName } });
  });

  return router;
}

// ----------------------------- helpers ---------------------------------

function sendAuthError(res: Response, code: AuthError, detail?: string): void {
  const status =
    code === 'INVALID_BODY'
      ? 400
      : code === 'USER_ID_TAKEN' || code === 'EMAIL_TAKEN'
        ? 409
        : code === 'INVALID_CREDENTIALS'
          ? 401
          : 500;
  res.status(status).json({ error: code, message: detail ?? messageFor(code) });
}

function messageFor(code: AuthError): string {
  switch (code) {
    case 'USER_ID_TAKEN':
      return 'このユーザーIDは既に使われています';
    case 'EMAIL_TAKEN':
      return 'このメールアドレスは既に使われています';
    case 'INVALID_CREDENTIALS':
      return 'ユーザーIDまたはパスワードが違います';
    case 'INVALID_BODY':
      return '入力が正しくありません';
  }
}

function cookieBaseOpts(): CookieOptions {
  // Cross-origin support: the client lives on a different host in
  // production (GitHub Pages), so we need SameSite=None + Secure for
  // the browser to send the cookie back with `credentials: 'include'`.
  // In dev we relax both to `lax`/insecure so `localhost:5173` ↔
  // `localhost:2567` works without HTTPS.
  const isDev = process.env.NODE_ENV !== 'production';
  return {
    httpOnly: true,
    path: '/',
    sameSite: isDev ? 'lax' : 'none',
    secure: !isDev,
    domain: config.cookieDomain,
  };
}

function setSessionCookie(res: Response, session: AuthSession): void {
  res.cookie(COOKIE_NAME, session.token, {
    ...cookieBaseOpts(),
    maxAge: session.maxAge * 1000,
  });
}
