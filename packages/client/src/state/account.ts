/**
 * Account state — Phase A keeps everything client-local. A "logged in"
 * user is just a player-name + user-id stored in localStorage; the
 * password entered in the account creation form is NOT persisted here
 * (Phase B's real backend owns the hash).
 *
 * Accounts are intentionally ID + password only — there is no e-mail
 * field and no recovery path. Users manage their own credentials.
 *
 * Guests get a stable auto-generated player name so the matchmaking
 * server still has something to display, but their solo / online
 * records are clearly marked as guest data in the UI.
 */

export interface AccountIdentity {
  /** Display name shown to opponents (20-char max, any script). */
  playerName: string;
  /** Stable per-machine identifier; alnum, 20-char max. Null for guest. */
  userId: string | null;
  /** True when the user has accepted the Phase B stub and is acting as
   *  a guest until accounts go live. */
  guest: boolean;
}

const STORAGE_KEY = 'chaindrop.account.v1';
const GUEST_NAME_PREFIX = 'ゲスト';

export function loadAccount(): AccountIdentity {
  if (typeof window === 'undefined' || !window.localStorage) {
    return makeFreshGuest();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = makeFreshGuest();
      saveAccount(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw) as Partial<AccountIdentity>;
    return {
      playerName: typeof parsed.playerName === 'string' ? parsed.playerName : guestName(),
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      guest: parsed.guest !== false, // default to guest if unset
    };
  } catch {
    return makeFreshGuest();
  }
}

export function saveAccount(account: AccountIdentity): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    /* ignore */
  }
}

function makeFreshGuest(): AccountIdentity {
  return { playerName: guestName(), userId: null, guest: true };
}

function guestName(): string {
  // Four-digit suffix gives a clear "you're sharing the machine in
  // guest mode" cue without needing crypto-strong uniqueness.
  const tail = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `${GUEST_NAME_PREFIX}${tail}`;
}

// ----------------------- Account form validation ------------------------

export interface AccountFormInput {
  playerName: string;
  userId: string;
  password: string;
}

export type AccountFormErrors = Partial<Record<keyof AccountFormInput, string>>;

const PLAYER_NAME_MAX = 20;
const USER_ID_MAX = 20;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_PATTERN = /^[A-Za-z0-9!@#$%^&*()_\-+=.]+$/;

export function validateAccountForm(input: AccountFormInput): AccountFormErrors {
  const errors: AccountFormErrors = {};
  if (input.playerName.trim().length === 0) {
    errors.playerName = 'プレイヤー名を入力してください';
  } else if (input.playerName.length > PLAYER_NAME_MAX) {
    errors.playerName = `${PLAYER_NAME_MAX}文字以内にしてください`;
  }
  if (!USER_ID_PATTERN.test(input.userId)) {
    errors.userId = '英数字、_、- だけで入力してください';
  } else if (input.userId.length === 0 || input.userId.length > USER_ID_MAX) {
    errors.userId = `1〜${USER_ID_MAX}文字で入力してください`;
  }
  if (!PASSWORD_PATTERN.test(input.password)) {
    errors.password = 'パスワードは英数字記号のみ使えます';
  } else if (input.password.length < PASSWORD_MIN) {
    errors.password = `${PASSWORD_MIN}文字以上で入力してください`;
  }
  return errors;
}
