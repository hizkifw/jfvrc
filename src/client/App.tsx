import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
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
import { BrandMark, Icon } from './components/icons';
import type { IconName } from './components/icons';
import { DEFAULT_ROUTE, useRoute } from './router';
import type { Route, Tab } from './router';
import type { ItemDetails, StatusResponse } from './types';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'library', label: 'Library', icon: 'grid' },
  { id: 'resolve', label: 'From URL', icon: 'clipboard' },
  { id: 'links', label: 'Links', icon: 'link' },
];

/** Host portion of a URL for compact display, falling back to the raw value. */
function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
  const [searchDraft, setSearchDraft] = useState(route.query);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    setSearchDraft(route.query);
  }, [route.query]);

  // The bar floats over artwork at the top of a page and turns solid once content scrolls under it.
  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > 8);
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    return () => window.removeEventListener('scroll', sync);
  }, []);

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

  // An episode opened without its series in the URL (from the home page, search-free
  // deep links) gains that trail, so the breadcrumbs lead back to its season and series.
  useEffect(() => {
    if (route.tab !== 'library' || !selectedItem || selectedItem.id !== route.itemId) return;
    if (route.path.length > 0 || route.query || !selectedItem.seriesId) return;
    const trail = [selectedItem.seriesId, ...(selectedItem.seasonId ? [selectedItem.seasonId] : [])];
    navigate({ ...route, path: trail }, { replace: true });
  }, [navigate, route, selectedItem]);

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

  function search(query: string) {
    const base = route.tab === 'library' ? route : DEFAULT_ROUTE;
    navigate({ ...base, tab: 'library', query, startIndex: 0, itemId: null });
  }

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    search(searchDraft.trim());
  }

  function selectTab(tab: Tab) {
    setSelectedItem(null);
    navigate({ ...DEFAULT_ROUTE, tab });
  }

  if (!token) {
    return <TokenGate onConnect={handleConnect} />;
  }

  const openItem = route.itemId && selectedItem?.id === route.itemId ? selectedItem : null;

  const browseTo = (path: string[]) => navigate({ ...DEFAULT_ROUTE, tab: 'library', path });
  const retryItem = () => setItemReload((value) => value + 1);
  const notifyCreated = () => setReloadToken((value) => value + 1);

  return (
    <div className="app">
      <header className={scrolled ? 'topbar topbar-solid' : 'topbar'}>
        <button
          type="button"
          className="brand"
          onClick={() => selectTab('library')}
          aria-label="JFVRC home"
        >
          <BrandMark />
          <span className="brand-name">JFVRC</span>
        </button>

        <div className="topbar-meta">
          <form className="search" role="search" onSubmit={handleSearch}>
            <label className="sr-only" htmlFor="library-search">
              Search the library
            </label>
            <Icon name="search" size={16} />
            <input
              id="library-search"
              type="search"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search"
              autoComplete="off"
              enterKeyHint="search"
            />
            {route.query ? (
              <button
                type="button"
                className="search-clear"
                onClick={() => search('')}
                aria-label="Clear search"
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </form>
          {status ? (
            <span
              className={status.configured ? 'status status-ok' : 'status status-warn'}
              title={
                status.configured
                  ? `Connected to ${displayHost(status.jellyfinUrl)}`
                  : "Jellyfin isn't connected"
              }
            >
              <span className="status-dot" aria-hidden="true" />
              <span className="sr-only">
                {status.configured ? 'Jellyfin connected' : 'Jellyfin not connected'}
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className="round-btn"
            onClick={lock}
            aria-label="Sign Out"
            title="Sign Out"
          >
            <Icon name="logout" size={16} />
          </button>
        </div>
      </header>

      <nav className="nav" role="tablist" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={route.tab === entry.id}
            aria-controls={`panel-${entry.id}`}
            className={route.tab === entry.id ? 'nav-item nav-item-active' : 'nav-item'}
            onClick={() => selectTab(entry.id)}
          >
            <Icon name={entry.icon} size={22} />
            <span>{entry.label}</span>
          </button>
        ))}
      </nav>

      {busy ? <div className="progress" role="progressbar" aria-label="Working" /> : null}

      <main className="page" role="tabpanel" id={`panel-${route.tab}`} aria-labelledby={`tab-${route.tab}`}>
        {statusError ? (
          <div className="wrap page-pad">
            <p className="banner banner-error" role="alert">
              <Icon name="alert" />
              <span className="banner-text">{statusError}</span>
            </p>
          </div>
        ) : null}

        {status && !status.configured ? (
          <div className="wrap page-pad">
            <p className="banner banner-warn" role="status">
              <Icon name="alert" />
              <span className="banner-text">
                Jellyfin isn't connected. Set it up on the server to create links.
              </span>
            </p>
          </div>
        ) : null}

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
            onRetryItem={retryItem}
            onCreated={notifyCreated}
            onBusyChange={handleBusyChange}
          />
        ) : route.itemId ? (
          <ItemDetail
            item={openItem}
            error={itemError}
            top={
              <button type="button" className="back-link" onClick={closeItem}>
                <Icon name="chevron-left" size={16} />
                Back
              </button>
            }
            onClose={closeItem}
            onBrowse={browseTo}
            onRetry={retryItem}
            onCreated={notifyCreated}
          />
        ) : route.tab === 'resolve' ? (
          <ResolvePanel onSelect={handleSelect} onBusyChange={handleBusyChange} />
        ) : (
          <LinksPanel reloadToken={reloadToken} />
        )}
      </main>
    </div>
  );
}
