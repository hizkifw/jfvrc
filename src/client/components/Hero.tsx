import type { ReactNode } from 'react';
import { backdropPath, logoPath } from '../art';
import { episodeCode, formatRuntime } from '../format';
import type { MediaItem } from '../types';
import { Icon } from './icons';
import { useImage } from './Thumbnail';

/**
 * Full-bleed header for an item: backdrop behind, then its logo (or title),
 * key facts and overview. Seasons and episodes borrow their series' artwork.
 */
export function Hero({
  item,
  top,
  compact = false,
  headingId,
  onHeading,
  children,
}: {
  item: MediaItem;
  /** Rendered above the title, e.g. breadcrumbs or a back button. */
  top?: ReactNode;
  compact?: boolean;
  headingId?: string;
  /** Makes the logo/title a link, e.g. from an episode back to its series. */
  onHeading?: () => void;
  /** Action buttons. */
  children?: ReactNode;
}) {
  const backdropSrc = backdropPath(item);
  const backdrop = useImage(backdropSrc);
  const logoSrc = logoPath(item);
  const logo = useImage(logoSrc);
  // Like the backdrop, the logo keeps a fixed slot so the text below never moves.
  const hasLogo = logoSrc !== null && !logo.failed;
  // Reserve the artwork's space while it loads so the page below does not jump.
  const hasArt = backdropSrc !== null && !backdrop.failed;

  const nested = item.type === 'Episode' || item.type === 'Season';
  const heading = nested ? (item.seriesName ?? item.name) : item.name;
  const subheading =
    item.type === 'Episode'
      ? [episodeCode(item), item.name].filter(Boolean).join(' · ')
      : item.type === 'Season'
        ? item.name
        : null;
  const facts = [
    ...(item.genres ?? []).slice(0, 2),
    item.year ? String(item.year) : null,
    formatRuntime(item.runTimeSeconds),
  ].filter(Boolean);

  const className = ['hero', compact ? 'hero-compact' : '', hasArt ? 'hero-with-art' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <header className={className}>
      {backdrop.url ? (
        <div className="hero-art" aria-hidden="true">
          <img src={backdrop.url} alt="" />
        </div>
      ) : null}
      <div className="wrap hero-inner">
        {top ? <div className="hero-top">{top}</div> : null}
        <div className="hero-content">
          <div className="hero-heading">
            {hasLogo ? (
              <div className="hero-logo-slot" aria-hidden="true">
                {logo.url ? <img className="hero-logo" src={logo.url} alt="" /> : null}
              </div>
            ) : null}
            <h1 id={headingId} className={hasLogo ? 'sr-only' : undefined}>
              {heading}
            </h1>
            {onHeading ? (
              <button
                type="button"
                className="hero-heading-link"
                onClick={onHeading}
                aria-label={`Go to ${heading}`}
              />
            ) : null}
          </div>
          {subheading ? <p className="hero-sub">{subheading}</p> : null}
          {facts.length > 0 || item.officialRating || item.communityRating ? (
            <p className="hero-facts">
              {facts.map((fact) => (
                <span key={fact} className="fact">
                  {fact}
                </span>
              ))}
              {item.officialRating ? <span className="rating">{item.officialRating}</span> : null}
              {item.communityRating ? (
                <span className="score">
                  <Icon name="star" size={13} />
                  {item.communityRating.toFixed(1)}
                </span>
              ) : null}
            </p>
          ) : null}
          {item.overview ? <p className="hero-overview">{item.overview}</p> : null}
          {children ? <div className="hero-actions">{children}</div> : null}
        </div>
      </div>
    </header>
  );
}

/** Placeholder with the same footprint as a `Hero` whose artwork is still loading. */
export function HeroSkeleton({ top, compact = false }: { top?: ReactNode; compact?: boolean }) {
  return (
    <div
      className={compact ? 'hero hero-with-art hero-compact' : 'hero hero-with-art'}
      aria-hidden={top ? undefined : true}
    >
      <div className="wrap hero-inner">
        {top ? <div className="hero-top">{top}</div> : null}
        <div className="hero-content" aria-hidden="true">
          <span className="skeleton hero-logo-slot hero-logo-skeleton" />
          <span className="skeleton skeleton-line skeleton-line-short" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
        </div>
      </div>
    </div>
  );
}
