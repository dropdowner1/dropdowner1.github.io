/**
 * /api/auth/* + /api/me wrappers.
 */

import type {
  LoginRequest,
  MeResponse,
  PublicUser,
  SignupRequest,
} from '@chaindrop/shared/protocol';
import { http, HttpApiError } from './http';

export async function signup(body: SignupRequest): Promise<PublicUser> {
  const res = await http.post<MeResponse>('/api/auth/signup', body);
  return res.user;
}

export async function login(body: LoginRequest): Promise<PublicUser> {
  const res = await http.post<MeResponse>('/api/auth/login', body);
  return res.user;
}

export async function logout(): Promise<void> {
  await http.post<void>('/api/auth/logout');
}

export async function fetchMe(): Promise<PublicUser | null> {
  try {
    const res = await http.get<MeResponse>('/api/auth/me');
    return res.user;
  } catch (err) {
    if (err instanceof HttpApiError && err.status === 401) return null;
    throw err;
  }
}
