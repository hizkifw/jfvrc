import { afterEach, describe, expect, it } from 'vitest';
import { EPISODE_ID, MOVIE_ID, SECRET_TOKEN } from './support/mockJellyfin';
import { ADMIN_TOKEN, createLink, startStack, type Stack } from './support/harness';

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe('API contract and frontend compatibility', () => {
  it('serves /health without auth and does not leak secrets', async () => {
    stack = await startStack();
    const res = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.body).not.toContain('JELLYFIN_API_KEY');
  });

  it('requires the admin bearer token on /api routes', async () => {
    stack = await startStack();
    const missing = await stack.app.inject({ method: 'GET', url: '/api/status' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const wrong = await stack.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('returns a sanitized /api/status (no credentials, no token)', async () => {
    stack = await startStack();
    const res = await stack.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: stack.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string>;
    expect(body.configured).toBe(true);
    expect(body.publicBaseUrl).toBe('https://gateway.example');
    expect(JSON.stringify(body)).not.toContain('MOCK-JELLYFIN-API-KEY');
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
  });

  it('resolves a direct UUID and a Jellyfin URL, returning media sources and tracks', async () => {
    stack = await startStack();
    const byId = await stack.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { input: MOVIE_ID },
    });
    expect(byId.statusCode).toBe(200);
    const item = byId.json() as {
      id: string;
      name: string;
      type: string;
      mediaSources: Array<{ id: string; audioTracks: unknown[]; subtitleTracks: unknown[] }>;
    };
    expect(item.id).toBe(MOVIE_ID);
    expect(item.type).toBe('Movie');
    // This is the real-Jellyfin compatibility check: MediaSources must be
    // requested with Fields=MediaSources or Jellyfin returns an empty list.
    expect(item.mediaSources.length).toBe(1);
    expect(item.mediaSources[0]!.audioTracks.length).toBe(1);
    expect(item.mediaSources[0]!.subtitleTracks.length).toBe(2);

    const byUrl = await stack.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: {
        input: `${stack.mock.origin}${stack.mock.base}/web/index.html#/details?id=${MOVIE_ID}`,
      },
    });
    expect(byUrl.statusCode).toBe(200);
    expect((byUrl.json() as { id: string }).id).toBe(MOVIE_ID);
  });

  it('rejects a resolve URL pointing at another origin', async () => {
    stack = await startStack();
    const res = await stack.app.inject({
      method: 'POST',
      url: '/api/resolve',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { input: 'https://evil.example/web/index.html#/details?id=' + MOVIE_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'untrusted_origin' } });
  });

  it('validates /api/items/:id and maps episodes', async () => {
    stack = await startStack();
    const bad = await stack.app.inject({
      method: 'GET',
      url: '/api/items/not-an-id',
      headers: stack.authHeaders,
    });
    expect(bad.statusCode).toBe(400);

    const ep = await stack.app.inject({
      method: 'GET',
      url: `/api/items/${EPISODE_ID}`,
      headers: stack.authHeaders,
    });
    expect(ep.statusCode).toBe(200);
    expect(ep.json()).toMatchObject({
      type: 'Episode',
      seriesName: 'Verification Show',
      seasonNumber: 1,
      episodeNumber: 1,
    });
  });

  it('paginates the library with total counts and validates limits', async () => {
    stack = await startStack();
    const first = await stack.app.inject({
      method: 'GET',
      url: '/api/library?query=&startIndex=0&limit=2',
      headers: stack.authHeaders,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json() as { items: unknown[]; total: number };
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBeGreaterThan(2);

    const second = await stack.app.inject({
      method: 'GET',
      url: `/api/library?query=&startIndex=2&limit=2`,
      headers: stack.authHeaders,
    });
    const page2 = second.json() as { items: Array<{ id: string }> };
    const ids1 = (page1.items as Array<{ id: string }>).map((i) => i.id);
    const ids2 = page2.items.map((i) => i.id);
    expect(ids2).not.toEqual(ids1);

    const badLimit = await stack.app.inject({
      method: 'GET',
      url: '/api/library?limit=1000',
      headers: stack.authHeaders,
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json()).toMatchObject({ error: { code: 'invalid_query' } });
  });

  it('rejects link creation with unknown source/track and out-of-range start', async () => {
    stack = await startStack();
    const base = {
      itemId: MOVIE_ID,
      mediaSourceId: MOVIE_ID,
      subtitleStreamIndex: -1,
      preset: '1080p',
      startSeconds: 0,
      expiresInHours: 24,
    };

    const unknownSource = await stack.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { ...base, mediaSourceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknownSource.statusCode).toBe(422);
    expect(unknownSource.json()).toMatchObject({ error: { code: 'unknown_media_source' } });

    const unknownAudio = await stack.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { ...base, audioStreamIndex: 99 },
    });
    expect(unknownAudio.statusCode).toBe(422);
    expect(unknownAudio.json()).toMatchObject({ error: { code: 'unknown_audio_track' } });

    const unknownSubtitle = await stack.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { ...base, subtitleStreamIndex: 99 },
    });
    expect(unknownSubtitle.statusCode).toBe(422);
    expect(unknownSubtitle.json()).toMatchObject({ error: { code: 'unknown_subtitle_track' } });

    const tooLong = await stack.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { ...base, expiresInHours: 1000 },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { code: 'expiry_too_long' } });

    const beyondEnd = await stack.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...stack.authHeaders, 'content-type': 'application/json' },
      payload: { ...base, startSeconds: 999999 },
    });
    expect(beyondEnd.statusCode).toBe(400);
    expect(beyondEnd.json()).toMatchObject({ error: { code: 'start_out_of_range' } });
  });

  it('lists and revokes links without reproducing tokens', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const list = await stack.app.inject({
      method: 'GET',
      url: '/api/links',
      headers: stack.authHeaders,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { links: Array<Record<string, unknown>> };
    expect(body.links.some((l) => l.id === link.id)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(link.token);
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);

    const revoke = await stack.app.inject({
      method: 'DELETE',
      url: `/api/links/${link.id}`,
      headers: stack.authHeaders,
    });
    expect(revoke.statusCode).toBe(204);
    const again = await stack.app.inject({
      method: 'DELETE',
      url: `/api/links/${link.id}`,
      headers: stack.authHeaders,
    });
    expect(again.statusCode).toBe(204);
  });

  it('returns JSON 404 (not SPA) for unknown /api routes', async () => {
    stack = await startStack();
    const res = await stack.app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: stack.authHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
