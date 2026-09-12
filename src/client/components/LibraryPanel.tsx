import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, itemLabel } from '../api';
import { formatRuntime } from '../format';
import type { ItemDetails, MediaItem } from '../types';
import { EmptyState, ErrorBanner, Spinner } from './ui';

const PAGE_SIZE = 24;

export function LibraryPanel({
  onSelect,
  onBusyChange,
}: {
  onSelect: (item: ItemDetails) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [startIndex, setStartIndex] = useState(0);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      setBusy(true);
      setError(null);
      onBusyChange(true);
      try {
        const result = await api.library(query, startIndex, PAGE_SIZE);
        if (signal.cancelled) return;
        setItems(result.items);
        setTotal(result.total);
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
    [query, startIndex, onBusyChange],
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

  const pageStart = total === 0 ? 0 : startIndex + 1;
  const pageEnd = Math.min(startIndex + items.length, total);
  const canPrev = startIndex > 0;
  const canNext = startIndex + PAGE_SIZE < total;

  return (
    <section className="panel" aria-labelledby="library-heading">
      <h2 id="library-heading">Library</h2>
      <p className="panel-lead">
        Search movies and episodes recursively, then choose one to configure playback.
      </p>
      <form className="search-row" onSubmit={handleSearch}>
        <label className="sr-only" htmlFor="library-search">
          Search the library
        </label>
        <input
          id="library-search"
          type="search"
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          placeholder="Search by name"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {error ? <ErrorBanner message={error} onRetry={() => void load({ cancelled: false })} /> : null}

      {busy && items.length === 0 ? (
        <div className="center-pad">
          <Spinner label="Loading library" />
        </div>
      ) : null}

      {!busy && items.length === 0 && !error ? (
        <EmptyState title="No items found">
          {query ? `Nothing matched "${query}". Try a different search.` : 'The library is empty.'}
        </EmptyState>
      ) : null}

      {items.length > 0 ? (
        <>
          <ul className="item-grid">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="item-card"
                  onClick={() => void openItem(item)}
                  disabled={openId === item.id}
                  aria-busy={openId === item.id}
                >
                  <span className="item-type">{item.type}</span>
                  <span className="item-name">{itemLabel(item)}</span>
                  {item.name && item.type === 'Episode' ? (
                    <span className="item-sub">{item.name}</span>
                  ) : null}
                  <span className="item-meta">
                    {item.year ? <span>{item.year}</span> : null}
                    {formatRuntime(item.runTimeSeconds) ? (
                      <span>{formatRuntime(item.runTimeSeconds)}</span>
                    ) : null}
                  </span>
                  {openId === item.id ? (
                    <span className="item-loading">
                      <Spinner label="Loading item" />
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
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
        </>
      ) : null}
    </section>
  );
}
