import type { AppConfig, JellyfinConfig } from './config';
import type { ItemDetails, MediaItem, MediaSource, Preset, Track } from '../shared/contracts';
import { badRequest, notFound, unprocessable, upstreamError } from './errors';
import { apiUrl, stripSensitiveParams, validateUpstreamUrl } from './urls';

const PRESET_SETTINGS: Record<Preset, { maxStreamingBitrate: number; maxWidth: number; maxHeight: number }> = {
  '1080p': { maxStreamingBitrate: 8_000_000, maxWidth: 1920, maxHeight: 1080 },
  '720p': { maxStreamingBitrate: 4_000_000, maxWidth: 1280, maxHeight: 720 },
};

const SUBTITLE_ENCODE_PROFILES = [
  'srt',
  'subrip',
  'ass',
  'ssa',
  'vtt',
  'webvtt',
  'mov_text',
  'ttml',
  'pgs',
  'pgssub',
  'dvdsub',
  'dvbsub',
].map((Format) => ({ Format, Method: 'Encode' }));

export function buildDeviceProfile(preset: Preset): Record<string, unknown> {
  const settings = PRESET_SETTINGS[preset];
  return {
    Name: 'JFVRC',
    MaxStreamingBitrate: settings.maxStreamingBitrate,
    MaxStaticBitrate: 0,
    MusicStreamingTranscodingBitrate: 0,
    DirectPlayProfiles: [],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: 1,
        SegmentLength: 6,
        BreakOnNonKeyFrames: false,
        EnableSubtitlesInManifest: false,
        TranscodeSeekInfo: 'Auto',
        EstimateContentLength: false,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: 'Video',
        Codec: 'h264',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: true },
          {
            Condition: 'LessThanEqual',
            Property: 'Width',
            Value: String(settings.maxWidth),
            IsRequired: true,
          },
          {
            Condition: 'LessThanEqual',
            Property: 'Height',
            Value: String(settings.maxHeight),
            IsRequired: true,
          },
        ],
      },
    ],
    SubtitleProfiles: SUBTITLE_ENCODE_PROFILES,
  };
}

interface JfMediaStream {
  Index?: number;
  Type?: string;
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  Title?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsExternal?: boolean;
}

interface JfMediaSource {
  Id?: string;
  Name?: string;
  MediaStreams?: JfMediaStream[] | null;
}

interface JfMediaSourceInfo extends JfMediaSource {
  TranscodingUrl?: string | null;
  SupportsTranscoding?: boolean;
}

interface JfItem {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Overview?: string;
  RunTimeTicks?: number;
  MediaSources?: JfMediaSource[] | null;
}

interface JfQueryResult {
  Items?: JfItem[] | null;
  TotalRecordCount?: number;
}

interface JfPlaybackInfoResponse {
  MediaSources?: JfMediaSourceInfo[] | null;
  PlaySessionId?: string;
  ErrorCode?: string;
}

export interface PlaybackNegotiation {
  /** Validated absolute upstream master playlist URL with credentials stripped. */
  transcodeUrl: string;
  playSessionId: string;
  deviceId: string;
  mediaSourceId: string;
  itemId: string;
}

export interface NegotiateInput {
  itemId: string;
  mediaSourceId: string;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number;
  preset: Preset;
  startSeconds: number;
  deviceId: string;
}

export interface UpstreamFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  deviceId?: string;
}

function pick<T>(obj: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key] as T;
  }
  // case-insensitive fallback
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const actual = lower.get(key.toLowerCase());
    if (actual !== undefined) return obj[actual] as T;
  }
  return undefined;
}

function mapTrack(stream: JfMediaStream): Track {
  const index = typeof stream.Index === 'number' ? stream.Index : -1;
  const label =
    stream.DisplayTitle ||
    stream.Title ||
    [stream.Language, stream.Codec].filter(Boolean).join(' ') ||
    `Track ${index}`;
  return {
    index,
    label,
    ...(stream.Language ? { language: stream.Language } : {}),
    ...(stream.Codec ? { codec: stream.Codec } : {}),
    ...(stream.IsDefault ? { isDefault: true } : {}),
    ...(stream.IsForced ? { isForced: true } : {}),
  };
}

export function mapItem(raw: JfItem): ItemDetails {
  const type = raw.Type === 'Episode' ? 'Episode' : 'Movie';
  const item: MediaItem = {
    id: String(raw.Id ?? ''),
    name: raw.Name ?? 'Unknown',
    type,
    ...(raw.ProductionYear ? { year: raw.ProductionYear } : {}),
    ...(raw.SeriesName ? { seriesName: raw.SeriesName } : {}),
    ...(typeof raw.ParentIndexNumber === 'number' ? { seasonNumber: raw.ParentIndexNumber } : {}),
    ...(typeof raw.IndexNumber === 'number' ? { episodeNumber: raw.IndexNumber } : {}),
    ...(raw.Overview ? { overview: raw.Overview } : {}),
    ...(typeof raw.RunTimeTicks === 'number'
      ? { runTimeSeconds: Math.round(raw.RunTimeTicks / 10_000_000) }
      : {}),
  };
  const sources: MediaSource[] = (raw.MediaSources ?? []).map((source, i) => {
    const streams = source.MediaStreams ?? [];
    return {
      id: source.Id ?? String(i),
      name: source.Name ?? `Source ${i + 1}`,
      audioTracks: streams.filter((s) => s.Type === 'Audio').map(mapTrack),
      subtitleTracks: streams.filter((s) => s.Type === 'Subtitle').map(mapTrack),
    };
  });
  return { ...item, mediaSources: sources };
}

const ITEM_ID_RE = /^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidItemId(id: string): boolean {
  return ITEM_ID_RE.test(id);
}

export class JellyfinClient {
  private readonly config: AppConfig;
  private readonly jellyfin: JellyfinConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    if (!config.jellyfin) {
      throw new Error('Jellyfin is not configured');
    }
    this.config = config;
    this.jellyfin = config.jellyfin;
    this.fetchImpl = fetchImpl;
  }

  private authHeader(deviceId?: string): string {
    const parts = [
      'Client="JFVRC"',
      'Device="JFVRC"',
      `DeviceId="${deviceId ?? 'jfvrc-server'}"`,
      'Version="1.0.0"',
      `Token="${this.jellyfin.apiKey}"`,
    ];
    return `MediaBrowser ${parts.join(', ')}`;
  }

  private async request(
    url: string,
    init: RequestInit,
    deviceId?: string,
    redirectDepth = 0,
  ): Promise<Response> {
    if (redirectDepth > 5) {
      throw upstreamError('Too many upstream redirects');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', this.authHeader(deviceId));
    headers.set('Accept', 'application/json, */*');
    const response = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw upstreamError('Upstream returned a redirect without a location');
      }
      let resolved: URL;
      try {
        resolved = new URL(location, url);
      } catch {
        throw upstreamError('Upstream returned an invalid redirect location');
      }
      // Re-validate credentials cannot escape to another origin.
      validateUpstreamUrl(resolved.toString(), this.jellyfin);
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return this.request(resolved.toString(), init, deviceId, redirectDepth + 1);
    }
    return response;
  }

  private async getJson<T>(url: string, deviceId?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.request(url, { method: 'GET' }, deviceId);
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw upstreamError();
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw notFound('item_not_found', 'The requested item was not found on Jellyfin');
      }
      throw upstreamError();
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw upstreamError('Jellyfin returned a malformed response');
    }
  }

  async getItem(itemId: string, deviceId?: string): Promise<ItemDetails> {
    if (!isValidItemId(itemId)) {
      throw badRequest('invalid_item_id', 'Item id must be a UUID or 32 character hex string');
    }
    const url = apiUrl(
      this.jellyfin,
      `/Items/${encodeURIComponent(itemId)}?userId=${this.jellyfin.userId}&fields=MediaSources`,
    );
    const raw = await this.getJson<JfItem>(url, deviceId);
    return mapItem(raw);
  }

  async search(
    query: string,
    startIndex: number,
    limit: number,
    deviceId?: string,
  ): Promise<{ items: MediaItem[]; total: number }> {
    const params = new URLSearchParams({
      userId: this.jellyfin.userId,
      recursive: 'true',
      includeItemTypes: 'Movie,Episode',
      startIndex: String(startIndex),
      limit: String(limit),
      sortBy: 'SortName',
      sortOrder: 'Ascending',
      enableImages: 'false',
      enableTotalRecordCount: 'true',
    });
    if (query.trim()) {
      params.set('searchTerm', query.trim());
    }
    const url = apiUrl(this.jellyfin, `/Items?${params.toString()}`);
    const raw = await this.getJson<JfQueryResult>(url, deviceId);
    const items = (raw.Items ?? []).map((item) => mapItem(item));
    return { items, total: raw.TotalRecordCount ?? items.length };
  }

  async negotiatePlayback(input: NegotiateInput): Promise<PlaybackNegotiation> {
    const settings = PRESET_SETTINGS[input.preset];
    const url = `${apiUrl(this.jellyfin, `/Items/${encodeURIComponent(input.itemId)}/PlaybackInfo`)}?userId=${this.jellyfin.userId}`;
    const body = {
      UserId: this.jellyfin.userId,
      MediaSourceId: input.mediaSourceId,
      AudioStreamIndex: input.audioStreamIndex ?? undefined,
      SubtitleStreamIndex: input.subtitleStreamIndex,
      StartTimeTicks: Math.max(0, Math.round(input.startSeconds * 10_000_000)),
      MaxStreamingBitrate: settings.maxStreamingBitrate,
      MaxAudioChannels: 2,
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      AllowVideoStreamCopy: false,
      AllowAudioStreamCopy: false,
      AlwaysBurnInSubtitleWhenTranscoding: input.subtitleStreamIndex >= 0,
      DeviceProfile: buildDeviceProfile(input.preset),
    };

    let response: Response;
    try {
      response = await this.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        input.deviceId,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw upstreamError();
    }
    if (response.status === 404) {
      throw notFound('item_not_found', 'The requested item was not found on Jellyfin');
    }
    if (!response.ok) {
      throw upstreamError();
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await response.json()) as Record<string, unknown>;
    } catch {
      throw upstreamError('Jellyfin returned a malformed playback response');
    }
    const errorCode = pick<string>(raw, 'ErrorCode', 'errorCode');
    if (errorCode && errorCode !== 'None') {
      throw unprocessable('negotiation_failed', 'Jellyfin could not negotiate a compatible transcode');
    }
    const sources = pick<JfMediaSourceInfo[]>(raw, 'MediaSources', 'mediaSources') ?? [];
    const mediaSource =
      sources.find((s) => s.Id === input.mediaSourceId) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!mediaSource) {
      throw unprocessable('media_source_unavailable', 'The selected media source is not playable');
    }
    if (mediaSource.SupportsTranscoding === false) {
      throw unprocessable('transcoding_unsupported', 'Jellyfin cannot transcode the selected source');
    }
    const rawTranscodeUrl = mediaSource.TranscodingUrl;
    if (!rawTranscodeUrl) {
      throw unprocessable('no_transcode_url', 'Jellyfin did not return a transcoding URL');
    }
    const playSessionId = pick<string>(raw, 'PlaySessionId', 'playSessionId');
    if (!playSessionId) {
      throw unprocessable('no_play_session', 'Jellyfin did not return a play session id');
    }

    const enforced = this.enforceTranscodeParams(rawTranscodeUrl, input, playSessionId);

    return {
      transcodeUrl: enforced.url,
      playSessionId,
      deviceId: enforced.deviceId,
      mediaSourceId: mediaSource.Id ?? input.mediaSourceId,
      itemId: input.itemId,
    };
  }

  /**
   * Resolve the negotiated TranscodingUrl against the configured Jellyfin
   * origin, strip any credentials, and make sure the parameters that enforce
   * our compatibility contract (no stream copy, encoded/burned subtitles) are
   * present. We never invent a URL from scratch: the base endpoint must come
   * from Jellyfin's negotiation response.
   */
  private enforceTranscodeParams(
    rawTranscodeUrl: string,
    input: NegotiateInput,
    playSessionId: string,
  ): { url: string; deviceId: string } {
    let reference = rawTranscodeUrl;
    if (reference.startsWith('//')) {
      reference = `${new URL(this.jellyfin.origin).protocol}${reference}`;
    }
    let resolved: URL;
    if (/^https?:/i.test(reference)) {
      resolved = validateUpstreamUrl(reference, this.jellyfin);
    } else if (reference.startsWith('/')) {
      const base = this.jellyfin.basePath;
      const pathname = reference.split(/[?#]/, 1)[0]!;
      const prefixed =
        base && pathname !== base && !pathname.startsWith(`${base}/`)
          ? `${base}${reference}`
          : reference;
      resolved = validateUpstreamUrl(`${this.jellyfin.origin}${prefixed}`, this.jellyfin);
    } else {
      throw unprocessable('invalid_transcode_url', 'Jellyfin returned an unusable transcoding URL');
    }
    // Require the negotiated URL to target the selected item's media namespace.
    validateUpstreamUrl(resolved.toString(), this.jellyfin, { itemId: input.itemId });

    resolved = stripSensitiveParams(resolved);
    const params = resolved.searchParams;
    // Preserve Jellyfin's negotiated parameters; only fill gaps and enforce the
    // compatibility/security-critical ones. With API-key auth Jellyfin may fix
    // DeviceId to the server id, so we keep whatever it negotiated and use that
    // exact value for cleanup.
    if (!params.has('MediaSourceId')) params.set('MediaSourceId', input.mediaSourceId);
    if (!params.has('PlaySessionId')) params.set('PlaySessionId', playSessionId);
    if (!params.has('DeviceId')) params.set('DeviceId', input.deviceId);
    if (!params.has('VideoCodec')) params.set('VideoCodec', 'h264');
    if (!params.has('AudioCodec')) params.set('AudioCodec', 'aac');
    if (!params.has('TranscodingMaxAudioChannels')) params.set('TranscodingMaxAudioChannels', '2');
    params.set('allowVideoStreamCopy', 'false');
    params.set('allowAudioStreamCopy', 'false');
    params.set('enableAutoStreamCopy', 'false');
    // Trickplay image playlists would add off-namespace, credential-bearing URIs.
    params.set('enableTrickplay', 'false');
    // Jellyfin's StreamInfo.ToUrl only emits StartTimeTicks for non-HLS targets,
    // so for HLS the saved start position must be carried explicitly or the
    // transcode begins at 0.
    if (input.startSeconds > 0 && !params.has('StartTimeTicks')) {
      params.set('StartTimeTicks', String(Math.round(input.startSeconds * 10_000_000)));
    }
    if (input.audioStreamIndex !== null && !params.has('AudioStreamIndex')) {
      params.set('AudioStreamIndex', String(input.audioStreamIndex));
    }
    if (input.subtitleStreamIndex >= 0) {
      params.set('SubtitleStreamIndex', String(input.subtitleStreamIndex));
      params.set('SubtitleMethod', 'Encode');
    } else {
      // Explicit -1 for None prevents Jellyfin from selecting a default subtitle.
      params.set('SubtitleStreamIndex', '-1');
      params.set('SubtitleMethod', 'Drop');
    }
    return { url: resolved.toString(), deviceId: params.get('DeviceId') ?? input.deviceId };
  }

  async fetchResource(url: string, options: UpstreamFetchOptions = {}): Promise<Response> {
    const validated = validateUpstreamUrl(url, this.jellyfin);
    try {
      return await this.request(
        validated.toString(),
        { method: options.method ?? 'GET', headers: options.headers, signal: options.signal },
        options.deviceId,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw upstreamError();
    }
  }

  /** Best-effort stop of a Jellyfin transcoding job. Never throws. */
  async stopEncoding(deviceId: string, playSessionId: string): Promise<void> {
    if (!deviceId || !playSessionId) return;
    const params = new URLSearchParams({ deviceId, playSessionId });
    const url = apiUrl(this.jellyfin, `/Videos/ActiveEncodings?${params.toString()}`);
    try {
      await this.request(url, { method: 'DELETE' }, deviceId);
    } catch {
      // cleanup is best-effort and must never crash the service
    }
  }
}
