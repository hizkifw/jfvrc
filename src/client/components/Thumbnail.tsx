import { useEffect, useState } from 'react';
import { fetchImage } from '../api';
import { Icon } from './icons';
import type { IconName } from './icons';

export type ThumbnailVariant = 'poster' | 'wide';

/**
 * Loads an authenticated image through the API as a Blob and exposes it as an
 * object URL, so the admin bearer token is never embedded in an `<img>` src.
 * `url` stays null while loading; `failed` is set when the image is unavailable.
 */
export function useImage(path: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ path: string | null; url: string | null; failed: boolean }>({
    path: null,
    url: null,
    failed: false,
  });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchImage(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ path, url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ path, url: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  // Ignore the result of a previous path until the new one resolves.
  return state.path === path ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

/** Artwork tile with a shimmer while loading and an icon when there is no image. */
export function Thumbnail({
  path,
  alt,
  variant = 'wide',
  fallbackIcon = 'film',
}: {
  /** Image API path, or null when the item has no artwork. */
  path: string | null;
  alt: string;
  variant?: ThumbnailVariant;
  fallbackIcon?: IconName;
}) {
  const { url, failed } = useImage(path);
  const className = variant === 'poster' ? 'thumb thumb-poster' : 'thumb thumb-wide';

  if (!path || failed) {
    return (
      <span className={`${className} thumb-fallback`} aria-hidden="true">
        <Icon name={fallbackIcon} size={28} />
      </span>
    );
  }
  if (!url) {
    return <span className={`${className} thumb-loading`} aria-hidden="true" />;
  }
  return <img className={className} src={url} alt={alt} loading="lazy" />;
}
