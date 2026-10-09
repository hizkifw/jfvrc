import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { formatDateTime, relativeExpiry } from '../format';
import type { LinkSummary } from '../types';
import { Icon } from './icons';
import { EmptyState, ErrorBanner, Spinner } from './ui';

type Filter = 'all' | 'active' | 'inactive';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Ended' },
];

function isActive(link: LinkSummary): boolean {
  return !link.revoked && new Date(link.expiresAt).getTime() > Date.now();
}

export function LinksPanel({ reloadToken }: { reloadToken: number }) {
  const [links, setLinks] = useState<LinkSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.listLinks();
      setLinks(result.links);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  async function revoke(id: string) {
    setRevokingId(id);
    setError(null);
    try {
      await api.revokeLink(id);
      setLinks((current) =>
        current.map((link) => (link.id === id ? { ...link, revoked: true } : link)),
      );
      setConfirmId(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRevokingId(null);
    }
  }

  const activeCount = links.filter(isActive).length;
  const counts: Record<Filter, number> = {
    all: links.length,
    active: activeCount,
    inactive: links.length - activeCount,
  };
  const visible = links.filter(
    (link) => filter === 'all' || isActive(link) === (filter === 'active'),
  );

  return (
    <section className="wrap page-pad narrow" aria-labelledby="links-heading">
      <div className="links-head">
        <div className="page-head-text">
          <h1 id="links-heading">Links</h1>
        </div>
        <div className="page-head-actions">
          <div className="segmented" role="group" aria-label="Filter links">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={filter === entry.id ? 'segment segment-active' : 'segment'}
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
                <span className="segment-count">{counts[entry.id]}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="round-btn"
            onClick={() => void load()}
            disabled={busy}
            aria-label="Refresh links"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      {busy && links.length === 0 ? (
        <div className="center-pad">
          <Spinner label="Loading links" />
        </div>
      ) : null}

      {!busy && links.length === 0 && !error ? (
        <EmptyState title="No links yet" icon="link">
          Create one from any movie or episode.
        </EmptyState>
      ) : null}

      {links.length > 0 && visible.length === 0 ? (
        <EmptyState title={filter === 'active' ? 'No active links' : 'No ended links'} icon="link" />
      ) : null}

      {visible.length > 0 ? (
        <ul className="link-list">
          {visible.map((link) => {
            const active = isActive(link);
            const state = link.revoked ? 'Revoked' : active ? 'Active' : 'Expired';
            return (
              <li key={link.id} className={active ? 'link-row' : 'link-row link-inactive'}>
                <span
                  className={active ? 'link-state link-state-active' : 'link-state'}
                  aria-hidden="true"
                >
                  <Icon name={link.revoked ? 'ban' : 'link'} />
                </span>
                <div className="link-main">
                  <p className="link-title">{link.title}</p>
                  <p className="link-meta">
                    <span className={active ? 'badge badge-ok' : 'badge'}>{state}</span>
                    <span>{link.preset}</span>
                    <span>
                      {link.subtitleStreamIndex === -1
                        ? 'No subtitles'
                        : 'Subtitles'}
                    </span>
                    <span>Created {formatDateTime(link.createdAt)}</span>
                  </p>
                </div>
                <p className="link-expiry">
                  {active ? (
                    <>
                      <strong>Expires {relativeExpiry(link.expiresAt)}</strong>
                    </>
                  ) : link.revoked ? null : (
                    <span>Expired {formatDateTime(link.expiresAt)}</span>
                  )}
                </p>
                <div className="link-actions">
                  {!active ? null : confirmId === link.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        onClick={() => void revoke(link.id)}
                        disabled={revokingId === link.id}
                      >
                        {revokingId === link.id ? <Spinner label="Revoking" /> : 'Revoke Link'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() => setConfirmId(null)}
                        disabled={revokingId === link.id}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setConfirmId(link.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
