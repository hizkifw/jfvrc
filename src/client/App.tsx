import { useCallback, useEffect, useState } from 'react';
import {
  api,
  clearStoredToken,
  errorMessage,
  readStoredToken,
  setAdminToken,
  setUnauthorizedHandler,
  storeToken,
} from './api';
import { ItemDetail } from './components/ItemDetail';
import { LibraryPanel } from './components/LibraryPanel';
import { LinksPanel } from './components/LinksPanel';
import { ResolvePanel } from './components/ResolvePanel';
import { TokenGate } from './components/TokenGate';
import { DEFAULT_ROUTE, useRoute } from './router';
import type { Route, Tab } from './router';
import type { ItemDetails, StatusResponse } from './types';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'resolve', label: 'Resolve' },
  { id: 'library', label: 'Library' },
  { id: 'links', label: 'Links' },
];

export function App() {
  const [route, navigate] = useRoute();
  const [token, setToken] = useState<string | null>(() => {
    const stored = readStoredToken();
    if (stored) setAdminToken(stored);
    return stored;
  });
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemDetails | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemReload, setItemReload] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);

  const handleBusyChange = useCallback((value: boolean) => {
    setBusy(value);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdminToken('');
      clearStoredToken();
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

  // Restore the open item from the URL (e.g. after a reload or a shared link).
  useEffect(() => {
    if (!token) return;
    const itemId = route.itemId;
    if (!itemId) {
      setSelectedItem(null);
      setItemError(null);
      return;
    }
    if (selectedItem?.id === itemId) return;
    let cancelled = false;
    setItemError(null);
    api
      .item(itemId)
      .then((details) => {
        if (!cancelled) setSelectedItem(details);
      })
      .catch((err) => {
        if (!cancelled) {
          setSelectedItem(null);
          setItemError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [route.itemId, token, selectedItem?.id, itemReload]);

  const handleConnect = useCallback(async (value: string, remember: boolean) => {
    setAdminToken(value);
    try {
      const result = await api.status();
      setStatus(result);
      setStatusError(null);
      storeToken(value, remember);
      setToken(value);
    } catch (err) {
      setAdminToken('');
      clearStoredToken();
      throw err;
    }
  }, []);

  const handleSelect = useCallback(
    (item: ItemDetails) => {
      setSelectedItem(item);
      setItemError(null);
      navigate({ ...route, itemId: item.id });
    },
    [navigate, route],
  );

  const handleLibraryNavigate = useCallback(
    (next: Partial<Pick<Route, 'path' | 'query' | 'startIndex'>>) => {
      navigate({ ...route, tab: 'library', ...next, itemId: null });
    },
    [navigate, route],
  );

  const closeItem = useCallback(() => {
    setSelectedItem(null);
    setItemError(null);
    navigate({ ...route, itemId: null });
  }, [navigate, route]);

  function lock() {
    setAdminToken('');
    clearStoredToken();
    setToken(null);
    setStatus(null);
    setSelectedItem(null);
  }

  function selectTab(tab: Tab) {
    setSelectedItem(null);
    navigate({ ...DEFAULT_ROUTE, tab });
  }

  if (!token) {
    return <TokenGate onConnect={handleConnect} />;
  }

  const openItem = route.itemId && selectedItem?.id === route.itemId ? selectedItem : null;

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
            aria-selected={route.tab === entry.id}
            aria-controls={`panel-${entry.id}`}
            className={route.tab === entry.id ? 'tab tab-active' : 'tab'}
            onClick={() => selectTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main className="wrap" role="tabpanel" id={`panel-${route.tab}`} aria-labelledby={`tab-${route.tab}`}>
        {route.tab === 'library' ? (
          <LibraryPanel
            path={route.path}
            query={route.query}
            startIndex={route.startIndex}
            itemId={route.itemId}
            item={openItem}
            itemError={itemError}
            onNavigate={handleLibraryNavigate}
            onSelect={handleSelect}
            onCloseItem={closeItem}
            onRetryItem={() => setItemReload((value) => value + 1)}
            onCreated={() => setReloadToken((value) => value + 1)}
            onBusyChange={handleBusyChange}
          />
        ) : route.itemId ? (
          <ItemDetail
            item={openItem}
            error={itemError}
            onClose={closeItem}
            onRetry={() => setItemReload((value) => value + 1)}
            onCreated={() => setReloadToken((value) => value + 1)}
          />
        ) : route.tab === 'resolve' ? (
          <ResolvePanel onSelect={handleSelect} onBusyChange={handleBusyChange} />
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
