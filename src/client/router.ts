/**
 * Tiny hash-based router. Keeping navigation state in `location.hash` means a
 * reload restores the active tab, library path, search, page and open item
 * without any server-side routing changes.
 *
 * Format:
 *   #/resolve[?item=<id>]
 *   #/library[/<id>...][?q=<query>&start=<n>&item=<id>]
 *   #/links[?item=<id>]
 */
import { useCallback, useEffect, useState } from 'react';

export type Tab = 'resolve' | 'library' | 'links';

export interface Route {
  tab: Tab;
  /** Ordered library ids from the root, e.g. [libraryId, seriesId, seasonId]. */
  path: string[];
  /** Library search term (empty when browsing). */
  query: string;
  /** Library pagination offset. */
  startIndex: number;
  /** Item currently opened in the config panel, if any. */
  itemId: string | null;
}

export const DEFAULT_ROUTE: Route = {
  tab: 'resolve',
  path: [],
  query: '',
  startIndex: 0,
  itemId: null,
};

function parseStartIndex(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const questionIndex = raw.indexOf('?');
  const pathPart = questionIndex >= 0 ? raw.slice(0, questionIndex) : raw;
  const params = new URLSearchParams(questionIndex >= 0 ? raw.slice(questionIndex + 1) : '');
  const segments = pathPart
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  const itemId = params.get('item') || null;

  if (segments[0] === 'library') {
    return {
      tab: 'library',
      path: segments.slice(1),
      query: params.get('q') ?? '',
      startIndex: parseStartIndex(params.get('start')),
      itemId,
    };
  }
  if (segments[0] === 'links') {
    return { tab: 'links', path: [], query: '', startIndex: 0, itemId };
  }
  return { ...DEFAULT_ROUTE, itemId };
}

export function serializeRoute(route: Route): string {
  const segments =
    route.tab === 'library'
      ? ['library', ...route.path.map((id) => encodeURIComponent(id))]
      : [route.tab];
  const params = new URLSearchParams();
  if (route.tab === 'library') {
    if (route.query) params.set('q', route.query);
    if (route.startIndex > 0) params.set('start', String(route.startIndex));
  }
  if (route.itemId) params.set('item', route.itemId);
  const query = params.toString();
  return `#/${segments.join('/')}${query ? `?${query}` : ''}`;
}

export function useRoute(): [Route, (next: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const url = `${window.location.pathname}${window.location.search}${serializeRoute(next)}`;
    if (options?.replace) {
      window.history.replaceState(null, '', url);
    } else {
      window.history.pushState(null, '', url);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
