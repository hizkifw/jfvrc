import Fastify, { type FastifyInstance } from 'fastify';

export const ITEM_ID = '11111111-1111-1111-1111-111111111111';
export const MEDIA_SOURCE_ID = 'src-main';
export const SERIES_ID = '22222222-2222-2222-2222-222222222222';
export const SEASON_ID = '33333333-3333-3333-3333-333333333333';
export const TV_LIBRARY_ID = '44444444-4444-4444-4444-444444444444';
export const MOVIES_LIBRARY_ID = '55555555-5555-5555-5555-555555555555';

const SEGMENT_BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzSEGMENTDATA');

export interface RecordedStop {
  deviceId: string;
  playSessionId: string;
}

export interface MockJellyfin {
  url: string;
  app: FastifyInstance;
  playbackInfoRequests: number;
  masterRequests: number;
  headRequests: number;
  stops: RecordedStop[];
  lastPlaybackInfoBody: Record<string, unknown> | null;
  lastMasterQuery: URLSearchParams | null;
  stop(): Promise<void>;
}

function itemPayload() {
  return {
    Id: ITEM_ID,
    Name: 'Mock Movie',
    Type: 'Movie',
    ProductionYear: 2024,
    Overview: 'A mock movie used by integration tests.',
    RunTimeTicks: 7_200_000_000,
    MediaSources: [
      {
        Id: MEDIA_SOURCE_ID,
        Name: 'Main Source',
        MediaStreams: [
          { Index: 0, Type: 'Video', Codec: 'h264', DisplayTitle: '1080p H264', Width: 1920, Height: 1080, BitDepth: 8, IsDefault: true },
          { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', DisplayTitle: 'English AAC', Channels: 2, IsDefault: true },
          { Index: 2, Type: 'Subtitle', Codec: 'srt', Language: 'eng', DisplayTitle: 'English SRT', IsDefault: true },
          { Index: 3, Type: 'Subtitle', Codec: 'pgs', Language: 'eng', DisplayTitle: 'English PGS', IsForced: true },
        ],
      },
    ],
  };
}

function episodePayload() {
  return {
    Id: ITEM_ID,
    Name: 'Mock Pilot',
    Type: 'Episode',
    SeriesName: 'Mock Show',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    RunTimeTicks: 2_700_000_000,
    MediaSources: itemPayload().MediaSources,
  };
}

function seriesPayload() {
  return { Id: SERIES_ID, Name: 'Mock Show', Type: 'Series', ChildCount: 1 };
}

function seasonPayload() {
  return {
    Id: SEASON_ID,
    Name: 'Season 1',
    Type: 'Season',
    SeriesName: 'Mock Show',
    SeriesId: SERIES_ID,
    IndexNumber: 1,
    ChildCount: 1,
  };
}

function childrenOf(parentId: string): unknown[] {
  if (parentId === MOVIES_LIBRARY_ID) return [itemPayload()];
  if (parentId === TV_LIBRARY_ID) return [seriesPayload()];
  if (parentId === SERIES_ID) return [seasonPayload()];
  if (parentId === SEASON_ID) return [episodePayload()];
  return [];
}

export async function startMockJellyfin(basePath = ''): Promise<MockJellyfin> {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  const state: Omit<MockJellyfin, 'url' | 'app' | 'stop'> = {
    playbackInfoRequests: 0,
    masterRequests: 0,
    headRequests: 0,
    stops: [],
    lastPlaybackInfoBody: null,
    lastMasterQuery: null,
  };

  const register = (instance: FastifyInstance, prefix: string): void => {
    const p = (path: string) => `${prefix}${path}`;

    instance.get(p('/Items/:id'), async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id.toLowerCase().replace(/-/g, '') !== ITEM_ID.replace(/-/g, '')) {
        reply.code(404);
        return { error: 'not found' };
      }
      return itemPayload();
    });

    instance.get(p('/UserViews'), async () => ({
      Items: [
        { Id: MOVIES_LIBRARY_ID, Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies', ChildCount: 1 },
        { Id: TV_LIBRARY_ID, Name: 'TV Shows', Type: 'CollectionFolder', CollectionType: 'tvshows', ChildCount: 1 },
      ],
      TotalRecordCount: 2,
    }));

    instance.get(p('/Items'), async (request) => {
      const q = request.query as { searchTerm?: string; parentId?: string };
      if (q.parentId) {
        return { Items: childrenOf(q.parentId), TotalRecordCount: 1 };
      }
      const all = !!q.searchTerm;
      return {
        Items: all ? [] : [itemPayload()],
        TotalRecordCount: all ? (String(q.searchTerm).toLowerCase() === 'mock' ? 1 : 0) : 1,
      };
    });

    instance.get(p('/Shows/:seriesId/Seasons'), async (request) => {
      const { seriesId } = request.params as { seriesId: string };
      const items = seriesId === SERIES_ID ? [seasonPayload()] : [];
      return { Items: items, TotalRecordCount: items.length };
    });

    instance.get(p('/Shows/:seriesId/Episodes'), async (request) => {
      const { seriesId } = request.params as { seriesId: string };
      const q = request.query as { seasonId?: string };
      const items =
        seriesId === SERIES_ID && (!q.seasonId || q.seasonId === SEASON_ID) ? [episodePayload()] : [];
      return { Items: items, TotalRecordCount: items.length };
    });

    instance.post(p('/Items/:id/PlaybackInfo'), async (request) => {
      state.playbackInfoRequests += 1;
      state.lastPlaybackInfoBody = (request.body ?? null) as Record<string, unknown> | null;
      const transcodeUrl =
        `${prefix}/Videos/${ITEM_ID}/master.m3u8?MediaSourceId=${MEDIA_SOURCE_ID}` +
        `&PlaySessionId=ps-123&api_key=SECRET-API-KEY&VideoCodec=h264&AudioCodec=aac`;
      return {
        MediaSources: [
          {
            Id: MEDIA_SOURCE_ID,
            Name: 'Main Source',
            SupportsTranscoding: true,
            TranscodingSubProtocol: 'hls',
            TranscodingUrl: transcodeUrl,
          },
        ],
        PlaySessionId: 'ps-123',
      };
    });

    instance.get(p('/Videos/:id/master.m3u8'), async (request, reply) => {
      state.masterRequests += 1;
      state.lastMasterQuery = new URL(request.url, 'http://mock').searchParams;
      reply.type('application/vnd.apple.mpegurl');
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8?keep=1"',
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,AUDIO="aud"',
        'main.m3u8?foo=bar',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="/Videos/' + ITEM_ID + '/iframe.m3u8"',
        `#EXT-X-SESSION-KEY:METHOD=AES-128,URI="${prefix}/Videos/${ITEM_ID}/hls1/pl/key.key"`,
        '',
      ].join('\n');
    });

    instance.head(p('/Videos/:id/master.m3u8'), async (_request, reply) => {
      state.headRequests += 1;
      reply.type('application/vnd.apple.mpegurl');
      return null;
    });

    instance.get(p('/Videos/:id/main.m3u8'), async (_request, reply) => {
      reply.type('application/vnd.apple.mpegurl');
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MAP:URI="hls1/pl/init.mp4?m=1"',
        '#EXT-X-KEY:METHOD=AES-128,URI="hls1/pl/key.key"',
        '#EXTINF:6.0,',
        'hls1/pl/seg1.ts',
        '#EXTINF:6.0,',
        'hls1/pl/seg2.ts',
        '#EXT-X-PART:DURATION=1.0,URI="hls1/pl/part1.ts"',
        '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="hls1/pl/part2.ts"',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n');
    });

    instance.get(p('/Videos/:id/iframe.m3u8'), async (_request, reply) => {
      reply.type('application/vnd.apple.mpegurl');
      return ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-I-FRAMES-ONLY', '#EXTINF:6.0,', 'hls1/pl/iframe.ts', ''].join('\n');
    });

    instance.get(p('/Videos/:id/hls1/:playlist/:segment'), async (request, reply) => {
      const querySegment = new URL(request.url, 'http://mock').searchParams.get('segment');
      const resourceName = querySegment ?? (request.params as { segment: string }).segment;
      const range = request.headers.range;
      if (resourceName.endsWith('.m3u8')) {
        reply.type('application/vnd.apple.mpegurl');
        return '#EXTM3U\n#EXT-X-ENDLIST\n';
      }
      reply.type(resourceName.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t');
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : SEGMENT_BYTES.length - 1;
          const safeEnd = Math.min(end, SEGMENT_BYTES.length - 1);
          const slice = SEGMENT_BYTES.subarray(start, safeEnd + 1);
          reply.code(206);
          reply.header('Content-Range', `bytes ${start}-${safeEnd}/${SEGMENT_BYTES.length}`);
          reply.header('Accept-Ranges', 'bytes');
          reply.header('Content-Length', String(slice.length));
          return slice;
        }
      }
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Length', String(SEGMENT_BYTES.length));
      return SEGMENT_BYTES;
    });

    instance.delete(p('/Videos/ActiveEncodings'), async (request, reply) => {
      const q = request.query as { deviceId?: string; playSessionId?: string };
      state.stops.push({ deviceId: q.deviceId ?? '', playSessionId: q.playSessionId ?? '' });
      reply.code(204);
      return null;
    });
  };

  if (basePath) {
    register(app, basePath);
  } else {
    register(app, '');
  }

  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url,
    app,
    get playbackInfoRequests() {
      return state.playbackInfoRequests;
    },
    get masterRequests() {
      return state.masterRequests;
    },
    get headRequests() {
      return state.headRequests;
    },
    get stops() {
      return state.stops;
    },
    get lastPlaybackInfoBody() {
      return state.lastPlaybackInfoBody;
    },
    get lastMasterQuery() {
      return state.lastMasterQuery;
    },
    stop: async () => {
      await app.close();
    },
  };
}
