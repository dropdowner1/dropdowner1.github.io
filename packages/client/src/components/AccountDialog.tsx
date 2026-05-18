/**
 * AccountDialog — Phase A shell for sign-up / log-in.
 *
 * The form fields and validation mirror the eventual Phase B backend
 * (player name 1..20 chars, alnum user id, 8-char min alnum password,
 * RFC-ish email). On submit we DO NOT contact a server — the dialog
 * just stamps the entered player name into the local account record
 * so the matchmaker has something to display, marks the user as
 * "guest-while-accounts-are-offline", and shows a banner explaining
 * that real accounts ship in Phase B.
 *
 * 「ログインしない」を選ぶと完全なゲストモードに入ります。
 */

import { useCallback, useState } from 'react';
import {
  type AccountFormErrors,
  type AccountIdentity,
  loadAccount,
  saveAccount,
  validateAccountForm,
} from '../state/account';

interface Props {
  onClose: (account: AccountIdentity) => void;
}

type Tab = 'signup' | 'login';

export function AccountDialog({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('signup');
  const [playerName, setPlayerName] = useState('');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<AccountFormErrors>({});

  const submit = useCallback(
    (kind: 'signup' | 'login') => {
      // Login can skip email validation; sign-up runs the full check.
      const input = { playerName, userId, password, email };
      const found = kind === 'signup' ? validateAccountForm(input) : loginErrors(input);
      setErrors(found);
      if (Object.keys(found).length > 0) return;

      // Phase A: stash the player name + user id locally and announce
      // the stub. Phase B will replace this with a real fetch.
      const account: AccountIdentity = {
        playerName: playerName.trim() || loadAccount().playerName,
        userId: userId.trim() || null,
        guest: true,
      };
      saveAccount(account);
      onClose(account);
    },
    [playerName, userId, password, email, onClose],
  );

  const continueAsGuest = useCallback(() => {
    const acc = loadAccount();
    onClose(acc);
  }, [onClose]);

  return (
    <div className="snes-window account-dialog">
      <h2 className="account-title">アカウント</h2>

      <div className="account-tabs">
        <button
          type="button"
          className={`account-tab ${tab === 'signup' ? 'on' : ''}`}
          onClick={() => setTab('signup')}
        >
          新規作成
        </button>
        <button
          type="button"
          className={`account-tab ${tab === 'login' ? 'on' : ''}`}
          onClick={() => setTab('login')}
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

      <p className="account-stub">
        アカウント機能は現在準備中です。フォームを送信するとプレイヤー名のみ保存され、
        ゲストモードでゲームを続行します（記録はこの端末内に保存されます）。
      </p>

      <div className="account-actions">
        <button type="button" className="pause-btn pause-btn-primary" onClick={() => submit(tab)}>
          {tab === 'signup' ? '新規作成' : 'ログイン'}
        </button>
        <button type="button" className="pause-btn pause-btn-secondary" onClick={continueAsGuest}>
          ゲストで続行
        </button>
      </div>
    </div>
  );
}

function loginErrors(input: {
  playerName: string;
  userId: string;
  password: string;
  email: string;
}): AccountFormErrors {
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
