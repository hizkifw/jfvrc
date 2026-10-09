import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from '../api';
import { BrandMark, Icon } from './icons';
import { ErrorBanner, Spinner } from './ui';

export function TokenGate({
  onConnect,
}: {
  onConnect: (token: string, remember: boolean) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Enter the admin token.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConnect(trimmed, remember);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="gate-brand">
          <BrandMark size={52} />
        </div>
        <h1 className="gate-title">JFVRC</h1>
        <p className="gate-sub">
          Share anything in your Jellyfin library.
        </p>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="admin-token">Admin Token</label>
            <div className="input-affix">
              <input
                id="admin-token"
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={busy}
                aria-invalid={error ? true : undefined}
              />
              <button
                type="button"
                className="affix-btn"
                onClick={() => setReveal((value) => !value)}
                aria-label={reveal ? 'Hide token' : 'Show token'}
                aria-pressed={reveal}
              >
                <Icon name={reveal ? 'eye-off' : 'eye'} />
              </button>
            </div>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={busy}
            />
            <span>Remember on this device</span>
          </label>
          {error ? <ErrorBanner message={error} /> : null}
          <button type="submit" className="btn btn-primary btn-large btn-block" disabled={busy}>
            {busy ? <Spinner label="Checking token" /> : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  );
}
