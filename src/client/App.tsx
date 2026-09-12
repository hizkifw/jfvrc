import { useCallback, useEffect, useState } from 'react';
import {
  api,
  errorMessage,
  setAdminToken,
  setUnauthorizedHandler,
} from './api';
import { ItemPanel } from './components/ItemPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { LinksPanel } from './components/LinksPanel';
import { ResolvePanel } from './components/ResolvePanel';
import { TokenGate } from './components/TokenGate';
import type { ItemDetails, StatusResponse } from './types';

type Tab = 'resolve' | 'library' | 'links';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'resolve', label: 'Resolve' },
  { id: 'library', label: 'Library' },
  { id: 'links', label: 'Links' },
];

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('resolve');
  const [selectedItem, setSelectedItem] = useState<ItemDetails | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);

  const handleBusyChange = useCallback((value: boolean) => {
    setBusy(value);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdminToken('');
      setToken(null);
      setStatus(null);
      setSelectedItem(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setStatusError(null);
    api
      .status()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((err) => {
        if (!cancelled) setStatusError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleConnect = useCallback(async (value: string) => {
    setAdminToken(value);
    try {
      const result = await api.status();
      setStatus(result);
      setStatusError(null);
      setToken(value);
    } catch (err) {
      setAdminToken('');
      throw err;
    }
  }, []);

  function lock() {
    setAdminToken('');
    setToken(null);
    setStatus(null);
    setSelectedItem(null);
  }

  function selectTab(next: Tab) {
    setTab(next);
    setSelectedItem(null);
  }

  if (!token) {
    return <TokenGate onConnect={handleConnect} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            JF
          </span>
          <span className="brand-name">JFVRC</span>
        </div>
        <div className="header-meta">
          {status ? (
            <span className={status.configured ? 'pill pill-ok' : 'pill pill-warn'}>
              {status.configured ? 'Jellyfin configured' : 'Not configured'}
            </span>
          ) : (
            <span className="pill">Checking status…</span>
          )}
          <button type="button" className="btn btn-small btn-ghost" onClick={lock}>
            Lock
          </button>
        </div>
      </header>

      {busy ? <div className="progress" role="progressbar" aria-label="Working" /> : null}

      {statusError ? (
        <div className="wrap">
          <p className="banner banner-error" role="alert">
            {statusError}
          </p>
        </div>
      ) : null}

      {status && !status.configured ? (
        <div className="wrap">
          <p className="banner banner-warn" role="status">
            The server has no Jellyfin connection configured. Set the environment variables before
            creating links.
          </p>
        </div>
      ) : null}

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={tab === entry.id && !selectedItem}
            aria-controls={`panel-${entry.id}`}
            className={tab === entry.id && !selectedItem ? 'tab tab-active' : 'tab'}
            onClick={() => selectTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="wrap" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {selectedItem ? (
          <ItemPanel
            item={selectedItem}
            onClose={() => setSelectedItem(null)}
            onCreated={() => setReloadToken((value) => value + 1)}
          />
        ) : tab === 'resolve' ? (
          <ResolvePanel onSelect={setSelectedItem} onBusyChange={handleBusyChange} />
        ) : tab === 'library' ? (
          <LibraryPanel onSelect={setSelectedItem} onBusyChange={handleBusyChange} />
        ) : (
          <LinksPanel reloadToken={reloadToken} />
        )}
      </main>

      <footer className="app-footer">
        {status ? (
          <p>
            Server {status.jellyfinUrl || 'unset'} · Public {status.publicBaseUrl || 'unset'}
          </p>
        ) : null}
        <p>Links are bearer URLs. Share only with trusted viewers.</p>
      </footer>
    </div>
  );
}
