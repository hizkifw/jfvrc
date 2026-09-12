import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { formatRuntime } from '../format';
import type { ItemDetails, MediaType, MediaItem } from '../types';
import { Thumbnail } from './Thumbnail';
import { EmptyState, ErrorBanner, Spinner } from './ui';

const PAGE_SIZE = 24;

interface Crumb {
  id: string | null;
  name: string;
  type?: MediaType;
  seriesId?: string;
}

const ROOT_CRUMB: Crumb = { id: null, name: 'Libraries' };

const BROWSE_TYPES: ReadonlySet<MediaType> = new Set<MediaType>([
  'Series',
  'Season',
  'Folder',
  'CollectionFolder',
  'BoxSet',
]);

const TYPE_LABELS: Record<MediaType, string> = {
  Movie: 'Movie',
  Episode: 'Episode',
  Series: 'Series',
  Season: 'Season',
  Folder: 'Folder',
  CollectionFolder: 'Library',
  BoxSet: 'Collection',
  Video: 'Video',
};

/** Movies, series and seasons use portrait posters; episodes use landscape stills. */
const POSTER_TYPES: ReadonlySet<MediaType> = new Set<MediaType>([
  'Movie',
  'Series',
  'Season',
  'BoxSet',
  'CollectionFolder',
]);

function thumbnailVariant(type: MediaType): 'poster' | 'wide' {
  return POSTER_TYPES.has(type) ? 'poster' : 'wide';
}

function isBrowsable(type: MediaType): boolean {
  return BROWSE_TYPES.has(type);
}

function episodeCode(item: MediaItem): string | null {
  if (item.type !== 'Episode') return null;
  const season = item.seasonNumber !== undefined ? `S${item.seasonNumber}` : '';
  const episode = item.episodeNumber !== undefined ? `E${item.episodeNumber}` : '';
  return `${season}${episode}` || null;
}

function subtitleFor(item: MediaItem, searching: boolean): string | null {
  if (item.type === 'Episode') {
    return [searching ? item.seriesName : null, episodeCode(item)].filter(Boolean).join(' · ') || null;
  }
  if (item.type === 'Series' && item.year) return String(item.year);
  return null;
}

function childLabel(item: MediaItem): string | null {
  if (!item.childCount) return null;
  return `${item.childCount} ${item.childCount === 1 ? 'item' : 'items'}`;
}

function imagePathFor(item: MediaItem): string | null {
  const size =
    thumbnailVariant(item.type) === 'poster'
      ? { width: 300, height: 450 }
      : { width: 400, height: 225 };
  if (item.imageTag) {
    return api.imagePath(item.id, { tag: item.imageTag, ...size });
  }
  if (item.backdropTag) {
    return api.imagePath(item.id, { type: 'Backdrop', index: 0, tag: item.backdropTag, ...size });
  }
  return null;
}

export interface LibraryNavigation {
  path?: string[];
  query?: string;
  startIndex?: number;
}

export function LibraryPanel({
  path,
  query,
  startIndex,
  onNavigate,
  onSelect,
  onBusyChange,
}: {
  path: string[];
  query: string;
  startIndex: number;
  onNavigate: (next: LibraryNavigation) => void;
  onSelect: (item: ItemDetails) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [queryDraft, setQueryDraft] = useState(query);
  const [crumbState, setCrumbState] = useState<{ key: string; crumbs: Crumb[] }>({
    key: '',
    crumbs: [ROOT_CRUMB],
  });
  const [crumbError, setCrumbError] = useState<string | null>(null);
  const [crumbReload, setCrumbReload] = useState(0);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const itemCache = useRef(new Map<string, ItemDetails>());

  const pathKey = path.join('/');
  const searching = query.length > 0;
  const resolved = crumbState.key === pathKey;
  const crumbs = resolved ? crumbState.crumbs : [ROOT_CRUMB];
  const currentId = path.length > 0 ? path[path.length - 1] : null;
  const current = resolved && path.length > 0 ? crumbs[crumbs.length - 1] : undefined;
  const currentType = current?.type;
  const currentSeriesId =
    current?.seriesId ?? (path.length >= 2 ? path[path.length - 2] : undefined);

  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  // Rebuild breadcrumb names/types for the URL path (also restores them on reload).
  useEffect(() => {
    if (!pathKey) {
      setCrumbState({ key: '', crumbs: [ROOT_CRUMB] });
      setCrumbError(null);
      return;
    }
    let cancelled = false;
    setCrumbError(null);
    Promise.all(
      path.map((id) => {
        const cached = itemCache.current.get(id);
        return cached ? Promise.resolve(cached) : api.item(id);
      }),
    )
      .then((details) => {
        if (cancelled) return;
        details.forEach((detail) => itemCache.current.set(detail.id, detail));
        setCrumbState({
          key: pathKey,
          crumbs: [
            ROOT_CRUMB,
            ...details.map((detail) => ({
              id: detail.id,
              name: detail.name,
              type: detail.type,
              seriesId: detail.seriesId,
            })),
          ],
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setCrumbError(errorMessage(err));
        setCrumbState({ key: pathKey, crumbs: [ROOT_CRUMB] });
      });
    return () => {
      cancelled = true;
    };
  }, [pathKey, crumbReload]);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setBusy(true);
      setError(null);
      onBusyChange(true);
      try {
        if (searching) {
          const result = await api.library(query, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        } else if (!currentId) {
          const result = await api.libraryViews();
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.items.length);
        } else if (currentType === 'Series') {
          const result = await api.librarySeasons(currentId);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        } else if (currentType === 'Season') {
          if (!currentSeriesId) {
            setError('This season is missing its series reference.');
            setItems([]);
            setTotal(0);
            return;
          }
          const result = await api.libraryEpisodes(currentSeriesId, currentId, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        } else {
          const result = await api.libraryItems(currentId, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        }
      } catch (err) {
        if (signal.cancelled) return;
        setError(errorMessage(err));
      } finally {
        if (!signal.cancelled) {
          setBusy(false);
          onBusyChange(false);
        }
      }
    },
    [
      searching,
      query,
      currentId,
      currentType,
      currentSeriesId,
      startIndex,
      onBusyChange,
    ],
  );

  const resolvingCrumbs = !searching && path.length > 0 && !resolved;

  useEffect(() => {
    if (!searching && crumbError) return;
    if (!searching && resolvingCrumbs) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load, searching, crumbError, resolvingCrumbs]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    onNavigate({ query: queryDraft.trim(), startIndex: 0 });
  }

  function goToCrumb(index: number) {
    onNavigate({ path: path.slice(0, index), query: '', startIndex: 0 });
  }

  async function openItem(item: MediaItem) {
    setOpenId(item.id);
    setError(null);
    onBusyChange(true);
    try {
      const details = await api.item(item.id);
      onSelect(details);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpenId(null);
      onBusyChange(false);
    }
  }

  function activate(item: MediaItem) {
    if (isBrowsable(item.type)) {
      onNavigate({
        path: searching ? [item.id] : [...path, item.id],
        query: '',
        startIndex: 0,
      });
      return;
    }
    void openItem(item);
  }

  const atRoot = !searching && !currentId;
  const pageStart = total === 0 ? 0 : startIndex + 1;
  const pageEnd = Math.min(startIndex + items.length, total);
  const canPrev = startIndex > 0;
  const canNext = startIndex + PAGE_SIZE < total;
  const showPager = canPrev || canNext;

  const lead = searching
    ? `Search results for "${query}".`
    : atRoot
      ? 'Choose a library, then drill down through series and seasons to an episode.'
      : `Browsing ${current?.name ?? '…'}.`;

  return (
    <section className="panel" aria-labelledby="library-heading">
      <h2 id="library-heading">Library</h2>
      <p className="panel-lead">{lead}</p>

      <form className="search-row" onSubmit={handleSearch}>
        <label className="sr-only" htmlFor="library-search">
          Search the library
        </label>
        <input
          id="library-search"
          type="search"
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          placeholder="Search movies, shows and episodes"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      <nav className="crumbs" aria-label="Library location">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.id ?? 'root'}-${index}`}>
            {index > 0 ? (
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            <button
              type="button"
              className="crumb"
              onClick={() => goToCrumb(index)}
              aria-current={!searching && index === crumbs.length - 1 ? 'page' : undefined}
            >
              {crumb.name}
            </button>
          </Fragment>
        ))}
        {searching ? (
          <>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb crumb-static" aria-current="page">
              Search
            </span>
          </>
        ) : null}
      </nav>

      {crumbError ? (
        <ErrorBanner message={crumbError} onRetry={() => setCrumbReload((value) => value + 1)} />
      ) : null}

      {error ? <ErrorBanner message={error} onRetry={() => void load({ cancelled: false })} /> : null}

      {resolvingCrumbs || (busy && items.length === 0) ? (
        <div className="center-pad">
          <Spinner label="Loading library" />
        </div>
      ) : null}

      {!resolvingCrumbs && !busy && items.length === 0 && !error && !crumbError ? (
        <EmptyState title="No items found">
          {searching
            ? `Nothing matched "${query}". Try a different search.`
            : atRoot
              ? 'No libraries are available for this account.'
              : 'This folder has no items.'}
        </EmptyState>
      ) : null}

      {items.length > 0 ? (
        <>
          <ul className="item-grid">
            {items.map((item) => {
              const browsable = isBrowsable(item.type);
              const subtitle = subtitleFor(item, searching);
              const children = childLabel(item);
              const runtime = formatRuntime(item.runTimeSeconds);
              const imagePath = imagePathFor(item);
              const variant = thumbnailVariant(item.type);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={browsable ? 'item-card item-card-browse' : 'item-card'}
                    onClick={() => activate(item)}
                    disabled={openId === item.id}
                    aria-busy={openId === item.id}
                  >
                    {imagePath ? (
                      <Thumbnail path={imagePath} alt="" variant={variant} />
                    ) : (
                      <span
                        className={
                          variant === 'poster'
                            ? 'thumb thumb-poster thumb-fallback'
                            : 'thumb thumb-wide thumb-fallback'
                        }
                        aria-hidden="true"
                      />
                    )}
                    <span className="item-type">{TYPE_LABELS[item.type]}</span>
                    <span className="item-name">{item.name}</span>
                    {subtitle ? <span className="item-sub">{subtitle}</span> : null}
                    <span className="item-meta">
                      {item.year && item.type !== 'Series' ? <span>{item.year}</span> : null}
                      {runtime ? <span>{runtime}</span> : null}
                      {children ? <span>{children}</span> : null}
                    </span>
                    {browsable ? (
                      <span className="item-chevron" aria-hidden="true">
                        ›
                      </span>
                    ) : null}
                    {openId === item.id ? (
                      <span className="item-loading">
                        <Spinner label="Loading item" />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {showPager ? (
            <nav className="pager" aria-label="Library pagination">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => onNavigate({ startIndex: Math.max(0, startIndex - PAGE_SIZE) })}
                disabled={!canPrev || busy}
              >
                Previous
              </button>
              <span className="pager-status" role="status" aria-live="polite">
                {total > 0 ? `${pageStart}–${pageEnd} of ${total}` : 'No results'}
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => onNavigate({ startIndex: startIndex + PAGE_SIZE })}
                disabled={!canNext || busy}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
