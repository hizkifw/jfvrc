import type { JellyfinConfig } from './config';
import { AppError, badRequest } from './errors';

const SENSITIVE_QUERY_PARAMS = new Set([
  'api_key',
  'apikey',
  'x-emby-token',
  'x-emby-authorization',
  'token',
]);

export function apiUrl(jellyfin: JellyfinConfig, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${jellyfin.origin}${jellyfin.basePath}${suffix}`;
}

export interface ValidateOptions {
  /** When set, the path must live under Videos/{itemId} or Audio/{itemId}. */
  itemId?: string;
  /** Restrict to the configured web/base path. Always enforced. */
  allowOriginOnly?: boolean;
}

export function validateUpstreamUrl(
  raw: string,
  jellyfin: JellyfinConfig,
  options: ValidateOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('invalid_url', 'Invalid upstream URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('invalid_url_scheme', 'Only http and https upstream URLs are allowed');
  }
  if (url.username || url.password) {
    throw badRequest('invalid_url_credentials', 'Upstream URLs must not contain credentials');
  }
  if (url.origin !== jellyfin.origin) {
    throw badRequest('untrusted_origin', 'Upstream URL does not match the configured Jellyfin server');
  }
  for (const segment of url.pathname.split('/')) {
    if (segment === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw badRequest('untrusted_path', 'Upstream URL has malformed percent-encoding');
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw badRequest('untrusted_path', 'Upstream URL path traversal is not allowed');
    }
  }
  const base = jellyfin.basePath;
  if (base) {
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      throw badRequest('untrusted_path', 'Upstream URL is outside the configured Jellyfin base path');
    }
  }
  if (options.itemId && !options.allowOriginOnly) {
    const remainder = base ? url.pathname.slice(base.length) : url.pathname;
    // Jellyfin may expose an item id as 32 hex chars while using the dashed
    // UUID form (or vice versa) in HLS paths, so compare canonical GUIDs.
    const pathMatch = /^\/(videos|audio)\/([^/]+)(?:\/|$)/i.exec(remainder);
    if (!pathMatch || canonicalGuid(pathMatch[2]!) !== canonicalGuid(options.itemId)) {
      throw badRequest('untrusted_path', 'Upstream URL is outside the expected media namespace');
    }
    if (/\/(subtitles|trickplay)(\/|$)/i.test(remainder)) {
      throw badRequest(
        'untrusted_path',
        'Upstream URL points at a subtitle or trickplay resource that is not allowed',
      );
    }
  }
  return url;
}

const GUID_RE =
  /^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Canonical, dash-free, lowercase form for comparing GUIDs regardless of spelling. */
export function canonicalGuid(value: string): string {
  return value.replace(/-/g, '').toLowerCase();
}

export function isGuidLike(value: string): boolean {
  return GUID_RE.test(value);
}

/**
 * Derive the item id from a manifest URL so references are constrained to the
 * same media namespace even when the caller does not pass one explicitly.
 */
export function inferContextItemId(
  contextUrl: string,
  jellyfin: JellyfinConfig,
): string | undefined {
  let url: URL;
  try {
    url = new URL(contextUrl);
  } catch {
    return undefined;
  }
  const base = jellyfin.basePath;
  let pathname = url.pathname;
  if (base && pathname.startsWith(`${base}/`)) {
    pathname = pathname.slice(base.length);
  }
  const match = /^\/(?:videos|audio)\/([0-9a-fA-F-]{32,36})(?:\/|$)/i.exec(pathname);
  return match?.[1];
}

/**
 * Resolve a manifest reference against a manifest's absolute URL, then validate
 * it against the configured Jellyfin origin and namespace. Relative,
 * root-relative and absolute references are supported while preserving query
 * semantics.
 */
export function resolveUpstreamReference(
  reference: string,
  contextUrl: string,
  jellyfin: JellyfinConfig,
  options: ValidateOptions = {},
): URL {
  const trimmed = reference.trim();
  if (trimmed === '') {
    throw badRequest('invalid_manifest_uri', 'Manifest contains an empty URI');
  }
  if (trimmed.startsWith('//')) {
    throw badRequest('untrusted_path', 'Protocol-relative manifest URIs are not allowed');
  }
  if (/%2e|%2f|%5c|%00/i.test(trimmed)) {
    throw badRequest('untrusted_path', 'Encoded path traversal is not allowed');
  }
  const itemId = options.itemId ?? inferContextItemId(contextUrl, jellyfin);
  const effectiveOptions: ValidateOptions = itemId ? { ...options, itemId } : options;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw badRequest('unsafe_uri_scheme', `Unsupported manifest URI scheme: ${scheme}`);
    }
    return validateUpstreamUrl(trimmed, jellyfin, effectiveOptions);
  }

  // Root-relative: Jellyfin may emit "/Videos/..." with or without the base path.
  if (trimmed.startsWith('/')) {
    const candidate = basePrefix(trimmed, jellyfin);
    return validateUpstreamUrl(candidate, jellyfin, effectiveOptions);
  }

  const base = new URL(contextUrl);
  const resolved = new URL(trimmed, base);
  return validateUpstreamUrl(resolved.toString(), jellyfin, effectiveOptions);
}

function basePrefix(pathAndQuery: string, jellyfin: JellyfinConfig): string {
  const base = jellyfin.basePath;
  const pathname = pathAndQuery.split(/[?#]/, 1)[0]!;
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) {
    return `${jellyfin.origin}${base}${pathAndQuery}`;
  }
  return `${jellyfin.origin}${pathAndQuery}`;
}

/** Remove credential-bearing query params before exposing a URL to our clients. */
export function stripSensitiveParams(url: URL): URL {
  const clone = new URL(url.toString());
  for (const key of [...clone.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      clone.searchParams.delete(key);
    }
  }
  return clone;
}

export function isPlaylistPath(pathname: string): boolean {
  return /\.m3u8$/i.test(pathname);
}

export function filenameFromUrl(url: URL, fallback = 'resource'): string {
  const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!segment) return fallback;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function assertNoUserInfo(url: URL): void {
  if (url.username || url.password) {
    throw new AppError(400, 'invalid_url_credentials', 'URLs with credentials are not allowed');
  }
}
