import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { formatRuntime } from '../format';
import type { ItemDetails, MediaType, MediaItem } from '../types';
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

export function LibraryPanel({
  onSelect,
  onBusyChange,
}: {
  onSelect: (item: ItemDetails) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [crumbs, setCrumbs] = useState<Crumb[]>([ROOT_CRUMB]);
  const [startIndex, setStartIndex] = useState(0);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const current = crumbs[crumbs.length - 1];
  const searching = query.length > 0;
  const atRoot = !searching && current.id === null;

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
        } else if (current.id === null) {
          const result = await api.libraryViews();
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.items.length);
        } else if (current.type === 'Series') {
          const result = await api.librarySeasons(current.id);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        } else if (current.type === 'Season') {
          if (!current.seriesId) {
            setError('This season is missing its series reference.');
            setItems([]);
            setTotal(0);
            return;
          }
          const result = await api.libraryEpisodes(current.seriesId, current.id, startIndex, PAGE_SIZE);
          if (signal.cancelled) return;
          setItems(result.items);
          setTotal(result.total);
        } else {
          const result = await api.libraryItems(current.id, startIndex, PAGE_SIZE);
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
    [searching, query, current.id, current.type, current.seriesId, startIndex, onBusyChange],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    setStartIndex(0);
    setQuery(queryDraft.trim());
  }

  function goToCrumb(index: number) {
    setQuery('');
    setQueryDraft('');
    setStartIndex(0);
    setCrumbs((prev) => prev.slice(0, index + 1));
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
      setQuery('');
      setQueryDraft('');
      setStartIndex(0);
      const crumb: Crumb = {
        id: item.id,
        name: item.name,
        type: item.type,
        seriesId: item.seriesId ?? (item.type === 'Season' ? current.id ?? undefined : undefined),
      };
      setCrumbs((prev) => (searching ? [ROOT_CRUMB, crumb] : [...prev, crumb]));
      return;
    }
    void openItem(item);
  }

  const pageStart = total === 0 ? 0 : startIndex + 1;
  const pageEnd = Math.min(startIndex + items.length, total);
  const canPrev = startIndex > 0;
  const canNext = startIndex + PAGE_SIZE < total;
  const showPager = canPrev || canNext;

  const lead = searching
    ? `Search results for "${query}".`
    : atRoot
      ? 'Choose a library, then drill down through series and seasons to an episode.'
      : `Browsing ${current.name}.`;

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

      {error ? <ErrorBanner message={error} onRetry={() => void load({ cancelled: false })} /> : null}

      {busy && items.length === 0 ? (
        <div className="center-pad">
          <Spinner label="Loading library" />
        </div>
      ) : null}

      {!busy && items.length === 0 && !error ? (
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
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={browsable ? 'item-card item-card-browse' : 'item-card'}
                    onClick={() => activate(item)}
                    disabled={openId === item.id}
                    aria-busy={openId === item.id}
                  >
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
                onClick={() => setStartIndex((value) => Math.max(0, value - PAGE_SIZE))}
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
                onClick={() => setStartIndex((value) => value + PAGE_SIZE)}
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
