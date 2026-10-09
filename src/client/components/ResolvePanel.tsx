import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api';
import type { ItemDetails } from '../types';
import { ErrorBanner, Spinner } from './ui';

export function ResolvePanel({
  onSelect,
  onBusyChange,
}: {
  onSelect: (item: ItemDetails) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) {
      setError('Paste a Jellyfin URL or item ID.');
      return;
    }
    setBusy(true);
    setError(null);
    onBusyChange(true);
    try {
      const item = await api.resolve(value);
      onSelect(item);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <section className="wrap page-pad resolve" aria-labelledby="resolve-heading">
      <h1 id="resolve-heading">From URL</h1>
      <p className="lead">Paste a link to any movie or episode.</p>
      <form className="resolve-form" onSubmit={handleSubmit} noValidate>
        <label className="sr-only" htmlFor="resolve-input">
          Jellyfin URL or item ID
        </label>
        <div className="input-row">
          <input
            id="resolve-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
            placeholder="Jellyfin URL or item ID"
            aria-invalid={error ? true : undefined}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner label="Resolving" /> : 'Continue'}
          </button>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </form>
    </section>
  );
}
