import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { formatDateTime, relativeExpiry } from '../format';
import type { LinkSummary } from '../types';
import { CopyButton, EmptyState, ErrorBanner, Spinner } from './ui';

export function LinksPanel({ reloadToken }: { reloadToken: number }) {
  const [links, setLinks] = useState<LinkSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  return (
    <section className="panel" aria-labelledby="links-heading">
      <div className="panel-head">
        <div>
          <h2 id="links-heading">Links</h2>
          <p className="panel-lead">Revoke a link to stop new playback sessions immediately.</p>
        </div>
        <button type="button" className="btn btn-small" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

      {busy && links.length === 0 ? (
        <div className="center-pad">
          <Spinner label="Loading links" />
        </div>
      ) : null}

      {!busy && links.length === 0 && !error ? (
        <EmptyState title="No links yet">
          Resolve an item and create a link to see it here.
        </EmptyState>
      ) : null}

      {links.length > 0 ? (
        <ul className="link-list">
          {links.map((link) => {
            const expired = new Date(link.expiresAt).getTime() <= Date.now();
            const inactive = link.revoked || expired;
            return (
              <li key={link.id} className={inactive ? 'link-row link-inactive' : 'link-row'}>
                <div className="link-main">
                  <p className="link-title">{link.title}</p>
                  <p className="link-meta">
                    <span className="badge">{link.preset}</span>
                    <span>
                      {link.subtitleStreamIndex === -1
                        ? 'No subtitles'
                        : `Subtitle #${link.subtitleStreamIndex}`}
                    </span>
                    <span>Created {formatDateTime(link.createdAt)}</span>
                    <span>
                      {link.revoked
                        ? 'Revoked'
                        : expired
                          ? 'Expired'
                          : `Expires ${formatDateTime(link.expiresAt)} · ${relativeExpiry(link.expiresAt)}`}
                    </span>
                  </p>
                </div>
                <div className="link-actions">
                  <CopyButton value={link.id} label="Copy id" />
                  {link.revoked ? (
                    <span className="badge badge-danger">revoked</span>
                  ) : confirmId === link.id ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        onClick={() => void revoke(link.id)}
                        disabled={revokingId === link.id}
                      >
                        {revokingId === link.id ? <Spinner label="Revoking" /> : 'Confirm revoke'}
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
