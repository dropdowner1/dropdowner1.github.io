/**
 * zod schemas for the HTTP account / records API.
 *
 * Both server route handlers and client `fetch` wrappers validate
 * against these, so any drift is caught at the boundary instead of
 * scattering through ad-hoc `any` casts.
 *
 * See D6 §10 (HTTP accounts surface) and D4 §5 (records sync).
 */

import { z } from 'zod';

// ----------------------------- Primitives -----------------------------

export const PLAYER_NAME_MAX = 20;
export const USER_ID_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 100;

const playerName = z
  .string()
  .trim()
  .min(1, 'プレイヤー名を入力してください')
  .max(PLAYER_NAME_MAX, `${PLAYER_NAME_MAX}文字以内にしてください`);

const userId = z
  .string()
  .trim()
  .min(1, 'ユーザーIDを入力してください')
  .max(USER_ID_MAX, `${USER_ID_MAX}文字以内にしてください`)
  .regex(/^[A-Za-z0-9_-]+$/, '英数字・_・- のみ使えます');

const password = z
  .string()
  .min(PASSWORD_MIN, `${PASSWORD_MIN}文字以上で入力してください`)
  .max(PASSWORD_MAX)
  .regex(/^[A-Za-z0-9!@#$%^&*()_\-+=.]+$/, 'パスワードに使えない文字が含まれています');

const email = z.string().email('メールアドレスの形式が正しくありません');

// ----------------------------- Sign-up --------------------------------

export const signupRequest = z.object({
  playerName,
  userId,
  password,
  email,
});
export type SignupRequest = z.infer<typeof signupRequest>;

// ----------------------------- Login ----------------------------------

export const loginRequest = z.object({
  userId,
  password,
});
export type LoginRequest = z.infer<typeof loginRequest>;

// ----------------------------- Public user shape ----------------------

export const publicUser = z.object({
  userId: z.string(),
  playerName: z.string(),
});
export type PublicUser = z.infer<typeof publicUser>;

export const meResponse = z.object({
  user: publicUser,
});
export type MeResponse = z.infer<typeof meResponse>;

// ----------------------------- Records --------------------------------

export const soloRunRequest = z.object({
  score: z.number().int().nonnegative(),
  maxChain: z.number().int().nonnegative(),
  cellsCleared: z.number().int().nonnegative(),
});
export type SoloRunRequest = z.infer<typeof soloRunRequest>;

export const onlineMatchRequest = z.object({
  opponentName: z.string().min(1).max(40),
  outcome: z.enum(['win', 'loss', 'draw']),
  selfScore: z.number().int().nonnegative(),
});
export type OnlineMatchRequest = z.infer<typeof onlineMatchRequest>;

// ----------------------------- Aggregates -----------------------------

export const soloBestEntry = z.object({
  userId: z.string(),
  playerName: z.string(),
  bestScore: z.number().int().nonnegative(),
  bestMaxChain: z.number().int().nonnegative(),
  totalCleared: z.number().int().nonnegative(),
});
export type SoloBestEntry = z.infer<typeof soloBestEntry>;

export const soloRankingsResponse = z.object({
  rankings: z.array(soloBestEntry),
});
export type SoloRankingsResponse = z.infer<typeof soloRankingsResponse>;

export const onlineRankingEntry = z.object({
  userId: z.string(),
  playerName: z.string(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
});
export type OnlineRankingEntry = z.infer<typeof onlineRankingEntry>;

export const onlineRankingsResponse = z.object({
  rankings: z.array(onlineRankingEntry),
});
export type OnlineRankingsResponse = z.infer<typeof onlineRankingsResponse>;

export const onlineHistoryEntry = z.object({
  at: z.string(),
  opponentName: z.string(),
  outcome: z.enum(['win', 'loss', 'draw']),
  selfScore: z.number().int().nonnegative(),
});
export type OnlineHistoryEntry = z.infer<typeof onlineHistoryEntry>;

export const recordsMeResponse = z.object({
  solo: soloBestEntry.omit({ userId: true, playerName: true }),
  recentSolo: z.array(
    z.object({
      score: z.number().int().nonnegative(),
      maxChain: z.number().int().nonnegative(),
      cellsCleared: z.number().int().nonnegative(),
      playedAt: z.string(),
    }),
  ),
  online: z.array(onlineHistoryEntry),
});
export type RecordsMeResponse = z.infer<typeof recordsMeResponse>;

// ----------------------------- Password reset -----------------------

export const passwordResetRequest = z.object({
  email,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequest>;

export const passwordResetConfirm = z.object({
  token: z.string().min(8),
  newPassword: password,
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirm>;

// ----------------------------- Common error --------------------------

export const apiError = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiError>;
