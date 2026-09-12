import type { JellyfinConfig } from './config';
import { badRequest } from './errors';
import { filenameFromUrl, resolveUpstreamReference, stripSensitiveParams } from './urls';

export interface ManifestRewriteContext {
  jellyfin: JellyfinConfig;
  itemId: string;
  /** Absolute upstream URL of the manifest currently being rewritten. */
  manifestUrl: string;
  /** Requested start position in ticks; variants are trimmed to it. */
  startTicks?: number;
  /** Maps a validated absolute upstream URL to a client-facing resource path. */
  mapResource(upstreamUrl: string, filename: string): string;
}

const URI_ATTRIBUTE_RE = /((?:SERVER-)?URI)="([^"]*)"/g;

function rewriteReference(reference: string, ctx: ManifestRewriteContext): string {
  const resolved = resolveUpstreamReference(reference, ctx.manifestUrl, ctx.jellyfin, {
    itemId: ctx.itemId,
  });
  // Never persist or re-emit credential-bearing query params found in manifests.
  const safe = stripSensitiveParams(resolved);
  // Jellyfin echoes StartTimeTicks into child URLs but rejects it (>0) on
  // segment requests, so never forward it downstream.
  safe.searchParams.delete('StartTimeTicks');
  return ctx.mapResource(safe.toString(), filenameFromUrl(safe));
}

function rewriteTagLine(line: string, ctx: ManifestRewriteContext): string {
  return line.replace(URI_ATTRIBUTE_RE, (_match, attribute: string, reference: string) => {
    if (reference === '') {
      throw badRequest('invalid_manifest_uri', 'Manifest contains an empty URI attribute');
    }
    return `${attribute}="${rewriteReference(reference, ctx)}"`;
  });
}

/**
 * Subtitle renditions are dropped (subtitles are burned in), so remove the
 * `SUBTITLES="..."` grouping attribute from stream-inf lines to avoid a
 * dangling reference to a group that no longer exists (RFC 8216).
 */
function stripSubtitleGroupReference(line: string): string {
  if (!/^#EXT-X-(I-FRAME-)?STREAM-INF:/i.test(line.trimStart())) return line;
  return line
    .replace(/,SUBTITLES="[^"]*"/gi, '')
    .replace(/SUBTITLES="[^"]*",/gi, '');
}

/**
 * Rewrite an HLS manifest so that every URI it references (variant playlists,
 * segments, keys, init maps, i-frame playlists and other URI-bearing tags)
 * points at our proxy while all other tags/timing/newlines are preserved.
 *
 * Subtitle renditions are dropped because subtitles are burned into the video
 * stream, and trickplay image playlists are unsupported; both can carry
 * upstream credentials and would otherwise stay reachable.
 */
function segmentWindow(uri: string): { runtimeTicks: number; lengthTicks: number } {
  try {
    const url = new URL(uri, 'http://upstream.invalid/');
    return {
      runtimeTicks: Number(url.searchParams.get('runtimeTicks') ?? '0'),
      lengthTicks: Number(url.searchParams.get('actualSegmentLengthTicks') ?? '0'),
    };
  } catch {
    return { runtimeTicks: 0, lengthTicks: 0 };
  }
}

/**
 * Trim a VOD variant playlist to the requested start position and shift the
 * media sequence. Jellyfin always generates playlists from zero, and its
 * segment handler seeks to the requested segment's runtimeTicks, so a player
 * that starts at the top of the trimmed playlist begins at the saved offset.
 */
function applyStartOffset(parts: string[], startTicks: number): void {
  if (startTicks <= 0) return;
  const segmentParts: number[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!.trim();
    if (line && !line.startsWith('#')) segmentParts.push(i);
  }
  if (segmentParts.length === 0) return;

  let cut = segmentParts.length;
  for (let s = 0; s < segmentParts.length; s += 1) {
    const { runtimeTicks, lengthTicks } = segmentWindow(parts[segmentParts[s]!]!.trim());
    if (runtimeTicks + lengthTicks > startTicks) {
      cut = s;
      break;
    }
  }
  if (cut <= 0 || cut >= segmentParts.length) return;

  for (let s = 0; s < cut; s += 1) {
    const idx = segmentParts[s]!;
    parts[idx] = '';
    for (let j = idx - 2; j >= 0; j -= 2) {
      const candidate = parts[j]!.trimStart();
      if (candidate.startsWith('#EXTINF:')) {
        parts[j] = '';
        break;
      }
      if (candidate === '' || candidate.startsWith('#EXT-X-')) break;
    }
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(parts[i]!.trimStart())) {
      parts[i] = `#EXT-X-MEDIA-SEQUENCE:${cut}`;
    }
  }
}

export function rewriteManifest(text: string, ctx: ManifestRewriteContext): string {
  const parts = text.split(/(\r\n|\n|\r)/);
  applyStartOffset(parts, ctx.startTicks ?? 0);
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    const trimmed = line.trimStart();
    if (line.trim() === '') continue;
    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-MEDIA:/i.test(trimmed) && /TYPE="?SUBTITLES"?/i.test(trimmed)) {
        parts[i] = '';
        continue;
      }
      if (/^#EXT-X-IMAGE-STREAM-INF:/i.test(trimmed)) {
        parts[i] = '';
        continue;
      }
      parts[i] = stripSubtitleGroupReference(rewriteTagLine(line, ctx));
    } else {
      parts[i] = rewriteReference(line.trim(), ctx);
    }
  }
  return parts.join('');
}

export function isManifest(body: string, contentType: string | null): boolean {
  if (contentType && /mpegurl/i.test(contentType)) return true;
  return body.startsWith('#EXTM3U');
}
