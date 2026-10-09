/**
 * Image API paths for the different artwork roles. Each helper returns null
 * when the item (or its parent) has nothing suitable, so callers can fall back.
 */
import { api } from './api';
import type { ArtworkRef, MediaItem, MediaType } from './types';

/** Movies, series and seasons use portrait posters; everything else is landscape. */
const POSTER_TYPES: ReadonlySet<MediaType> = new Set<MediaType>(['Movie', 'Series', 'Season', 'BoxSet']);

export function hasPoster(type: MediaType): boolean {
  return POSTER_TYPES.has(type);
}

function refPath(ref: ArtworkRef, type: 'Backdrop' | 'Logo' | 'Thumb', width: number): string {
  return api.imagePath(ref.itemId, {
    type,
    tag: ref.tag,
    width,
    ...(type === 'Backdrop' ? { index: 0 } : {}),
  });
}

/** The item's primary image: a poster for poster types, otherwise a landscape still. */
export function primaryPath(item: MediaItem): string | null {
  if (!item.imageTag) return null;
  const size = hasPoster(item.type) ? { width: 400, height: 600 } : { width: 640, height: 360 };
  return api.imagePath(item.id, { tag: item.imageTag, ...size });
}

/** Full-bleed background, falling back to an episode's own still. */
export function backdropPath(item: MediaItem, width = 1920): string | null {
  if (item.artwork?.backdrop) return refPath(item.artwork.backdrop, 'Backdrop', width);
  if (item.imageTag && !hasPoster(item.type) && item.type !== 'CollectionFolder') {
    return api.imagePath(item.id, { tag: item.imageTag, width });
  }
  return null;
}

/** Transparent title treatment. */
export function logoPath(item: MediaItem, width = 800): string | null {
  return item.artwork?.logo ? refPath(item.artwork.logo, 'Logo', width) : null;
}

/** 16:9 card art: titled key art, then a backdrop, then whatever the item has. */
export function landscapePath(item: MediaItem, width = 640): string | null {
  if (item.artwork?.thumb) return refPath(item.artwork.thumb, 'Thumb', width);
  if (item.artwork?.backdrop) return refPath(item.artwork.backdrop, 'Backdrop', width);
  return primaryPath(item);
}
