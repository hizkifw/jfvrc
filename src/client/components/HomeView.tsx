import { useEffect, useState } from 'react';
import { api } from '../api';
import { landscapePath, primaryPath } from '../art';
import { episodeCode } from '../format';
import type { MediaItem } from '../types';
import { MediaCard, Shelf, ShelfSkeleton } from './cards';
import { Hero, HeroSkeleton } from './Hero';
import { rememberItems } from './LibraryCrumbs';
import { Icon } from './icons';

const SHELF_SIZE = 16;

/** Library kinds whose recent additions are worth a shelf (video content only). */
const SHELF_COLLECTIONS: ReadonlySet<string> = new Set(['movies', 'tvshows', 'homevideos', 'mixed']);

interface LatestShelf {
  view: MediaItem;
  items: MediaItem[];
}

function shelfTitle(item: MediaItem): string {
  return item.type === 'Episode' || item.type === 'Season' ? (item.seriesName ?? item.name) : item.name;
}

function shelfMeta(item: MediaItem): string | null {
  if (item.type === 'Episode') {
    return [episodeCode(item), item.name].filter(Boolean).join(' · ');
  }
  if (item.type === 'Season') return item.name;
  return item.year ? String(item.year) : null;
}

function isPlayable(item: MediaItem): boolean {
  return item.type === 'Movie' || item.type === 'Episode' || item.type === 'Video';
}

/**
 * Library landing page: a featured recent addition, a shelf of recent additions
 * per video library, and the libraries themselves.
 */
export function HomeView({
  views,
  openId,
  onActivate,
}: {
  views: MediaItem[];
  /** Item whose details are currently being fetched, if any. */
  openId: string | null;
  /** Open or browse into an item; `base` is the library path leading to it. */
  onActivate: (item: MediaItem, base: string[]) => void;
}) {
  // null until the shelves have loaded, so the page can hold its skeleton until then.
  const [shelves, setShelves] = useState<LatestShelf[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sources = views.filter((view) => SHELF_COLLECTIONS.has(view.collectionType ?? 'mixed'));
    // A shelf that fails to load is simply left out; the libraries row still works.
    Promise.all(
      sources.map((view) =>
        api
          .libraryLatest(view.id, SHELF_SIZE)
          .then((result) => ({ view, items: result.items }))
          .catch(() => ({ view, items: [] })),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      loaded.forEach((shelf) => rememberItems(shelf.items));
      setShelves(loaded.filter((shelf) => shelf.items.length > 0));
    });
    return () => {
      cancelled = true;
    };
  }, [views]);

  if (!shelves) return <HomeSkeleton />;

  // Feature the most recent addition that can fill the hero: a backdrop is required,
  // and items that also have a logo and a synopsis are preferred.
  const candidates = shelves.flatMap((shelf) =>
    shelf.items.filter((item) => item.artwork?.backdrop).map((item) => ({ item, view: shelf.view })),
  );
  const pick =
    candidates.find(({ item }) => item.artwork?.logo && item.overview) ??
    candidates.find(({ item }) => item.overview) ??
    candidates[0];
  const featured = pick?.item;

  return (
    <>
      {featured && pick ? (
        <Hero item={featured} headingId="library-heading">
          <button
            type="button"
            className="btn btn-primary btn-large"
            onClick={() => onActivate(featured, [pick.view.id])}
            disabled={openId === featured.id}
          >
            <Icon name={isPlayable(featured) ? 'link' : 'grid'} />
            {isPlayable(featured) ? 'Create Link' : 'Browse Episodes'}
          </button>
        </Hero>
      ) : (
        <div className="wrap page-pad">
          <h1 id="library-heading">Library</h1>
        </div>
      )}

      {shelves.map((shelf) => (
        <Shelf key={shelf.view.id} title={`Latest ${shelf.view.name}`}>
          {shelf.items.map((item) => (
            <li key={item.id}>
              <MediaCard
                path={landscapePath(item)}
                variant="wide"
                title={shelfTitle(item)}
                meta={shelfMeta(item)}
                busy={openId === item.id}
                onClick={() => onActivate(item, [shelf.view.id])}
              />
            </li>
          ))}
        </Shelf>
      ))}

      <Shelf title="Libraries">
        {views.map((view) => (
          <li key={view.id}>
            <MediaCard
              path={primaryPath(view)}
              variant="wide"
              title={view.name}
              fallbackIcon="folder"
              onClick={() => onActivate(view, [])}
            />
          </li>
        ))}
      </Shelf>
    </>
  );
}

/** Placeholder for the landing page: a hero and two shelves. */
export function HomeSkeleton() {
  return (
    <div role="status" aria-label="Loading library">
      <HeroSkeleton />
      <ShelfSkeleton />
      <ShelfSkeleton />
    </div>
  );
}
