/**
 * /api/auth/* routes — signup, login, logout, plus `GET /api/me`.
 *
 * The handlers thin-wrap `AuthService`: parse, run, translate the
 * service-level error code into an HTTP status, set/clear the
 * session cookie.
 */

import { passwordResetConfirm, passwordResetRequest } from '@chaindrop/shared/protocol';
import type { CookieOptions, Request, Response, Router } from 'express';
import express from 'express';
import type { AuthService } from '../auth/AuthService';
import type { AuthError, AuthSession } from '../auth/AuthService';
import type { EmailSender } from '../auth/EmailSender';
import type { PasswordResetService } from '../auth/PasswordResetService';
import { config } from '../config';
import { COOKIE_NAME, type ResolvedSession, requireAuth } from '../middleware/requireAuth';
import { logger } from '../util/logger';

export interface AuthRouterDeps {
  auth: AuthService;
  resets: PasswordResetService;
  email: EmailSender;
  /**
   * Base URL the e-mail body should point the user at for the
   * second step of the reset flow. Resolves to a deep link the
   * client can route on (we use the hash-based `#reset/<token>`
   * scheme so static hosting like GitHub Pages doesn't need server
   * rewrites). Typically `https://example.com/` (no trailing
   * specifics) — the route appends `#reset/<token>` itself.
   */
  clientBaseUrl: string;
}

export function authRouter(deps: AuthRouterDeps): Router {
  const { auth, resets, email, clientBaseUrl } = deps;
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

  /**
   * Step 1 of the forgot-password flow. We always respond 204 — even
   * when the e-mail isn't registered — so an attacker can't enumerate
   * accounts by watching the status code.
   */
  router.post('/password-reset/request', async (req, res) => {
    const parsed = passwordResetRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'bad body' });
      return;
    }
    const minted = resets.request(parsed.data.email);
    if (minted) {
      const url = `${clientBaseUrl.replace(/\/$/, '')}/#reset/${minted.token}`;
      try {
        await email.send({
          to: parsed.data.email,
          subject: '【ChainDrop】パスワード再設定のご案内',
          text: `${minted.playerName} 様\n\nChainDrop のパスワード再設定リクエストを受け付けました。\n以下のリンクから新しいパスワードを設定してください（1時間以内）：\n\n${url}\n\nお心当たりがない場合は、このメールを破棄してください。\n`,
        });
      } catch (err) {
        // We log but still 204 so we don't leak existence information.
        logger.error({ err }, 'password-reset email send failed');
      }
    }
    res.status(204).end();
  });

  router.post('/password-reset/confirm', (req, res) => {
    const parsed = passwordResetConfirm.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'bad body' });
      return;
    }
    const outcome = resets.confirm(parsed.data.token, parsed.data.newPassword);
    if ('error' in outcome) {
      const status = outcome.error === 'INVALID_PASSWORD' ? 400 : 401;
      res.status(status).json({
        error: outcome.error,
        message:
          outcome.error === 'INVALID_PASSWORD'
            ? 'パスワードの形式が正しくありません'
            : 'リセットリンクが無効か期限切れです',
      });
      return;
    }
    res.status(204).end();
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
