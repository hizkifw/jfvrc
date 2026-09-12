/**
 * Shared API contract between the JFVRC backend and frontend.
 * Backend owns this file. Values use normalized JSON (camelCase) as described
 * in docs/architecture.md.
 */

export type ItemType = 'Movie' | 'Episode';

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
  seasonNumber?: number;
  episodeNumber?: number;
  overview?: string;
  runTimeSeconds?: number;
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
  startSeconds: number;
  expiresInHours: number;
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
