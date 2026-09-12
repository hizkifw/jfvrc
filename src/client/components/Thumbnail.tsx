import { useEffect, useState } from 'react';
import { fetchImage } from '../api';

export type ThumbnailVariant = 'poster' | 'wide';

/**
 * Loads an authenticated image through the API as a Blob and renders it from an
 * object URL, so the admin bearer token is never embedded in the `<img>` src.
 * A placeholder is shown while loading and whenever the image is unavailable.
 */
export function Thumbnail({
  path,
  alt,
  variant = 'wide',
}: {
  path: string;
  alt: string;
  variant?: ThumbnailVariant;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const className = variant === 'poster' ? 'thumb thumb-poster' : 'thumb thumb-wide';

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchImage(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) {
    return <span className={`${className} thumb-fallback`} aria-hidden="true" />;
  }
  if (!url) {
    return <span className={`${className} thumb-loading`} aria-hidden="true" />;
  }
  return <img className={className} src={url} alt={alt} loading="lazy" />;
}
