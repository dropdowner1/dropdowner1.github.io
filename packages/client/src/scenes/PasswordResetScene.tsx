/**
 * PasswordResetScene — the second step of the forgot-password flow.
 *
 * Reached via the `#reset/<token>` deep link that the e-mail body
 * points at (see `PasswordResetService` on the server). We collect a
 * new password, POST it with the token, and on success route back to
 * the title screen so the user can log in.
 */

import { useCallback, useState } from 'react';
import { confirmPasswordReset } from '../api/auth';
import { HttpApiError } from '../api/http';

interface Props {
  token: string;
  onDone: () => void;
}

export function PasswordResetScene({ token, onDone }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = useCallback(async () => {
    setError(null);
    setServerError(null);
    if (password.length < 8) {
      setError('8文字以上で入力してください');
      return;
    }
    if (!/^[A-Za-z0-9!@#$%^&*()_\-+=.]+$/.test(password)) {
      setError('使えない文字が含まれています');
      return;
    }
    setBusy(true);
    try {
      await confirmPasswordReset({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      if (err instanceof HttpApiError) setServerError(err.message);
      else setServerError('サーバに接続できませんでした');
    } finally {
      setBusy(false);
    }
  }, [password, token]);

  return (
    <div className="title-scene">
      <div className="snes-window account-dialog" style={{ maxWidth: 480, margin: '8vh auto' }}>
        <h2 className="account-title">パスワード再設定</h2>

        {done ? (
          <>
            <p className="account-loggedin">
              新しいパスワードを設定しました。
              <br />
              ログイン画面からお進みください。
            </p>
            <div className="account-actions">
              <button type="button" className="pause-btn pause-btn-primary" onClick={onDone}>
                タイトルへ
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="account-form">
              <label className="account-field">
                <span className="account-field-label">新しいパスワード</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
                {error ? (
                  <span className="account-field-error">{error}</span>
                ) : (
                  <span className="account-field-hint">英数字記号 8 文字以上</span>
                )}
              </label>
            </div>
            {serverError && <p className="account-error">{serverError}</p>}
            <div className="account-actions">
              <button
                type="button"
                className="pause-btn pause-btn-primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                再設定
              </button>
              <button
                type="button"
                className="pause-btn pause-btn-secondary"
                disabled={busy}
                onClick={onDone}
              >
                キャンセル
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
