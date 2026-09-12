/**
 * Frontend type contract. Re-exports the backend-owned shared contract so the
 * client cannot drift from `src/shared/contracts.ts`. `MediaType` is kept as a
 * client-friendly alias of the shared `ItemType`.
 */
export type {
  ItemType as MediaType,
  Preset,
  Track,
  MediaSource,
  MediaItem,
  ItemDetails,
  LinkSummary,
  CreateLinkRequest,
  CreateLinkResponse,
  ResolveRequest,
  LibraryResponse,
  LinksResponse,
  StatusResponse,
  ApiErrorBody,
} from '../shared/contracts';
