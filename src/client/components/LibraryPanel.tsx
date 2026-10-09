import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { hasPoster, primaryPath } from '../art';
import { episodeCode, formatRuntime } from '../format';
import type { ItemDetails, MediaType, MediaItem } from '../types';
import { CardSkeleton, MediaCard } from './cards';
import { Hero, HeroSkeleton } from './Hero';
import { HomeSkeleton, HomeView } from './HomeView';
import { Icon } from './icons';
import { ItemDetail } from './ItemDetail';
import { LibraryBreadcrumbs, rememberItems, useLibraryCrumbs } from './LibraryCrumbs';
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

function isBrowsable(type: MediaType): boolean {
  return BROWSE_TYPES.has(type);
}

/** Breadcrumb label for an item, e.g. "S1 E1 · Episode title" for episodes. */
function itemCrumbLabel(item: MediaItem): string {
  const code = episodeCode(item);
  return code ? `${code} · ${item.name}` : item.name;
}

const CHILD_NOUNS: Partial<Record<MediaType, [string, string]>> = {
  Series: ['season', 'seasons'],
  Season: ['episode', 'episodes'],
};

function childLabel(item: MediaItem): string | null {
  if (!item.childCount) return null;
  const [one, many] = CHILD_NOUNS[item.type] ?? ['item', 'items'];
  return `${item.childCount} ${item.childCount === 1 ? one : many}`;
}

function metaFor(item: MediaItem, searching: boolean): string {
  return [
    item.type === 'Episode' ? (searching ? item.seriesName : null) : null,
    episodeCode(item),
    item.year && item.type !== 'Episode' ? String(item.year) : null,
    formatRuntime(item.runTimeSeconds),
    childLabel(item),
  ]
    .filter(Boolean)
    .join(' · ');
}

const SKELETON_CARDS = Array.from({ length: 12 }, (_, index) => index);

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
  const {
    crumbs,
    current: currentItem,
    hint,
    error: crumbError,
    retry: retryCrumbs,
  } = useLibraryCrumbs(path);
  const [list, setList] = useState<{ key: string; items: MediaItem[]; total: number }>({
    key: '',
    items: [],
    total: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const openItem = item && itemId && item.id === itemId ? item : null;
  const searching = query.length > 0;
  const currentId = path.length > 0 ? path[path.length - 1] : null;
  // What we know about the folder being browsed: full details once fetched, and until
  // then whatever the list we came from already told us, so the page can render at once.
  const current: MediaItem | undefined = currentItem ?? hint;
  const currentType = current?.type;
  const currentSeriesId =
    current?.seriesId ?? (path.length >= 2 ? path[path.length - 2] : undefined);

  // A list belongs to one location; after navigating, the old one is not shown as the new.
  const listKey = `${query}\n${path.join('/')}`;
  const fresh = list.key === listKey;
  const items = fresh ? list.items : [];
  const total = fresh ? list.total : 0;

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setBusy(true);
      setError(null);
      onBusyChange(true);
      const show = (loaded: MediaItem[], count: number) => {
        rememberItems(loaded);
        setList({ key: listKey, items: loaded, total: count });
      };
      try {
        if (searching) {
          const result = await api.library(query, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          show(result.items, result.total);
        } else if (!currentId) {
          const result = await api.libraryViews();
          if (signal.cancelled) return;
          show(result.items, result.items.length);
        } else if (currentType === 'Series') {
          const result = await api.librarySeasons(currentId);
          if (signal.cancelled) return;
          show(result.items, result.total);
        } else if (currentType === 'Season') {
          if (!currentSeriesId) {
            setError("Couldn't load this season. Open it from its series.");
            show([], 0);
            return;
          }
          const result = await api.libraryEpisodes(currentSeriesId, currentId, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          show(result.items, result.total);
        } else {
          const result = await api.libraryItems(currentId, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          show(result.items, result.total);
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
      listKey,
      currentId,
      currentType,
      currentSeriesId,
      startIndex,
      onBusyChange,
    ],
  );

  const resolvingCrumbs = !searching && path.length > 0 && !current;

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

  /** Browse into a container or open a playable item; `base` is the path leading to it. */
  function activate(item: MediaItem, base: string[] = searching ? [] : path) {
    if (!isBrowsable(item.type)) {
      void selectItem(item);
      return;
    }
    // A season reached from outside its series still needs the series in the path.
    const viaSeries =
      item.type === 'Season' && item.seriesId && !base.includes(item.seriesId) ? [item.seriesId] : [];
    onNavigate({ path: [...base, ...viaSeries, item.id], query: '', startIndex: 0 });
  }

  const atRoot = !searching && !currentId;
  const pageStart = total === 0 ? 0 : startIndex + 1;
  const pageEnd = Math.min(startIndex + items.length, total);
  const canPrev = startIndex > 0;
  const canNext = startIndex + PAGE_SIZE < total;
  const showPager = canPrev || canNext;

  const crumbNav = (
    <LibraryBreadcrumbs
      crumbs={crumbs}
      searching={searching}
      currentLabel={openItem ? itemCrumbLabel(openItem) : undefined}
      onCrumb={goToCrumb}
    />
  );

  if (itemId) {
    return (
      <>
        {crumbError ? (
          <div className="wrap page-pad">
            <ErrorBanner message={crumbError} onRetry={retryCrumbs} />
          </div>
        ) : null}
        <ItemDetail
          item={openItem}
          error={itemError}
          top={crumbNav}
          onClose={onCloseItem}
          onBrowse={(next) => onNavigate({ path: next, query: '', startIndex: 0 })}
          onRetry={onRetryItem}
          onCreated={onCreated}
        />
      </>
    );
  }

  const loading =
    !error && !crumbError && (resolvingCrumbs || !fresh || (busy && items.length === 0));

  if (atRoot && (loading || items.length > 0)) {
    return (
      <section aria-labelledby="library-heading">
        {loading ? (
          <HomeSkeleton />
        ) : (
          <HomeView views={items} openId={openId} onActivate={activate} />
        )}
      </section>
    );
  }

  const inSeries = !searching && currentType === 'Series';
  const inSeason = !searching && currentType === 'Season';
  const heroItem = (inSeries || inSeason) && current ? current : null;
  // A nested page reached by URL alone is almost always a series or season.
  const heroPending = resolvingCrumbs && path.length >= 2 && !crumbError;
  // Landscape cards only when every item is landscape; mixed lists share the poster frame.
  const wideGrid = loading ? false : items.every((entry) => !hasPoster(entry.type));
  const gridClass = wideGrid ? 'card-grid card-grid-wide' : 'card-grid';
  const heading = searching ? `Results for “${query}”` : atRoot ? 'Library' : (current?.name ?? null);

  return (
    <section aria-labelledby="library-heading">
      {heroItem ? (
        <Hero item={heroItem} top={crumbNav} headingId="library-heading" compact />
      ) : heroPending ? (
        <HeroSkeleton top={crumbNav} compact />
      ) : (
        <div className="wrap page-pad page-head">
          {atRoot ? null : crumbNav}
          <h1 id="library-heading">
            {heading ?? <span className="skeleton skeleton-text" aria-hidden="true" />}
          </h1>
          {atRoot ? null : (
            <p className="lead">
              {loading ? '\u00a0' : `${total} ${total === 1 ? 'item' : 'items'}`}
            </p>
          )}
        </div>
      )}

      <div className="wrap section">
        {heroItem ? (
          <h2 className="section-title">{inSeries ? 'Seasons' : 'Episodes'}</h2>
        ) : heroPending ? (
          <span className="skeleton skeleton-heading section-title" aria-hidden="true" />
        ) : null}

        {crumbError ? <ErrorBanner message={crumbError} onRetry={retryCrumbs} /> : null}

        {error ? (
          <ErrorBanner message={error} onRetry={() => void load({ cancelled: false })} />
        ) : null}

        {loading ? (
          <div
            className={inSeason ? 'episode-grid' : gridClass}
            role="status"
            aria-label="Loading library"
          >
            {SKELETON_CARDS.map((index) =>
              inSeason ? (
                <div key={index} className="card card-skeleton" aria-hidden="true">
                  <span className="card-art">
                    <span className="thumb thumb-wide thumb-loading" />
                  </span>
                  <span className="skeleton skeleton-line skeleton-line-short" />
                  <span className="skeleton skeleton-line" />
                  <span className="skeleton skeleton-line" />
                </div>
              ) : (
                <CardSkeleton key={index} variant={wideGrid ? 'wide' : 'poster'} />
              ),
            )}
          </div>
        ) : null}

        {!loading && items.length === 0 && !error && !crumbError ? (
          searching ? (
            <EmptyState title="No results" icon="search">
              {`Nothing matched “${query}”.`}
            </EmptyState>
          ) : (
            <EmptyState title={atRoot ? 'No libraries' : 'Nothing here'} icon="folder" />
          )
        ) : null}

        {items.length > 0 && inSeason ? (
          <ul className={busy ? 'episode-grid card-grid-busy' : 'episode-grid'}>
            {items.map((entry) => {
              const runtime = formatRuntime(entry.runTimeSeconds);
              const opening = openId === entry.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="card episode"
                    onClick={() => activate(entry)}
                    disabled={opening}
                    aria-busy={opening}
                  >
                    <span className="card-art">
                      <Thumbnail path={primaryPath(entry)} alt="" variant="wide" />
                      {opening ? (
                        <span className="card-loading">
                          <Spinner label="Loading item" />
                        </span>
                      ) : null}
                    </span>
                    <span className="episode-number">
                      {entry.episodeNumber !== undefined ? `Episode ${entry.episodeNumber}` : 'Episode'}
                    </span>
                    <span className="card-title">{entry.name}</span>
                    {entry.overview ? <span className="episode-overview">{entry.overview}</span> : null}
                    {runtime ? <span className="card-meta">{runtime}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {items.length > 0 && !inSeason ? (
          <ul className={busy ? `${gridClass} card-grid-busy` : gridClass}>
            {items.map((entry) => (
              <li key={entry.id}>
                <MediaCard
                  path={primaryPath(entry)}
                  variant={wideGrid ? 'wide' : 'poster'}
                  title={entry.name}
                  meta={metaFor(entry, searching)}
                  badge={searching ? TYPE_LABELS[entry.type] : null}
                  fallbackIcon={isBrowsable(entry.type) ? 'folder' : 'film'}
                  busy={openId === entry.id}
                  onClick={() => activate(entry)}
                />
              </li>
            ))}
          </ul>
        ) : null}

        {items.length > 0 && showPager ? (
          <nav className="pager" aria-label="Library pagination">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => onNavigate({ startIndex: Math.max(0, startIndex - PAGE_SIZE) })}
              disabled={!canPrev || busy}
            >
              <Icon name="chevron-left" size={16} />
              Previous
            </button>
            <span className="pager-status" role="status" aria-live="polite">
              {`${pageStart}–${pageEnd} of ${total}`}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => onNavigate({ startIndex: startIndex + PAGE_SIZE })}
              disabled={!canNext || busy}
            >
              Next
              <Icon name="chevron-right" size={16} />
            </button>
          </nav>
        ) : null}
      </div>
    </section>
  );
}
