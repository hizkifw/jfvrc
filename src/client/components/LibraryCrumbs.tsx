import { Fragment, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import type { ItemDetails, MediaType } from '../types';

export interface Crumb {
  id: string | null;
  name: string;
  type?: MediaType;
  seriesId?: string;
}

export const ROOT_CRUMB: Crumb = { id: null, name: 'Libraries' };

/** Shared across mounts so list <-> item transitions don't refetch names. */
const crumbCache = new Map<string, ItemDetails>();

/**
 * Resolve display names/types for a library path so breadcrumbs can be shown
 * (and restored on reload) from only the ids held in the URL.
 */
export function useLibraryCrumbs(path: string[]) {
  const [state, setState] = useState<{ key: string; crumbs: Crumb[] }>({
    key: '',
    crumbs: [ROOT_CRUMB],
  });
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const pathKey = path.join('/');

  useEffect(() => {
    if (!pathKey) {
      setState({ key: '', crumbs: [ROOT_CRUMB] });
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    Promise.all(
      path.map((id) => {
        const cached = crumbCache.get(id);
        return cached ? Promise.resolve(cached) : api.item(id);
      }),
    )
      .then((details) => {
        if (cancelled) return;
        details.forEach((detail) => crumbCache.set(detail.id, detail));
        setState({
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
        setError(errorMessage(err));
        setState({ key: pathKey, crumbs: [ROOT_CRUMB] });
      });
    return () => {
      cancelled = true;
    };
  }, [pathKey, reload]);

  return {
    crumbs: state.crumbs,
    resolved: state.key === pathKey,
    error,
    retry: () => setReload((value) => value + 1),
  };
}

export function LibraryBreadcrumbs({
  crumbs,
  searching,
  currentLabel,
  onCrumb,
}: {
  crumbs: Crumb[];
  searching: boolean;
  /** Label of the item currently open, appended as the trailing crumb. */
  currentLabel?: string | null;
  onCrumb: (index: number) => void;
}) {
  return (
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
            onClick={() => onCrumb(index)}
            aria-current={
              !searching && !currentLabel && index === crumbs.length - 1 ? 'page' : undefined
            }
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
          <span className="crumb crumb-static" aria-current={currentLabel ? undefined : 'page'}>
            Search
          </span>
        </>
      ) : null}
      {currentLabel ? (
        <>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="crumb crumb-static" aria-current="page">
            {currentLabel}
          </span>
        </>
      ) : null}
    </nav>
  );
}
