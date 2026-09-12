import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackManager } from '../../src/server/playback';
import { LinkStore, type LinkRecord, type NewLink } from '../../src/server/store';
import { loadConfig, type AppConfig } from '../../src/server/config';
import type {
  JellyfinClient,
  NegotiateInput,
  PlaybackNegotiation,
  UpstreamFetchOptions,
} from '../../src/server/jellyfin';
import type { MediaItem } from '../../src/shared/contracts';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const MEDIA_SOURCE_ID = 'src-main';
const MASTER_URL = `https://jf.example/Videos/${ITEM_ID}/master.m3u8`;
const PLAY_SESSION_ID = 'ps-1';
const DEVICE_ID = 'dev-1';

const BASE_ENV: NodeJS.ProcessEnv = {
  JELLYFIN_URL: 'https://jf.example',
  JELLYFIN_API_KEY: 'test-key',
  JELLYFIN_USER_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ADMIN_TOKEN: 'test-admin',
  PUBLIC_BASE_URL: 'https://gateway.test',
};

function makeConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function negotiation(): PlaybackNegotiation {
  return {
    transcodeUrl: MASTER_URL,
    playSessionId: PLAY_SESSION_ID,
    deviceId: DEVICE_ID,
    mediaSourceId: MEDIA_SOURCE_ID,
    itemId: ITEM_ID,
  };
}

/** Resolvable barrier used to hold negotiations open until released. */
class Gate {
  private resolvers: Array<() => void> = [];

  wait(): Promise<void> {
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  open(): void {
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

interface StopRecord {
  deviceId: string;
  playSessionId: string;
}

/** Minimal structural stand-in for JellyfinClient; no network access. */
class FakeJellyfin {
  readonly negotiateInputs: NegotiateInput[] = [];
  readonly stopped: StopRecord[] = [];
  negotiateImpl: (input: NegotiateInput) => Promise<PlaybackNegotiation> = async () =>
    negotiation();
  resourceImpl: (url: string, options: UpstreamFetchOptions) => Promise<Response> = async () => {
    throw new Error('resourceImpl was not configured for this test');
  };
  stopImpl: ((deviceId: string, playSessionId: string) => Promise<void>) | null = null;

  negotiatePlayback(input: NegotiateInput): Promise<PlaybackNegotiation> {
    this.negotiateInputs.push(input);
    return this.negotiateImpl(input);
  }

  fetchResource(url: string, options: UpstreamFetchOptions = {}): Promise<Response> {
    return this.resourceImpl(url, options);
  }

  stopEncoding(deviceId: string, playSessionId: string): Promise<void> {
    this.stopped.push({ deviceId, playSessionId });
    return this.stopImpl ? this.stopImpl(deviceId, playSessionId) : Promise.resolve();
  }
}

interface Harness {
  manager: PlaybackManager;
  store: LinkStore;
  fake: FakeJellyfin;
}

const cleanups: Array<() => Promise<void> | void> = [];

function makeHarness(overrides: NodeJS.ProcessEnv = {}): Harness {
  const store = new LinkStore(':memory:');
  const fake = new FakeJellyfin();
  const manager = new PlaybackManager(
    makeConfig(overrides),
    store,
    fake as unknown as JellyfinClient,
  );
  cleanups.push(async () => {
    await manager.shutdown();
    store.close();
  });
  return { manager, store, fake };
}

function makeLink(
  store: LinkStore,
  overrides: Partial<NewLink> = {},
): { record: LinkRecord; token: string } {
  const item: MediaItem = { id: ITEM_ID, name: 'Mock Movie', type: 'Movie' };
  return store.createLink({
    item,
    mediaSourceId: MEDIA_SOURCE_ID,
    audioStreamIndex: null,
    subtitleStreamIndex: -1,
    preset: '1080p',
    startSeconds: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

/** A rejection-style negotiation that only settles when its signal aborts. */
function hangingNegotiation(input: NegotiateInput): Promise<PlaybackNegotiation> {
  return new Promise((_resolve, reject) => {
    const signal = input.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function manifestResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl' },
  });
}

afterEach(async () => {
  vi.useRealTimers();
  const pending = cleanups.splice(0).reverse();
  for (const cleanup of pending) await cleanup();
});

describe('PlaybackManager capacity accounting', () => {
  it('reserves capacity for pending negotiations on different links', async () => {
    const { manager, store, fake } = makeHarness({ MAX_ACTIVE_SESSIONS: '2' });
    const gate = new Gate();
    fake.negotiateImpl = async () => {
      await gate.wait();
      return negotiation();
    };

    const a = makeLink(store);
    const b = makeLink(store);
    const c = makeLink(store);

    const pa = manager.createSession(a.record, a.token);
    const pb = manager.createSession(b.record, b.token);
    const pc = manager.createSession(c.record, c.token);

    await expect(pc).rejects.toMatchObject({ statusCode: 503, code: 'too_many_sessions' });
    expect(fake.negotiateInputs).toHaveLength(2);

    gate.open();
    const [sa, sb] = await Promise.all([pa, pb]);
    expect(sa).not.toBe(sb);
    expect(manager.activeSessionCount).toBe(2);
  });
});

describe('PlaybackManager same-link coalescing', () => {
  it('coalesces concurrent negotiations for the same link', async () => {
    const { manager, store, fake } = makeHarness();
    const gate = new Gate();
    fake.negotiateImpl = async () => {
      await gate.wait();
      return negotiation();
    };

    const link = makeLink(store);
    const p1 = manager.createSession(link.record, link.token);
    const p2 = manager.createSession(link.record, link.token);

    // Let the coalesced negotiation reach the upstream call before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.open();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
    expect(fake.negotiateInputs).toHaveLength(1);
    expect(manager.activeSessionCount).toBe(1);
  });

  it('does not cancel the shared negotiation when one waiter aborts', async () => {
    const { manager, store, fake } = makeHarness();
    const gate = new Gate();
    fake.negotiateImpl = async () => {
      await gate.wait();
      return negotiation();
    };

    const link = makeLink(store);
    const controller = new AbortController();
    const p1 = manager.createSession(link.record, link.token, controller.signal);
    const p2 = manager.createSession(link.record, link.token);

    const rejected = expect(p1).rejects.toBeDefined();
    controller.abort();
    await rejected;

    expect(fake.negotiateInputs[0]?.signal?.aborted).toBe(false);

    gate.open();
    const session = await p2;
    expect(session.id).toBeTruthy();
  });

  it('cancels the negotiation once every waiter aborts', async () => {
    const { manager, store, fake } = makeHarness();
    fake.negotiateImpl = hangingNegotiation;

    const link = makeLink(store);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = manager.createSession(link.record, link.token, c1.signal);
    const p2 = manager.createSession(link.record, link.token, c2.signal);

    const r1 = expect(p1).rejects.toBeDefined();
    const r2 = expect(p2).rejects.toBeDefined();

    // Let the negotiation reach the upstream call before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.negotiateInputs).toHaveLength(1);

    c1.abort();
    c2.abort();
    await r1;
    await r2;

    expect(fake.negotiateInputs[0]?.signal?.aborted).toBe(true);
  });
});

describe('PlaybackManager revocation and shutdown', () => {
  it('rejects a revoked link and stops the late negotiated encoding', async () => {
    const { manager, store, fake } = makeHarness();
    const gate = new Gate();
    fake.negotiateImpl = async () => {
      await gate.wait();
      return negotiation();
    };

    const link = makeLink(store);
    const pending = manager.createSession(link.record, link.token);
    const rejected = expect(pending).rejects.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.negotiateInputs).toHaveLength(1);

    store.revoke(link.record.id);
    manager.closeSessionsForLink(link.record.id);

    // Negotiation completes after revocation; it must be stopped, not adopted.
    gate.open();
    await rejected;

    expect(fake.stopped).toContainEqual({
      deviceId: DEVICE_ID,
      playSessionId: PLAY_SESSION_ID,
    });
    expect(manager.activeSessionCount).toBe(0);
  });

  it('cancels pending negotiations and waits for encoding cleanup on shutdown', async () => {
    const { manager, store, fake } = makeHarness();

    const active = makeLink(store);
    await manager.createSession(active.record, active.token);

    const stopGate = new Gate();
    fake.stopImpl = () => stopGate.wait();

    fake.negotiateImpl = hangingNegotiation;
    const queued = makeLink(store);
    const pending = manager.createSession(queued.record, queued.token);
    const rejected = expect(pending).rejects.toBeDefined();

    let resolved = false;
    const closing = manager.shutdown().then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);

    stopGate.open();
    await closing;
    await rejected;

    expect(resolved).toBe(true);
    expect(fake.stopped).toContainEqual({
      deviceId: DEVICE_ID,
      playSessionId: PLAY_SESSION_ID,
    });
    expect(manager.activeSessionCount).toBe(0);
  });
});

describe('PlaybackManager session expiry', () => {
  it('aborts an in-flight transfer when the session expires', async () => {
    vi.useFakeTimers();
    try {
      const { manager, store, fake } = makeHarness();
      const link = makeLink(store, {
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });
      const session = await manager.createSession(link.record, link.token);

      fake.resourceImpl = (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options.signal;
          const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });

      const transfer = manager.openBinary(
        session,
        `https://jf.example/Videos/${ITEM_ID}/seg.ts`,
        {},
      );
      const rejected = expect(transfer).rejects.toMatchObject({ code: 'upstream_unavailable' });

      await vi.advanceTimersByTimeAsync(1100);
      await rejected;
      expect(manager.activeSessionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PlaybackManager manifest scale', () => {
  it('rewrites a long VOD playlist with more than 4096 segments', async () => {
    const { manager, store, fake } = makeHarness();
    const link = makeLink(store);
    const session = await manager.createSession(link.record, link.token);

    const segmentCount = 5000;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push('#EXTINF:6.0,', `seg${String(i).padStart(5, '0')}.ts`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    fake.resourceImpl = async () => manifestResponse(lines.join('\n'));

    const text = await manager.fetchManifest(session, session.masterUrl);
    expect(text).toContain('#EXT-X-ENDLIST');
    expect(text).toContain('/s/');
    expect(session.resources.size).toBe(segmentCount);
    expect(session.counter).toBe(segmentCount);
  });

  it('cancels an oversized chunked manifest during reading without content-length', async () => {
    const { manager, store, fake } = makeHarness();
    const link = makeLink(store);
    const session = await manager.createSession(link.record, link.token);

    let cancelled = false;
    let emitted = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x23);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 100) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    fake.resourceImpl = async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });

    await expect(manager.fetchManifest(session, session.masterUrl)).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
    expect(cancelled).toBe(true);
    // 5 MiB cap at 64 KiB per chunk stops well before the 100th chunk.
    expect(emitted).toBeLessThan(100);
  });
});
