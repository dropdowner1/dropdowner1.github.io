/**
 * AuthService — sign-up, login, and JWT minting backed by SQLite.
 *
 * The service is intentionally a thin wrapper over the DB statements;
 * route handlers do the HTTP plumbing and call into here. Keeping the
 * service free of `Request` / `Response` means we can unit-test it
 * directly against an in-memory DB without spinning up Express.
 */

import {
  type LoginRequest,
  type PublicUser,
  type SignupRequest,
  loginRequest,
  signupRequest,
} from '@chaindrop/shared/protocol';
import { compareSync, hashSync } from 'bcryptjs';
import type { Database } from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { jwtSecret } from './jwtSecret';

const BCRYPT_COST = 10;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface AuthSession {
  user: PublicUser;
  /** Signed JWT — put it in the HttpOnly cookie. */
  token: string;
  /** Seconds until the cookie should expire (`Max-Age`). */
  maxAge: number;
}

export type AuthError = 'USER_ID_TAKEN' | 'EMAIL_TAKEN' | 'INVALID_BODY' | 'INVALID_CREDENTIALS';

export interface AuthFailure {
  ok: false;
  code: AuthError;
  detail?: string;
}

export interface AuthSuccess {
  ok: true;
  session: AuthSession;
}

export type AuthResult = AuthSuccess | AuthFailure;

export class AuthService {
  constructor(private readonly db: Database) {}

  signup(body: unknown): AuthResult {
    const parsed = signupRequest.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'INVALID_BODY',
        detail: parsed.error.issues[0]?.message ?? '入力が正しくありません',
      };
    }
    const input: SignupRequest = parsed.data;
    // SQLite UNIQUE indexes catch races; we pre-check for nicer errors.
    if (this.findByUserId(input.userId)) {
      return { ok: false, code: 'USER_ID_TAKEN' };
    }
    if (this.findByEmail(input.email)) {
      return { ok: false, code: 'EMAIL_TAKEN' };
    }
    const hash = hashSync(input.password, BCRYPT_COST);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO users (user_id, player_name, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.userId, input.playerName.trim(), input.email, hash, now, now);
    const user: PublicUser = { userId: input.userId, playerName: input.playerName.trim() };
    return { ok: true, session: this.mintSession(Number(result.lastInsertRowid), user) };
  }

  login(body: unknown): AuthResult {
    const parsed = loginRequest.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'INVALID_BODY',
        detail: parsed.error.issues[0]?.message ?? '入力が正しくありません',
      };
    }
    const input: LoginRequest = parsed.data;
    const row = this.findByUserId(input.userId);
    if (!row) return { ok: false, code: 'INVALID_CREDENTIALS' };
    if (!compareSync(input.password, row.password_hash)) {
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    return {
      ok: true,
      session: this.mintSession(row.id, { userId: row.user_id, playerName: row.player_name }),
    };
  }

  /** Resolve a session token back to the current user, or `null`. */
  verify(token: string | undefined): { dbUserId: number; user: PublicUser } | null {
    if (!token) return null;
    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, jwtSecret());
      if (typeof decoded === 'string') return null;
      payload = decoded;
    } catch {
      return null;
    }
    const dbUserId = typeof payload.sub === 'string' ? Number(payload.sub) : null;
    if (!dbUserId || !Number.isFinite(dbUserId)) return null;
    const row = this.findById(dbUserId);
    if (!row) return null;
    return { dbUserId, user: { userId: row.user_id, playerName: row.player_name } };
  }

  // ------------------------------ private ------------------------------

  private mintSession(dbUserId: number, user: PublicUser): AuthSession {
    const token = jwt.sign({}, jwtSecret(), {
      subject: String(dbUserId),
      expiresIn: SESSION_TTL_SECONDS,
    });
    return { user, token, maxAge: SESSION_TTL_SECONDS };
  }

  private findByUserId(userId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as
      | UserRow
      | undefined;
  }

  private findByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  private findById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
}

interface UserRow {
  id: number;
  user_id: string;
  player_name: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}
