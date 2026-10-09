import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import type { IconName } from './icons';
import { Thumbnail } from './Thumbnail';
import type { ThumbnailVariant } from './Thumbnail';
import { Spinner } from './ui';

/** Artwork tile with a title and one line of metadata beneath it. */
export function MediaCard({
  path,
  variant,
  title,
  meta,
  badge,
  fallbackIcon,
  busy = false,
  onClick,
}: {
  path: string | null;
  variant: ThumbnailVariant;
  title: string;
  meta?: string | null;
  badge?: string | null;
  fallbackIcon?: IconName;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="card" onClick={onClick} disabled={busy} aria-busy={busy}>
      <span className="card-art">
        <Thumbnail path={path} alt="" variant={variant} fallbackIcon={fallbackIcon} />
        {badge ? <span className="card-badge">{badge}</span> : null}
        {busy ? (
          <span className="card-loading">
            <Spinner label="Loading item" />
          </span>
        ) : null}
      </span>
      <span className="card-title">{title}</span>
      {meta ? <span className="card-meta">{meta}</span> : null}
    </button>
  );
}

/** Horizontally scrolling row of cards with a heading and paging arrows. */
export function Shelf({ title, children }: { title: string; children: ReactNode }) {
  const row = useRef<HTMLUListElement>(null);

  function page(direction: 1 | -1) {
    const element = row.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' });
  }

  return (
    <section className="shelf">
      <div className="wrap shelf-head">
        <h2>{title}</h2>
        <div className="shelf-arrows">
          <button type="button" className="round-btn" onClick={() => page(-1)} aria-label="Scroll back">
            <Icon name="chevron-left" />
          </button>
          <button type="button" className="round-btn" onClick={() => page(1)} aria-label="Scroll forward">
            <Icon name="chevron-right" />
          </button>
        </div>
      </div>
      <ul className="shelf-row" ref={row}>
        {children}
      </ul>
    </section>
  );
}

const SHELF_SKELETON_CARDS = Array.from({ length: 6 }, (_, index) => index);

/** Placeholder card matching `MediaCard`'s footprint. */
export function CardSkeleton({ variant }: { variant: ThumbnailVariant }) {
  return (
    <div className="card card-skeleton" aria-hidden="true">
      <span className="card-art">
        <span
          className={
            variant === 'poster' ? 'thumb thumb-poster thumb-loading' : 'thumb thumb-wide thumb-loading'
          }
        />
      </span>
      <span className="skeleton skeleton-line" />
      <span className="skeleton skeleton-line skeleton-line-short" />
    </div>
  );
}

/** Placeholder with the same footprint as a `Shelf` of landscape cards. */
export function ShelfSkeleton() {
  return (
    <div className="shelf" aria-hidden="true">
      <div className="wrap shelf-head">
        <span className="skeleton skeleton-heading" />
      </div>
      <ul className="shelf-row">
        {SHELF_SKELETON_CARDS.map((index) => (
          <li key={index}>
            <CardSkeleton variant="wide" />
          </li>
        ))}
      </ul>
    </div>
  );
}
