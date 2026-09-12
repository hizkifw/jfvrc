import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api';
import type { ItemDetails } from '../types';
import { ErrorBanner, Field, Spinner } from './ui';

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
      setError('Paste a Jellyfin item URL or enter an item id.');
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
    <section className="panel" aria-labelledby="resolve-heading">
      <h2 id="resolve-heading">Resolve a link</h2>
      <p className="panel-lead">
        Paste a Jellyfin movie or episode details URL. The item is validated against the configured
        server before any link is created.
      </p>
      <form onSubmit={handleSubmit} noValidate>
        <Field
          label="Jellyfin URL or item id"
          htmlFor="resolve-input"
          hint="Example: https://jellyfin.example.com/web/#/details?id=... or a 32-character item id."
        >
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
              placeholder="https://jellyfin.example.com/web/#/details?id=..."
              aria-invalid={error ? true : undefined}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner label="Resolving" /> : 'Resolve'}
            </button>
          </div>
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
      </form>
    </section>
  );
}
