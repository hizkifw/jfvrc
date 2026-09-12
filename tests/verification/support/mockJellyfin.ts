/**
 * Realistic mock Jellyfin HTTP server for integration verification.
 *
 * Shapes follow the documented Jellyfin REST API and the primary-source audit in
 * .tasks/design-review.md (BaseItemDto, PlaybackInfoResponse, DynamicHls routes,
 * Videos/ActiveEncodings). It is intentionally independent of the JFVRC
 * implementation so tests are not shaped exactly like the code under test.
 *
 * It records every request (method, path, query, headers) so tests can assert
 * what the gateway actually sent upstream and to whom.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export const MOVIE_ID = '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b';
export const SERIES_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
export const EPISODE_ID = '9c8b7a65-4321-4fed-8cba-0123456789ab';
export const SOURCE_ID = MOVIE_ID;
export const API_KEY = 'MOCK-JELLYFIN-API-KEY-do-not-log';
export const USER_ID = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
export const SECRET_TOKEN = 'sensitive-upstream-token-value';

export const SUBTITLE_ENCODE_INDEX = 2;
export const SUBTITLE_SECONDARY_INDEX = 3;
export const AUDIO_INDEX = 1;

export interface RecordedRequest {
  method: string;
  path: string;
  rawUrl: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type TranscodingUrlStyle =
  | 'rootRelativeWithBase'
  | 'rootRelativeWithoutBase'
  | 'absoluteWithBase'
  | 'absoluteWithoutBase';

export interface MockJellyfinOptions {
  basePath?: string;
  /** Require this API key (MediaBrowser Token header or X-Emby-Token or ApiKey query). */
  apiKey?: string;
  /** How the negotiated TranscodingUrl is shaped. */
  transcodingUrlStyle?: TranscodingUrlStyle;
  /** Include #EXT-X-IMAGE-STREAM-INF trickplay entries carrying ApiKey. */
  includeTrickplay?: boolean;
  /** Include #EXT-X-MEDIA subtitle renditions carrying ApiKey. */
  includeSubtitleRenditions?: boolean;
  /** Include hostile URI references in the variant playlist. */
  includeHostileRefs?: boolean;
  /** Append &ApiKey=<token> to the negotiated TranscodingUrl like Jellyfin does. */
  includeApiKeyInUrl?: boolean;
  /** Answer PlaybackInfo with a negotiation error. */
  playbackError?: boolean;
  /** Answer PlaybackInfo with a TranscodingUrl pointing at an external origin. */
  untrustedTranscodingUrl?: boolean;
  /** Respond to master.m3u8 with a 302 to this URL. */
  redirectMasterTo?: string;
  /** Segment ids (0-based) that should hang until the client aborts. */
  hangSegments?: number[];
  /** Segment ids that should be reported missing (404). */
  missingSegments?: number[];
  /** Machine-readable summaries requested by a test. */
  playbackInfoRequests?: boolean;
  /** Override the runTimeTicks returned for the item. */
  runTimeTicks?: number;
}

interface Scenario extends Required<Omit<MockJellyfinOptions, 'redirectMasterTo'>> {
  redirectMasterTo?: string;
}

const DEFAULTS = {
  basePath: '',
  apiKey: API_KEY,
  transcodingUrlStyle: 'rootRelativeWithoutBase' as TranscodingUrlStyle,
  includeTrickplay: true,
  includeSubtitleRenditions: true,
  includeHostileRefs: false,
  includeApiKeyInUrl: true,
  playbackError: false,
  untrustedTranscodingUrl: false,
  hangSegments: [] as number[],
  missingSegments: [] as number[],
  playbackInfoRequests: true,
  runTimeTicks: 7_200_000_000,
};

function youtubeIdSuffix(ticks: number): string {
  return ticks.toString();
}

export class MockJellyfin {
  readonly requests: RecordedRequest[] = [];
  private server: Server | null = null;
  private scenario: Scenario;
  private port = 0;
  private hangTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: MockJellyfinOptions = {}) {
    this.scenario = { ...DEFAULTS, ...options, redirectMasterTo: options.redirectMasterTo };
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get base(): string {
    return this.scenario.basePath;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const timer of this.hangTimers) clearTimeout(timer);
    this.hangTimers.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /** Requests whose path starts with the given prefix (after any base path). */
  find(pathIncludes: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path.includes(pathIncludes));
  }

  last(pathIncludes: string): RecordedRequest | undefined {
    return this.find(pathIncludes).at(-1);
  }

  private authFailure(req: IncomingMessage, url: URL): string | null {
    const header = req.headers['authorization'];
    let token: string | undefined;
    if (typeof header === 'string') {
      const match = /Token\s*=\s*"?([^",]+)"?/i.exec(header);
      if (match) token = match[1];
    }
    if (!token) {
      const emby = req.headers['x-emby-token'];
      if (typeof emby === 'string') token = emby;
    }
    if (!token) token = url.searchParams.get('ApiKey') ?? url.searchParams.get('api_key') ?? undefined;
    if (!token) return 'missing-token';
    if (this.scenario.apiKey && token !== this.scenario.apiKey) return 'bad-token';
    return null;
  }

  private record(req: IncomingMessage, url: URL, body: string): void {
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      rawUrl: req.url ?? '',
      query: url.searchParams,
      headers: req.headers as RecordedRequest['headers'],
      body,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const base = this.scenario.basePath;
    const raw = req.url ?? '/';
    const url = new URL(raw, this.origin);

    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      path = path.slice(base.length) || '/';
    }

    this.record(req, url, body);

    const authError = this.authFailure(req, url);

    // Public status endpoint some clients probe before auth.
    if (path === '/System/Info/Public') {
      json(res, 200, { ServerName: 'MockJellyfin', Version: '10.10.0', Id: 'mock' });
      return;
    }

    if (authError) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: authError }));
      return;
    }

    const method = req.method ?? 'GET';

    if (method === 'GET' && (path === '/Items' || /^\/Users\/[^/]+\/Items$/.test(path))) {
      return this.handleLibrary(res, url);
    }

    if (method === 'GET' && /^\/Items\/[^/]+$/.test(path)) {
      return this.handleItem(res, url, decodeURIComponent(path.split('/')[2]!));
    }

    if (method === 'GET' && /^\/Users\/[^/]+\/Items\/[^/]+$/.test(path)) {
      return this.handleItem(res, url, decodeURIComponent(path.split('/')[4]!));
    }

    if (method === 'POST' && /^\/Items\/[^/]+\/PlaybackInfo$/.test(path)) {
      return this.handlePlaybackInfo(res, url, body, decodeURIComponent(path.split('/')[2]!));
    }

    if (method === 'GET' && /\/master\.m3u8$/.test(path)) {
      return this.handleMaster(res, url);
    }

    if (method === 'GET' && /\/main\.m3u8$/.test(path)) {
      return this.handleVariant(res, url);
    }

    if (method === 'GET' && /\/hls1\/[^/]+\/[^/]+\.(ts|mp4)$/.test(path)) {
      return this.handleSegment(res, url, path);
    }

    if (method === 'DELETE' && path === '/Videos/ActiveEncodings') {
      json(res, 204, null);
      return;
    }

    if (path.startsWith('/redirect/')) {
      res.statusCode = 302;
      res.setHeader('Location', this.scenario.redirectMasterTo ?? 'https://evil.example/master.m3u8');
      res.end();
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private handleLibrary(res: ServerResponse, url: URL): void {
    const search = (url.searchParams.get('SearchTerm') ?? url.searchParams.get('searchTerm') ?? '').toLowerCase();
    const startIndex = Number(url.searchParams.get('StartIndex') ?? url.searchParams.get('startIndex') ?? 0);
    const limit = Number(url.searchParams.get('Limit') ?? url.searchParams.get('limit') ?? 24);
    const all = [movieDto(), episodeDto(), ...[1, 2, 3, 4, 5].map((n) => movieDto(`${MOVIE_ID.slice(0, -1)}${n}`, `Catalog Movie ${n}`))];
    const filtered = search ? all.filter((i) => i.Name.toLowerCase().includes(search)) : all;
    const page = filtered.slice(startIndex, startIndex + limit);
    json(res, 200, {
      Items: page,
      TotalRecordCount: filtered.length,
      StartIndex: startIndex,
    });
  }

  private handleItem(res: ServerResponse, _url: URL, id: string): void {
    // Real Jellyfin's UserLibraryController.GetItem uses `new DtoOptions()`,
    // whose default constructor enables ALL fields, so MediaSources is always
    // present on the single-item route regardless of a `fields` query param.
    const item = id === EPISODE_ID ? episodeDto() : id === SERIES_ID ? seriesDto() : movieDto(id);
    json(res, 200, item);
  }

  private handlePlaybackInfo(res: ServerResponse, url: URL, body: string, id: string): void {
    if (this.scenario.playbackError) {
      json(res, 200, {
        MediaSources: [],
        PlaySessionId: 'failed-session',
        ErrorCode: 'NoCompatibleStream',
      });
      return;
    }

    const base = this.scenario.basePath;
    const style = this.scenario.transcodingUrlStyle;
    const includeBase = style.endsWith('WithBase');
    const absolute = style.startsWith('absolute');

    const query = new URLSearchParams();
    query.set('DeviceId', 'upstream-device');
    query.set('MediaSourceId', SOURCE_ID);
    query.set('VideoCodec', 'h264');
    query.set('AudioCodec', 'aac');
    query.set('TranscodingContainer', 'ts');
    query.set('SegmentContainer', 'ts');
    query.set('PlaySessionId', 'mock-play-session-123456');
    query.set('SubtitleStreamIndex', String(SUBTITLE_ENCODE_INDEX));
    query.set('SubtitleMethod', 'Encode');
    query.set('AllowVideoStreamCopy', 'false');
    query.set('AllowAudioStreamCopy', 'false');
    query.set('TranscodeReasons', 'VideoCodecNotSupported');
    if (this.scenario.includeApiKeyInUrl) query.set('ApiKey', SECRET_TOKEN);

    let transcodingUrl: string;
    if (this.scenario.untrustedTranscodingUrl) {
      transcodingUrl = `https://evil.example/videos/${id}/master.m3u8?${query.toString()}`;
    } else {
      const pathPart = `/videos/${id}/master.m3u8`;
      const withBase = `${base}${pathPart}`;
      const withoutBase = `${pathPart}`;
      const chosen = includeBase ? withBase : withoutBase;
      transcodingUrl = absolute ? `http://127.0.0.1:${this.port}${chosen}?${query}` : `${chosen}?${query}`;
    }

    json(res, 200, {
      PlaySessionId: 'mock-play-session-123456',
      MediaSources: [
        {
          Id: SOURCE_ID,
          Name: '1080p',
          Container: 'ts',
          TranscodingUrl: transcodingUrl,
          TranscodingContainer: 'ts',
          TranscodingSubProtocol: 'hls',
          RunTimeTicks: this.scenario.runTimeTicks,
          SupportsDirectPlay: false,
          SupportsDirectStream: false,
          SupportsTranscoding: true,
          DefaultAudioStreamIndex: AUDIO_INDEX,
          DefaultSubtitleStreamIndex: SUBTITLE_ENCODE_INDEX,
          MediaStreams: movieStreams(),
        },
      ],
      ErrorCode: null,
    });
  }

  private handleMaster(res: ServerResponse, url: URL): void {
    if (this.scenario.redirectMasterTo) {
      res.statusCode = 302;
      res.setHeader('Location', this.scenario.redirectMasterTo);
      res.end();
      return;
    }
    const forwardQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    const lines: string[] = ['#EXTM3U'];
    if (this.scenario.includeSubtitleRenditions) {
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,FORCED=NO,AUTOSELECT=YES,URI="${SOURCE_ID}/Subtitles/${SUBTITLE_ENCODE_INDEX}/subtitles.m3u8?SegmentLength=30&ApiKey=${SECRET_TOKEN}",LANGUAGE="eng"`,
      );
    }
    if (this.scenario.includeTrickplay) {
      lines.push(
        `#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8?MediaSourceId=${SOURCE_ID}&ApiKey=${SECRET_TOKEN}"`,
      );
    }
    if (this.scenario.includeSubtitleRenditions) {
      lines.push('#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,SUBTITLES="subs"');
    } else {
      lines.push('#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080');
    }
    lines.push(`main.m3u8${forwardQuery ? `?${forwardQuery}` : ''}`);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-cache');
    res.end(`${lines.join('\n')}\n`);
  }

  private handleVariant(res: ServerResponse, url: URL): void {
    const forwardQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    const q = forwardQuery ? `?${forwardQuery}` : '';
    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];
    if (this.scenario.includeHostileRefs) {
      lines.push('#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key.bin",IV=0x1234');
      lines.push('#EXT-X-MAP:URI="../../../../etc/passwd"');
      lines.push('file:///etc/passwd');
      lines.push('//evil.example/segment.ts');
      lines.push('https://evil.example/absolute.ts');
      lines.push('hls1/main/%2e%2e%2f%2e%2e%2fetc%2fpasswd.ts');
    }
    for (let i = 0; i < 4; i += 1) {
      const runtimeTicks = i * 60_000_000;
      lines.push('#EXTINF:6.000,');
      lines.push(`hls1/main/${i}.ts${q}${q ? '&' : '?'}runtimeTicks=${runtimeTicks}&actualSegmentLengthTicks=60000000`);
      lines.push('');
    }
    lines.push('#EXT-X-ENDLIST');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end(`${lines.join('\n')}\n`);
  }

  private handleSegment(res: ServerResponse, _url: URL, path: string): void {
    const base = path.split('/').pop()!;
    const id = Number(base.replace(/\.(ts|mp4)$/, ''));
    if (this.scenario.missingSegments.includes(id)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const payload = Buffer.alloc(1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    const total = payload.length;

    const sendFull = () => {
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp2t');
      res.setHeader('content-length', String(total));
      res.end(payload);
    };

    if (this.scenario.hangSegments.includes(id)) {
      // Send headers + a little body then stall to exercise abort/backpressure.
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp2t');
      res.write(payload.subarray(0, 64));
      const timer = setTimeout(() => {
        this.hangTimers.delete(timer);
        try {
          res.end(payload.subarray(64));
        } catch {
          /* client already gone */
        }
      }, 5000);
      this.hangTimers.add(timer);
      res.on('close', () => {
        clearTimeout(timer);
        this.hangTimers.delete(timer);
      });
      return;
    }

    const range = res.req.headers['range'];
    if (typeof range === 'string') {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : total - 1;
        if (start >= total || end >= total || start > end) {
          res.statusCode = 416;
          res.setHeader('content-range', `bytes */${total}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('content-type', 'video/mp2t');
        res.setHeader('content-range', `bytes ${start}-${end}/${total}`);
        res.setHeader('content-length', String(end - start + 1));
        res.end(payload.subarray(start, end + 1));
        return;
      }
    }
    sendFull();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  if (value === null) {
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

export function movieStreams() {
  return [
    {
      Index: 0,
      Type: 'Video',
      Codec: 'h264',
      Width: 1920,
      Height: 1080,
      BitDepth: 8,
      IsDefault: true,
      DisplayTitle: '1080p H264',
    },
    {
      Index: AUDIO_INDEX,
      Type: 'Audio',
      Codec: 'aac',
      Channels: 2,
      SampleRate: 48000,
      Language: 'eng',
      IsDefault: true,
      DisplayTitle: 'English AAC Stereo',
    },
    {
      Index: SUBTITLE_ENCODE_INDEX,
      Type: 'Subtitle',
      Codec: 'subrip',
      Language: 'eng',
      IsDefault: true,
      IsForced: false,
      IsTextSubtitleStream: true,
      DisplayTitle: 'English',
    },
    {
      Index: SUBTITLE_SECONDARY_INDEX,
      Type: 'Subtitle',
      Codec: 'ass',
      Language: 'jpn',
      IsDefault: false,
      IsForced: true,
      IsTextSubtitleStream: true,
      DisplayTitle: 'Japanese (Forced)',
    },
  ];
}

export function movieDto(id: string = MOVIE_ID, name = 'Test Movie') {
  return {
    Id: id,
    Name: name,
    Type: 'Movie',
    ProductionYear: 2019,
    RunTimeTicks: 7_200_000_000,
    Overview: 'A verification movie.',
    MediaSources: [
      {
        Id: id,
        Name: '1080p',
        Container: 'mkv',
        RunTimeTicks: 7_200_000_000,
        Protocol: 'File',
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        MediaStreams: movieStreams(),
      },
    ],
    MediaStreams: movieStreams(),
  };
}

export function episodeDto() {
  return {
    Id: EPISODE_ID,
    Name: 'Pilot',
    Type: 'Episode',
    SeriesName: 'Verification Show',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    ProductionYear: 2020,
    RunTimeTicks: 2_700_000_000,
    Overview: 'First episode.',
    MediaSources: [
      {
        Id: EPISODE_ID,
        Name: '720p',
        Container: 'mkv',
        RunTimeTicks: 2_700_000_000,
        Protocol: 'File',
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        MediaStreams: movieStreams(),
      },
    ],
    MediaStreams: movieStreams(),
  };
}

export function seriesDto() {
  return {
    Id: SERIES_ID,
    Name: 'Verification Show',
    Type: 'Series',
    MediaSources: [],
    MediaStreams: [],
  };
}

export { youtubeIdSuffix };
