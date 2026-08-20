/**
 * AccountDialog — real sign-up / log-in against the Phase B HTTP API.
 *
 * Validation mirrors the server-side zod schemas (player name 1..20
 * chars, alnum user id, 8+ alnum password). Accounts are ID +
 * password only — there is no e-mail field and no password-recovery
 * path; lose the password, lose the account.
 *
 * Submitting fires the matching `/api/auth/*` endpoint; the server's
 * HttpOnly cookie is set on success, the SessionContext picks the new
 * identity up via `setUser`, and the dialog closes.
 *
 * Server errors (USER_ID_TAKEN, INVALID_CREDENTIALS, etc.) are
 * surfaced inline with their server-provided message.
 *
 * テクマナ (Techmana) SSO も選べます。押すとサーバの `/api/auth/techmana/start`
 * へ全画面遷移し、同意後に戻ってくる頃にはセッション Cookie が張られています。
 * 既にログイン中に押した場合は新しいアカウントを作らず、今のアカウントに
 * テクマナを紐付けます (併存方針)。
 *
 * 「ゲストで続行」を選ぶとサーバ呼び出しを行わずローカルゲストで進みます。
 */

import type { PublicUser } from '@chaindrop/shared/protocol';
import { useCallback, useEffect, useState } from 'react';
import { login as apiLogin, logout as apiLogout, signup as apiSignup } from '../api/auth';
import { HttpApiError } from '../api/http';
import {
  type TechmanaStatus,
  fetchTechmanaStatus,
  techmanaStartUrl,
  unlinkTechmana,
} from '../api/sync';
import { useSession } from '../state/SessionContext';
import {
  type AccountFormErrors,
  type AccountIdentity,
  loadAccount,
  saveAccount,
  validateAccountForm,
} from '../state/account';
import { resetSeq } from '../state/cloudSave';

interface Props {
  /** Called after a successful auth (or guest pass-through) with the
   *  identity to remember; for authed flows the resolved server user
   *  is passed alongside so callers can update the SessionContext
   *  without an extra round-trip. */
  onClose: (account: AccountIdentity, user?: PublicUser) => void;
}

type Tab = 'signup' | 'login';

export function AccountDialog({ onClose }: Props) {
  const { user: sessionUser, setUser: setSessionUser } = useSession();
  const [tab, setTab] = useState<Tab>('signup');
  const [playerName, setPlayerName] = useState('');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<AccountFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [techmana, setTechmana] = useState<TechmanaStatus | null>(null);

  // Only meaningful once we know who we are; guests have nothing to link.
  useEffect(() => {
    if (!sessionUser) return;
    let alive = true;
    void fetchTechmanaStatus()
      .then((s) => {
        if (alive) setTechmana(s);
      })
      .catch(() => {
        /* status is decoration — a failure just hides the row */
      });
    return () => {
      alive = false;
    };
  }, [sessionUser]);

  /**
   * Full-page navigation, deliberately. The server has to set a cookie
   * and 302 across to Techmana, neither of which fetch can do.
   */
  const startTechmana = useCallback(() => {
    window.location.assign(techmanaStartUrl());
  }, []);

  const handleUnlink = useCallback(async () => {
    setBusy(true);
    try {
      await unlinkTechmana();
      setTechmana({ linked: false, subject: null, enabled: true });
    } catch (err) {
      setServerError(err instanceof HttpApiError ? err.message : '連携を解除できませんでした');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSignup = useCallback(async () => {
    const input = { playerName, userId, password };
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
        else setServerError(err.message);
      } else {
        setServerError('サーバに接続できませんでした');
      }
    } finally {
      setBusy(false);
    }
  }, [playerName, userId, password, onClose]);

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
    // The next account to log in here starts its own save history.
    resetSeq();
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

        {techmana?.enabled &&
          (techmana.linked ? (
            <div className="account-techmana">
              <p className="account-techmana-note">
                テクマナと連携済み。セーブデータはアカウントに保存されます。
              </p>
              <button
                type="button"
                className="account-techmana-btn account-techmana-btn-quiet"
                disabled={busy}
                onClick={() => void handleUnlink()}
              >
                テクマナ連携を解除
              </button>
            </div>
          ) : (
            <div className="account-techmana">
              <button
                type="button"
                className="account-techmana-btn"
                disabled={busy}
                onClick={startTechmana}
              >
                テクマナと連携する
              </button>
              <p className="account-techmana-note">
                連携するとセーブデータがテクマナのアカウントに保存され、別の端末でも続きから遊べます。
              </p>
            </div>
          ))}

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

      <div className="account-techmana">
        <button
          type="button"
          className="account-techmana-btn"
          disabled={busy}
          onClick={startTechmana}
        >
          テクマナでログイン
        </button>
        <p className="account-techmana-note">
          テクマナ（社内システム）のアカウントでログインできます。セーブデータはそのアカウントに保存され、別の端末でも続きから遊べます。
        </p>
      </div>

      <div className="account-divider">
        <span>または</span>
      </div>

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

      {tab === 'signup' ? (
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
            hint="英数字記号 8 文字以上 — 忘れると再ログインできません"
            autoComplete="new-password"
          />
        </div>
      ) : (
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
        </div>
      )}

      {serverError && <p className="account-error">{serverError}</p>}

      <div className="account-actions">
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
