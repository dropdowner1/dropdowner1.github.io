/**
 * SessionContext — caches the currently-authenticated user (or null
 * for guests) and exposes a tiny API surface for the UI to refresh
 * it after sign-in / sign-out.
 *
 * On boot we ping `/api/auth/me` so an existing HttpOnly cookie
 * resurrects the session without the player having to log back in.
 */

import type { PublicUser } from '@chaindrop/shared/protocol';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { fetchMe } from '../api/auth';

interface SessionContextValue {
  /** null while the initial /me probe is in flight, then either the
   *  logged-in user or undefined for a guest. */
  user: PublicUser | null | undefined;
  /** Forces a re-fetch — call this after signup / login / logout. */
  refresh: () => Promise<void>;
  /** Optimistic local update used by signup/login so the UI updates
   *  immediately without waiting for a second fetch. */
  setUser: (user: PublicUser | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  // `null` = probing, `undefined` = guest, PublicUser = logged in.
  const [user, setUser] = useState<PublicUser | null | undefined>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me ?? undefined);
    } catch (err) {
      console.warn('[session] /me failed, treating as guest', err);
      setUser(undefined);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ user, refresh, setUser: (u) => setUser(u ?? undefined) }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
