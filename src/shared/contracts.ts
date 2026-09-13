/**
 * Shared API contract between the JFVRC backend and frontend.
 * Backend owns this file. Values use normalized JSON (camelCase) as described
 * in docs/architecture.md.
 */

export type ItemType =
  | 'Movie'
  | 'Episode'
  | 'Series'
  | 'Season'
  | 'Folder'
  | 'CollectionFolder'
  | 'BoxSet'
  | 'Video';

export type Preset = '1080p' | '720p';

export interface Track {
  index: number;
  label: string;
  language?: string;
  codec?: string;
  isDefault?: boolean;
  isForced?: boolean;
}

export interface MediaSource {
  id: string;
  name: string;
  audioTracks: Track[];
  subtitleTracks: Track[];
}

export interface MediaItem {
  id: string;
  name: string;
  type: ItemType;
  year?: number;
  seriesName?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  overview?: string;
  runTimeSeconds?: number;
  /** Jellyfin primary image tag; absent when the item has no artwork. */
  imageTag?: string;
  /** Jellyfin backdrop image tag, used for wider artwork when available. */
  backdropTag?: string;
  /** Number of direct children, for browsable folders/series/seasons. */
  childCount?: number;
  /** Jellyfin collection type for library views (e.g. "movies", "tvshows"). */
  collectionType?: string;
}

export interface ItemDetails extends MediaItem {
  mediaSources: MediaSource[];
}

export interface LinkSummary {
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  preset: string;
  subtitleStreamIndex: number;
}

export interface CreateLinkRequest {
  itemId: string;
  mediaSourceId: string;
  audioStreamIndex?: number;
  subtitleStreamIndex: number;
  preset: Preset;
  /** Defaults to 0 (start of the item) when omitted. */
  startSeconds?: number;
  /** Defaults to the configured LINK_DEFAULT_EXPIRY_HOURS when omitted. */
  expiresInHours?: number;
}

export interface CreateLinkResponse {
  id: string;
  url: string;
  expiresAt: string;
  title: string;
}

export interface ResolveRequest {
  input: string;
}

export interface LibraryResponse {
  items: MediaItem[];
  total: number;
}

export interface ViewsResponse {
  items: MediaItem[];
}

export interface LinksResponse {
  links: LinkSummary[];
}

export interface StatusResponse {
  configured: boolean;
  jellyfinUrl: string;
  publicBaseUrl: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
