import { describe, expect, it } from 'vitest';
import { JellyfinClient, type NegotiateInput } from '../../src/server/jellyfin';
import { loadConfig, type AppConfig } from '../../src/server/config';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const MEDIA_SOURCE_ID = 'src-main';

const BASE_CONFIG = loadConfig({
  JELLYFIN_URL: 'https://jf.example',
  JELLYFIN_API_KEY: 'k',
  JELLYFIN_USER_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ADMIN_TOKEN: 't',
  PUBLIC_BASE_URL: 'https://gateway.test',
});

function makeConfig(upstreamTimeoutMs = 5_000): AppConfig {
  return { ...BASE_CONFIG, upstreamTimeoutMs };
}

const NEGOTIATE_INPUT: NegotiateInput = {
  itemId: ITEM_ID,
  mediaSourceId: MEDIA_SOURCE_ID,
  audioStreamIndex: null,
  subtitleStreamIndex: -1,
  preset: '1080p',
  startSeconds: 0,
  deviceId: 'device-1',
};

function asFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

/** A fetch that never resolves until the request signal is aborted. */
function hangingFetch(onInit?: (init?: RequestInit) => void): typeof fetch {
  return asFetch((_url, init) => {
    onInit?.(init);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface TrackedBody {
  body: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
}

/** A body stream that records whether it was cancelled. */
function trackedBody(chunks: Uint8Array[] = []): TrackedBody {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (chunks.length === 0) {
        // Leave the stream open so it only ends via cancellation.
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
}

describe('JellyfinClient upstream deadlines', () => {
  it('times out while waiting for response headers', async () => {
    const client = new JellyfinClient(makeConfig(25), hangingFetch());
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({
      name: 'AppError',
      code: 'upstream_unavailable',
    });
  });

  it('keeps the deadline armed while reading a slow response body', async () => {
    const fetchImpl = asFetch((_url, init) => {
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              } catch {
                // already closed
              }
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    const client = new JellyfinClient(makeConfig(25), fetchImpl);
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('cancels negotiation when the caller signal aborts before the deadline', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    const client = new JellyfinClient(makeConfig(60_000), hangingFetch((init) => {
      observed = init?.signal;
    }));

    const pending = client.negotiatePlayback({ ...NEGOTIATE_INPUT, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(observed?.aborted).toBe(true);
  });

  it('uses the configured deadline even when a caller signal is supplied', async () => {
    const controller = new AbortController();
    const client = new JellyfinClient(makeConfig(25), hangingFetch());
    await expect(
      client.negotiatePlayback({ ...NEGOTIATE_INPUT, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('JellyfinClient response cleanup', () => {
  it('cancels a redirect body rejected for an untrusted origin', async () => {
    const tracked = trackedBody([new Uint8Array([1, 2, 3])]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() =>
        Promise.resolve(
          new Response(tracked.body, {
            status: 302,
            headers: { location: 'https://evil.example/master.m3u8' },
          }),
        ),
      ),
    );
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({ code: 'untrusted_origin' });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('cancels a redirect body when no location is present', async () => {
    const tracked = trackedBody([new Uint8Array([1, 2, 3])]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() => Promise.resolve(new Response(tracked.body, { status: 302 }))),
    );
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('cancels a non-success metadata response body', async () => {
    const tracked = trackedBody([new Uint8Array([1, 2, 3])]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() => Promise.resolve(new Response(tracked.body, { status: 500 }))),
    );
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('cancels a non-success negotiation response body', async () => {
    const tracked = trackedBody([new Uint8Array([1, 2, 3])]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() => Promise.resolve(new Response(tracked.body, { status: 502 }))),
    );
    await expect(client.negotiatePlayback(NEGOTIATE_INPUT)).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('cancels the stop-encoding response and remains best effort', async () => {
    const tracked = trackedBody([new Uint8Array([1, 2, 3])]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() => Promise.resolve(new Response(tracked.body, { status: 200 }))),
    );
    await expect(client.stopEncoding('device-1', 'ps-1')).resolves.toBeUndefined();
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('swallows a stop-encoding timeout without throwing', async () => {
    const client = new JellyfinClient(makeConfig(20), hangingFetch());
    await expect(client.stopEncoding('device-1', 'ps-1')).resolves.toBeUndefined();
  });
});

describe('JellyfinClient bounded JSON bodies', () => {
  it('rejects oversized metadata JSON while streaming', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    const tracked = trackedBody([oversized]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() =>
        Promise.resolve(
          new Response(tracked.body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    await expect(client.getItem(ITEM_ID)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('rejects oversized negotiation JSON while streaming', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    const tracked = trackedBody([oversized]);
    const client = new JellyfinClient(
      makeConfig(),
      asFetch(() =>
        Promise.resolve(
          new Response(tracked.body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    await expect(client.negotiatePlayback(NEGOTIATE_INPUT)).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
    expect(tracked.wasCancelled()).toBe(true);
  });

  it('still parses normal metadata and negotiation responses', async () => {
    const client = new JellyfinClient(
      makeConfig(),
      asFetch((url) => {
        if (url.includes('/PlaybackInfo')) {
          return Promise.resolve(
            jsonResponse({
              MediaSources: [
                {
                  Id: MEDIA_SOURCE_ID,
                  SupportsTranscoding: true,
                  TranscodingUrl: `/Videos/${ITEM_ID}/master.m3u8?MediaSourceId=${MEDIA_SOURCE_ID}`,
                },
              ],
              PlaySessionId: 'ps-1',
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            Id: ITEM_ID,
            Name: 'Mock Movie',
            Type: 'Movie',
            MediaSources: [{ Id: MEDIA_SOURCE_ID, Name: 'Main' }],
          }),
        );
      }),
    );

    const item = await client.getItem(ITEM_ID);
    expect(item.name).toBe('Mock Movie');

    const negotiation = await client.negotiatePlayback(NEGOTIATE_INPUT);
    expect(negotiation.playSessionId).toBe('ps-1');
    expect(negotiation.mediaSourceId).toBe(MEDIA_SOURCE_ID);
    expect(negotiation.transcodeUrl).toContain('allowVideoStreamCopy=false');
    expect(negotiation.transcodeUrl).not.toContain('api_key');
  });
});
