import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { formatRuntime } from '../format';
import type { ItemDetails, MediaType, MediaItem } from '../types';
import { ItemDetail } from './ItemDetail';
import { LibraryBreadcrumbs, useLibraryCrumbs } from './LibraryCrumbs';
import { Thumbnail } from './Thumbnail';
import { EmptyState, ErrorBanner, Spinner } from './ui';

const PAGE_SIZE = 24;

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

/** Breadcrumb label for an item, e.g. "S1E1 · Episode title" for episodes. */
function itemCrumbLabel(item: MediaItem): string {
  const code = episodeCode(item);
  return code ? `${code} · ${item.name}` : item.name;
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
  itemId,
  item,
  itemError,
  onNavigate,
  onSelect,
  onCloseItem,
  onRetryItem,
  onCreated,
  onBusyChange,
}: {
  path: string[];
  query: string;
  startIndex: number;
  itemId: string | null;
  item: ItemDetails | null;
  itemError: string | null;
  onNavigate: (next: LibraryNavigation) => void;
  onSelect: (item: ItemDetails) => void;
  onCloseItem: () => void;
  onRetryItem: () => void;
  onCreated: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [queryDraft, setQueryDraft] = useState(query);
  const { crumbs, resolved, error: crumbError, retry: retryCrumbs } = useLibraryCrumbs(path);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const openItem = item && itemId && item.id === itemId ? item : null;
  const searching = query.length > 0;
  const currentId = path.length > 0 ? path[path.length - 1] : null;
  const current = resolved && path.length > 0 ? crumbs[crumbs.length - 1] : undefined;
  const currentType = current?.type;
  const currentSeriesId =
    current?.seriesId ?? (path.length >= 2 ? path[path.length - 2] : undefined);

  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

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
    if (itemId) return;
    if (!searching && crumbError) return;
    if (!searching && resolvingCrumbs) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load, searching, crumbError, resolvingCrumbs, itemId]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    onNavigate({ query: queryDraft.trim(), startIndex: 0 });
  }

  function goToCrumb(index: number) {
    onNavigate({ path: path.slice(0, index), query: '', startIndex: 0 });
  }

  async function selectItem(entry: MediaItem) {
    setOpenId(entry.id);
    setError(null);
    onBusyChange(true);
    try {
      const details = await api.item(entry.id);
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
    void selectItem(item);
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

  if (itemId) {
    return (
      <>
        <div className="section-crumbs">
          <LibraryBreadcrumbs
            crumbs={crumbs}
            searching={searching}
            currentLabel={openItem ? itemCrumbLabel(openItem) : undefined}
            onCrumb={goToCrumb}
          />
        </div>
        {crumbError ? <ErrorBanner message={crumbError} onRetry={retryCrumbs} /> : null}
        <ItemDetail
          item={openItem}
          error={itemError}
          onClose={onCloseItem}
          onRetry={onRetryItem}
          onCreated={onCreated}
        />
      </>
    );
  }

  return (
    <>
      <div className="section-crumbs">
        <LibraryBreadcrumbs crumbs={crumbs} searching={searching} onCrumb={goToCrumb} />
      </div>

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

        {crumbError ? <ErrorBanner message={crumbError} onRetry={retryCrumbs} /> : null}

        {error ? (
          <ErrorBanner message={error} onRetry={() => void load({ cancelled: false })} />
        ) : null}

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
              {items.map((entry) => {
                const browsable = isBrowsable(entry.type);
                const subtitle = subtitleFor(entry, searching);
                const children = childLabel(entry);
                const runtime = formatRuntime(entry.runTimeSeconds);
                const imagePath = imagePathFor(entry);
                const variant = thumbnailVariant(entry.type);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={browsable ? 'item-card item-card-browse' : 'item-card'}
                      onClick={() => activate(entry)}
                      disabled={openId === entry.id}
                      aria-busy={openId === entry.id}
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
                      <span className="item-type">{TYPE_LABELS[entry.type]}</span>
                      <span className="item-name">{entry.name}</span>
                      {subtitle ? <span className="item-sub">{subtitle}</span> : null}
                      <span className="item-meta">
                        {entry.year && entry.type !== 'Series' ? <span>{entry.year}</span> : null}
                        {runtime ? <span>{runtime}</span> : null}
                        {children ? <span>{children}</span> : null}
                      </span>
                      {browsable ? (
                        <span className="item-chevron" aria-hidden="true">
                          ›
                        </span>
                      ) : null}
                      {openId === entry.id ? (
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
    </>
  );
}
