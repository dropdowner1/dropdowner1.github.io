/**
 * AccountDialog — real sign-up / log-in against the Phase B HTTP API.
 *
 * Validation mirrors the server-side zod schemas (player name 1..20
 * chars, alnum user id, 8+ alnum password, RFC-ish email).
 * Submitting fires the matching `/api/auth/*` endpoint; the server's
 * HttpOnly cookie is set on success, the SessionContext picks the new
 * identity up via `setUser`, and the dialog closes.
 *
 * Server errors (USER_ID_TAKEN, INVALID_CREDENTIALS, etc.) are
 * surfaced inline with their server-provided message.
 *
 * 「ゲストで続行」を選ぶとサーバ呼び出しを行わずローカルゲストで進みます。
 */

import type { PublicUser } from '@chaindrop/shared/protocol';
import { useCallback, useState } from 'react';
import {
  login as apiLogin,
  logout as apiLogout,
  requestPasswordReset as apiRequestPasswordReset,
  signup as apiSignup,
} from '../api/auth';
import { HttpApiError } from '../api/http';
import { useSession } from '../state/SessionContext';
import {
  type AccountFormErrors,
  type AccountIdentity,
  loadAccount,
  saveAccount,
  validateAccountForm,
} from '../state/account';

interface Props {
  /** Called after a successful auth (or guest pass-through) with the
   *  identity to remember; for authed flows the resolved server user
   *  is passed alongside so callers can update the SessionContext
   *  without an extra round-trip. */
  onClose: (account: AccountIdentity, user?: PublicUser) => void;
}

type Tab = 'signup' | 'login' | 'forgot';

export function AccountDialog({ onClose }: Props) {
  const { user: sessionUser, setUser: setSessionUser } = useSession();
  const [tab, setTab] = useState<Tab>('signup');
  const [playerName, setPlayerName] = useState('');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<AccountFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 「パスワードを忘れた」 — banner that survives after submit so the
  // user knows to check their inbox.
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);

  const handleSignup = useCallback(async () => {
    const input = { playerName, userId, password, email };
    const found = validateAccountForm(input);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const user = await apiSignup(input);
      const account: AccountIdentity = {
        playerName: user.playerName,
        userId: user.userId,
        guest: false,
      };
      saveAccount(account);
      onClose(account, user);
    } catch (err) {
      if (err instanceof HttpApiError) {
        if (err.code === 'USER_ID_TAKEN') setErrors({ userId: err.message });
        else if (err.code === 'EMAIL_TAKEN') setErrors({ email: err.message });
        else setServerError(err.message);
      } else {
        setServerError('サーバに接続できませんでした');
      }
    } finally {
      setBusy(false);
    }
  }, [playerName, userId, password, email, onClose]);

  const handleLogin = useCallback(async () => {
    const found = loginErrors({ userId, password });
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const user = await apiLogin({ userId, password });
      const account: AccountIdentity = {
        playerName: user.playerName,
        userId: user.userId,
        guest: false,
      };
      saveAccount(account);
      onClose(account, user);
    } catch (err) {
      if (err instanceof HttpApiError) setServerError(err.message);
      else setServerError('サーバに接続できませんでした');
    } finally {
      setBusy(false);
    }
  }, [userId, password, onClose]);

  const handleForgot = useCallback(async () => {
    const next: AccountFormErrors = {};
    if (resetEmail.trim() === '') next.email = 'メールアドレスを入力してください';
    setErrors(next);
    setServerError(null);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await apiRequestPasswordReset({ email: resetEmail.trim() });
      setResetSent(true);
    } catch (err) {
      if (err instanceof HttpApiError) setServerError(err.message);
      else setServerError('サーバに接続できませんでした');
    } finally {
      setBusy(false);
    }
  }, [resetEmail]);

  const continueAsGuest = useCallback(() => {
    const acc = loadAccount();
    onClose(acc);
  }, [onClose]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await apiLogout();
    } catch {
      /* even if the server call fails the local state will reset */
    }
    setSessionUser(null);
    // Reset the local account record into guest mode so other parts of
    // the UI (matchmaker, marquee) immediately reflect the change.
    const acc = loadAccount();
    const guest: AccountIdentity = { playerName: acc.playerName, userId: null, guest: true };
    saveAccount(guest);
    setBusy(false);
    onClose(guest);
  }, [onClose, setSessionUser]);

  // Logged-in view: skip the form entirely and offer logout.
  if (sessionUser) {
    return (
      <div className="snes-window account-dialog">
        <h2 className="account-title">アカウント</h2>
        <p className="account-loggedin">
          ログイン中: <strong>{sessionUser.playerName}</strong>
          <br />
          <span className="account-loggedin-id">@{sessionUser.userId}</span>
        </p>
        <div className="account-actions">
          <button
            type="button"
            className="pause-btn pause-btn-primary"
            disabled={busy}
            onClick={() => void handleLogout()}
          >
            ログアウト
          </button>
          <button
            type="button"
            className="pause-btn pause-btn-secondary"
            disabled={busy}
            onClick={() => onClose(loadAccount(), sessionUser)}
          >
            閉じる
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="snes-window account-dialog">
      <h2 className="account-title">アカウント</h2>

      <div className="account-tabs">
        <button
          type="button"
          className={`account-tab ${tab === 'signup' ? 'on' : ''}`}
          onClick={() => {
            setTab('signup');
            setErrors({});
            setServerError(null);
          }}
        >
          新規作成
        </button>
        <button
          type="button"
          className={`account-tab ${tab === 'login' ? 'on' : ''}`}
          onClick={() => {
            setTab('login');
            setErrors({});
            setServerError(null);
          }}
        >
          ログイン
        </button>
      </div>

      {tab === 'signup' && (
        <div className="account-form">
          <Field
            label="プレイヤー名"
            value={playerName}
            onChange={setPlayerName}
            maxLength={20}
            error={errors.playerName}
            hint="20文字まで（ひらがな・カタカナ・英数字なんでも）"
          />
          <Field
            label="ユーザーID"
            value={userId}
            onChange={setUserId}
            maxLength={20}
            error={errors.userId}
            hint="20文字まで（英数字・_・-）"
            autoComplete="username"
          />
          <Field
            label="パスワード"
            value={password}
            onChange={setPassword}
            type="password"
            error={errors.password}
            hint="英数字記号 8 文字以上"
            autoComplete="new-password"
          />
          <Field
            label="メールアドレス"
            value={email}
            onChange={setEmail}
            type="email"
            error={errors.email}
            hint="パスワード再設定リンクの送信先"
            autoComplete="email"
          />
        </div>
      )}
      {tab === 'login' && (
        <div className="account-form">
          <Field
            label="ユーザーID"
            value={userId}
            onChange={setUserId}
            maxLength={20}
            error={errors.userId}
            autoComplete="username"
          />
          <Field
            label="パスワード"
            value={password}
            onChange={setPassword}
            type="password"
            error={errors.password}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="account-link"
            onClick={() => {
              setTab('forgot');
              setErrors({});
              setServerError(null);
              setResetSent(false);
            }}
          >
            パスワードを忘れた場合
          </button>
        </div>
      )}
      {tab === 'forgot' && (
        <div className="account-form">
          {resetSent ? (
            <p className="account-loggedin">
              再設定リンクをメールでお送りしました。
              <br />
              受信ボックス（迷惑メールも）をご確認ください。
            </p>
          ) : (
            <Field
              label="メールアドレス"
              value={resetEmail}
              onChange={setResetEmail}
              type="email"
              error={errors.email}
              hint="登録済みのメールアドレスにリンクを送ります"
              autoComplete="email"
            />
          )}
        </div>
      )}

      {serverError && <p className="account-error">{serverError}</p>}

      <div className="account-actions">
        {tab === 'forgot' ? (
          <>
            {!resetSent && (
              <button
                type="button"
                className="pause-btn pause-btn-primary"
                disabled={busy}
                onClick={() => void handleForgot()}
              >
                送信
              </button>
            )}
            <button
              type="button"
              className="pause-btn pause-btn-secondary"
              disabled={busy}
              onClick={() => {
                setTab('login');
                setErrors({});
                setServerError(null);
                setResetSent(false);
              }}
            >
              ログインに戻る
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="pause-btn pause-btn-primary"
              disabled={busy}
              onClick={() => void (tab === 'signup' ? handleSignup() : handleLogin())}
            >
              {tab === 'signup' ? '新規作成' : 'ログイン'}
            </button>
            <button
              type="button"
              className="pause-btn pause-btn-secondary"
              onClick={continueAsGuest}
              disabled={busy}
            >
              ゲストで続行
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function loginErrors(input: { userId: string; password: string }): AccountFormErrors {
  const errs: AccountFormErrors = {};
  if (input.userId.trim() === '') errs.userId = 'ユーザーIDを入力してください';
  if (input.password.length === 0) errs.password = 'パスワードを入力してください';
  return errs;
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  type?: 'text' | 'password' | 'email';
  maxLength?: number | undefined;
  autoComplete?: string | undefined;
}

function Field({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  maxLength,
  autoComplete,
}: FieldProps) {
  return (
    <label className="account-field">
      <span className="account-field-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        autoComplete={autoComplete}
      />
      {hint && !error && <span className="account-field-hint">{hint}</span>}
      {error && <span className="account-field-error">{error}</span>}
    </label>
  );
}
