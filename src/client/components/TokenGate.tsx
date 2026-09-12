import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from '../api';
import { ErrorBanner, Spinner } from './ui';

export function TokenGate({ onConnect }: { onConnect: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
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
      await onConnect(trimmed);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            JF
          </span>
          <span className="brand-name">JFVRC</span>
        </div>
        <h1 className="gate-title">Jellyfin to revocable HLS</h1>
        <p className="gate-sub">
          Sign in with the operator admin token to resolve items, build playback links and manage
          access.
        </p>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="admin-token">Admin token</label>
            <input
              id="admin-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={busy}
              placeholder="Bearer token"
              aria-invalid={error ? true : undefined}
            />
            <p className="hint">Kept in memory for this tab only; never stored or logged.</p>
          </div>
          {error ? <ErrorBanner message={error} /> : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <Spinner label="Checking token" /> : 'Unlock'}
          </button>
        </form>
      </div>
    </main>
  );
}
