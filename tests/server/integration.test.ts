import { afterEach, describe, expect, it } from 'vitest';
import { ITEM_ID, MEDIA_SOURCE_ID, MOVIES_LIBRARY_ID, SEASON_ID, SERIES_ID, TV_LIBRARY_ID } from './mock-jellyfin';
import { findResource, resourcePaths, setup, teardown, type TestContext } from './helpers';

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await teardown(ctx);
});

async function createLink(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; url: string; token: string; path: string }> {
  const res = await ctx.built.app.inject({
    method: 'POST',
    url: '/api/links',
    headers: ctx.auth,
    payload: {
      itemId: ITEM_ID,
      mediaSourceId: MEDIA_SOURCE_ID,
      audioStreamIndex: 1,
      subtitleStreamIndex: 2,
      preset: '1080p',
      startSeconds: 0,
      expiresInHours: 24,
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const path = new URL(body.url).pathname;
  const token = path.split('/')[2]!;
  return { id: body.id, url: body.url, token, path };
}

describe('health and auth', () => {
  it('serves health without auth and protects /api routes', async () => {
    ctx = await setup();
    const health = await ctx.built.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const noAuth = await ctx.built.app.inject({ method: 'GET', url: '/api/status' });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error.code).toBe('unauthorized');

    const badAuth = await ctx.built.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(badAuth.statusCode).toBe(401);

    const ok = await ctx.built.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: ctx.auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      configured: true,
      jellyfinUrl: ctx.mock.url,
      publicBaseUrl: 'https://gateway.test',
    });
  });
});

describe('resolve and library', () => {
  it('resolves a bare id, fragment URL, and rejects foreign origins', async () => {
    ctx = await setup();

    const bare = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: ctx.auth,
      payload: { input: ITEM_ID },
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.json().name).toBe('Mock Movie');
    expect(bare.json().mediaSources[0].subtitleTracks).toHaveLength(2);

    const urlInput = `${ctx.mock.url}/web/index.html#!/details?id=${ITEM_ID}&serverId=abc`;
    const fromUrl = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: ctx.auth,
      payload: { input: urlInput },
    });
    expect(fromUrl.statusCode).toBe(200);
    expect(fromUrl.json().id).toBe(ITEM_ID);

    const foreign = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: ctx.auth,
      payload: { input: `https://evil.example/web/index.html#!/details?id=${ITEM_ID}` },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('untrusted_origin');

    const junk = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: ctx.auth,
      payload: { input: 'not a url or id' },
    });
    expect(junk.statusCode).toBe(400);
  });

  it('searches the library with pagination metadata', async () => {
    ctx = await setup();
    const res = await ctx.built.app.inject({
      method: 'GET',
      url: '/api/library?query=&startIndex=0&limit=24',
      headers: ctx.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().total).toBe(1);

    const bad = await ctx.built.app.inject({
      method: 'GET',
      url: '/api/library?limit=1000',
      headers: ctx.auth,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('browses libraries into series, seasons and episodes', async () => {
    ctx = await setup();
    const get = (url: string) =>
      ctx.built.app.inject({ method: 'GET', url, headers: ctx.auth });

    const views = await get('/api/library/views');
    expect(views.statusCode).toBe(200);
    const libraries = views.json().items as Array<{ id: string; type: string }>;
    expect(libraries.map((l) => l.type)).toEqual(['CollectionFolder', 'CollectionFolder']);

    const movies = await get(`/api/library/items?parentId=${MOVIES_LIBRARY_ID}`);
    expect(movies.statusCode).toBe(200);
    expect(movies.json().items[0]).toMatchObject({ type: 'Movie' });

    const shows = await get(`/api/library/items?parentId=${TV_LIBRARY_ID}`);
    expect(shows.json().items[0]).toMatchObject({ id: SERIES_ID, type: 'Series' });

    const seasons = await get(`/api/library/shows/${SERIES_ID}/seasons`);
    expect(seasons.json().items[0]).toMatchObject({ type: 'Season' });

    const episodes = await get(
      `/api/library/shows/${SERIES_ID}/seasons/${SEASON_ID}/episodes`,
    );
    expect(episodes.json().items[0]).toMatchObject({ type: 'Episode', episodeNumber: 1 });

    const invalid = await get('/api/library/items?parentId=nope');
    expect(invalid.statusCode).toBe(400);
  });

  it('serves item artwork through the authenticated image route', async () => {
    ctx = await setup();
    const image = await ctx.built.app.inject({
      method: 'GET',
      url: `/api/items/${ITEM_ID}/image?type=Primary&width=400&height=225`,
      headers: ctx.auth,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/jpeg');
    expect(image.rawPayload.toString()).toBe('MOCK-IMAGE-BYTES');

    const unauth = await ctx.built.app.inject({
      method: 'GET',
      url: `/api/items/${ITEM_ID}/image`,
    });
    expect(unauth.statusCode).toBe(401);
  });
});

describe('links', () => {
  it('creates, lists and revokes links without leaking tokens', async () => {
    ctx = await setup();
    const link = await createLink();

    const list = await ctx.built.app.inject({ method: 'GET', url: '/api/links', headers: ctx.auth });
    expect(list.statusCode).toBe(200);
    const links = list.json().links;
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(link.id);
    expect(links[0]).not.toHaveProperty('url');
    expect(JSON.stringify(links)).not.toContain(link.token);

    const revoke = await ctx.built.app.inject({
      method: 'DELETE',
      url: `/api/links/${link.id}`,
      headers: ctx.auth,
    });
    expect(revoke.statusCode).toBe(204);
    const after = await ctx.built.app.inject({ method: 'GET', url: '/api/links', headers: ctx.auth });
    expect(after.json().links[0].revoked).toBe(true);
  });

  it('validates source and track ownership', async () => {
    ctx = await setup();
    const badSource = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: ctx.auth,
      payload: {
        itemId: ITEM_ID,
        mediaSourceId: 'nope',
        subtitleStreamIndex: -1,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 24,
      },
    });
    expect(badSource.statusCode).toBe(422);
    expect(badSource.json().error.code).toBe('unknown_media_source');

    const badAudio = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: ctx.auth,
      payload: {
        itemId: ITEM_ID,
        mediaSourceId: MEDIA_SOURCE_ID,
        audioStreamIndex: 99,
        subtitleStreamIndex: -1,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 24,
      },
    });
    expect(badAudio.statusCode).toBe(422);
    expect(badAudio.json().error.code).toBe('unknown_audio_track');

    const badSub = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: ctx.auth,
      payload: {
        itemId: ITEM_ID,
        mediaSourceId: MEDIA_SOURCE_ID,
        subtitleStreamIndex: 99,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 24,
      },
    });
    expect(badSub.statusCode).toBe(422);
    expect(badSub.json().error.code).toBe('unknown_subtitle_track');

    const tooLong = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: ctx.auth,
      payload: {
        itemId: ITEM_ID,
        mediaSourceId: MEDIA_SOURCE_ID,
        subtitleStreamIndex: -1,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 100000,
      },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('expiry_too_long');
  });
});

describe('playback', () => {
  it('rewrites nested manifests without leaking upstream URL or api key', async () => {
    ctx = await setup();
    const link = await createLink();

    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    expect(master.body).toContain('#EXTM3U');
    expect(master.body).not.toContain('api_key');
    expect(master.body).not.toContain('SECRET-API-KEY');
    expect(master.body).not.toContain(ctx.mock.url);
    expect(master.headers['cache-control']).toBe('no-store');

    const paths = resourcePaths(master.body);
    expect(paths.length).toBeGreaterThanOrEqual(4);

    const mainPath = findResource(master.body, 'main.m3u8');
    const main = await ctx.built.app.inject({ method: 'GET', url: mainPath });
    expect(main.statusCode).toBe(200);
    expect(main.body).toContain('#EXT-X-MAP:URI="/s/');
    expect(main.body).toContain('#EXT-X-KEY:METHOD=AES-128,URI="/s/');
    expect(main.body).toContain('#EXT-X-PART:DURATION=1.0,URI="/s/');
    expect(main.body).toContain('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="/s/');
    expect(main.body).not.toContain(ctx.mock.url);
    expect(main.body).not.toContain('api_key');

    const segmentPath = findResource(main.body, 'seg1.ts');
    const segment = await ctx.built.app.inject({
      method: 'GET',
      url: segmentPath,
      headers: { range: 'bytes=0-4' },
    });
    expect(segment.statusCode).toBe(206);
    expect(segment.headers['content-range']).toMatch(/^bytes 0-4\/\d+$/);
    expect(segment.body.length).toBe(5);

    const iframePath = findResource(master.body, 'iframe.m3u8');
    const iframe = await ctx.built.app.inject({ method: 'GET', url: iframePath });
    expect(iframe.statusCode).toBe(200);
    expect(iframe.body).toContain('/s/');

    const keyPath = findResource(master.body, 'key.key');
    const key = await ctx.built.app.inject({ method: 'GET', url: keyPath });
    expect(key.statusCode).toBe(200);
  });

  it('reuses one session for repeated entry requests to the same link', async () => {
    ctx = await setup();
    const link = await createLink();
    const before = ctx.mock.playbackInfoRequests;
    const first = await ctx.built.app.inject({ method: 'GET', url: link.path });
    const second = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(ctx.mock.playbackInfoRequests).toBe(before + 1);
    const sessionOf = (res: { body: string }) => findResource(res.body, 'main.m3u8').split('/')[4];
    expect(sessionOf(first)).toBe(sessionOf(second));
  });

  it('does not start a transcode on HEAD entry and rejects forged resources', async () => {
    ctx = await setup();
    const link = await createLink();
    const before = ctx.mock.playbackInfoRequests;
    const head = await ctx.built.app.inject({ method: 'HEAD', url: link.path });
    expect(head.statusCode).toBe(200);
    expect(ctx.mock.playbackInfoRequests).toBe(before);

    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    const mainPath = findResource(master.body, 'main.m3u8');
    const forged = mainPath.replace(/\/p\/[^/]+\//, '/p/forged-session/');
    const forgedRes = await ctx.built.app.inject({ method: 'GET', url: forged });
    expect(forgedRes.statusCode).toBe(404);

    const badResource = mainPath.replace(/\/[^/]+\/main\.m3u8$/, '/forgedresource/main.m3u8');
    const badRes = await ctx.built.app.inject({ method: 'GET', url: badResource });
    expect(badRes.statusCode).toBe(404);
  });

  it('negotiates subtitle burn-in and enforces no stream copy', async () => {
    ctx = await setup();
    const link = await createLink({ subtitleStreamIndex: 2 });
    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);

    const body = ctx.mock.lastPlaybackInfoBody!;
    expect(body.AlwaysBurnInSubtitleWhenTranscoding).toBe(true);
    expect(body.EnableDirectPlay).toBe(false);
    expect(body.EnableDirectStream).toBe(false);
    expect(body.EnableTranscoding).toBe(true);
    expect(body.AllowVideoStreamCopy).toBe(false);
    expect(body.AllowAudioStreamCopy).toBe(false);
    const profile = body.DeviceProfile as {
      TranscodingProfiles: Array<{ Container: string; Protocol: string; VideoCodec: string }>;
      SubtitleProfiles: Array<{ Method: string }>;
    };
    expect(profile.TranscodingProfiles[0]!.Container).toBe('ts');
    expect(profile.TranscodingProfiles[0]!.Protocol).toBe('hls');
    expect(profile.TranscodingProfiles[0]!.VideoCodec).toBe('h264');
    expect(profile.SubtitleProfiles.every((p) => p.Method === 'Encode')).toBe(true);

    const query = ctx.mock.lastMasterQuery!;
    expect(query.get('SubtitleMethod')).toBe('Encode');
    expect(query.get('SubtitleStreamIndex')).toBe('2');
    expect(query.get('allowVideoStreamCopy')).toBe('false');
    expect(query.get('enableTrickplay')).toBe('false');
    expect(query.get('api_key')).toBeNull();
    expect(query.get('VideoCodec')).toBe('h264');
  });

  it('explicitly requests no subtitles with -1 for None', async () => {
    ctx = await setup();
    const link = await createLink({ subtitleStreamIndex: -1 });
    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    const query = ctx.mock.lastMasterQuery!;
    expect(query.get('SubtitleStreamIndex')).toBe('-1');
    expect(query.get('SubtitleMethod')).toBe('Drop');
    const body = ctx.mock.lastPlaybackInfoBody!;
    expect(body.AlwaysBurnInSubtitleWhenTranscoding).toBe(false);
    expect(body.SubtitleStreamIndex).toBe(-1);
  });

  it('stops child encodings when a link is revoked and denies later playback', async () => {
    ctx = await setup();
    const link = await createLink();
    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    expect(ctx.built.playback!.activeSessionCount).toBe(1);

    await ctx.built.app.inject({ method: 'DELETE', url: `/api/links/${link.id}`, headers: ctx.auth });
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.built.playback!.activeSessionCount).toBe(0);
    expect(ctx.mock.stops.length).toBeGreaterThanOrEqual(1);
    expect(ctx.mock.stops[0]!.deviceId).not.toBe('');
    expect(ctx.mock.stops[0]!.playSessionId).toBe('ps-123');

    const after = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(after.statusCode).toBe(410);
    expect(after.json().error.code).toBe('link_revoked');
  });

  it('rejects expired links even before any session exists', async () => {
    ctx = await setup();
    const past = new Date(Date.now() - 60_000).toISOString();
    const { record, token } = ctx.built.store.createLink({
      item: { id: ITEM_ID, name: 'Mock Movie', type: 'Movie' },
      mediaSourceId: MEDIA_SOURCE_ID,
      audioStreamIndex: null,
      subtitleStreamIndex: -1,
      preset: '1080p',
      startSeconds: 0,
      expiresAt: past,
    });
    expect(record.id).toBeTruthy();
    const res = await ctx.built.app.inject({ method: 'GET', url: `/s/${token}/master.m3u8` });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('link_expired');
  });
});

describe('base path support', () => {
  it('resolves and proxies when Jellyfin is mounted under /jellyfin', async () => {
    ctx = await setup('/jellyfin');
    const link = await createLink();
    const master = await ctx.built.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    expect(master.body).not.toContain('api_key');
    const mainPath = findResource(master.body, 'main.m3u8');
    const main = await ctx.built.app.inject({ method: 'GET', url: mainPath });
    expect(main.statusCode).toBe(200);
    const seg = await ctx.built.app.inject({
      method: 'GET',
      url: findResource(main.body, 'seg1.ts'),
    });
    expect(seg.statusCode).toBe(200);
  });
});
