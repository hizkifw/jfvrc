import { describe, expect, it, vi } from 'vitest';
import { MediaCache } from '../../src/server/media-cache';

const block = 64 * 1024;
function cache(overrides = {}) {
  return new MediaCache({ maxBytes: block * 4, maxResourceBytes: block * 2, maxFetches: 2, timeoutMs: 1000, ttlMs: 60_000, ...overrides });
}
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
  return { controller, cancel, response: new Response(body, { headers: { 'content-type': 'video/mp2t' } }) };
}
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((r) => setImmediate(r));
async function bytes(body: ReadableStream<Uint8Array>) { return [...new Uint8Array(await new Response(body).arrayBuffer())]; }

describe('bounded shared media transfers', () => {
  it('streams before EOF, shares one upstream, and replays from the beginning for slow readers and cache hits', async () => {
    const store = cache();
    const upstream = source();
    const fetcher = vi.fn(async () => upstream.response);
    const [first, slow] = await Promise.all([store.open('s', 'key', fetcher, signal()), store.open('s', 'key', fetcher, signal())]);
    const reader = first.body.getReader();
    upstream.controller.enqueue(new Uint8Array([1, 2, 3]));
    expect([...(await reader.read()).value!]).toEqual([1, 2, 3]);
    upstream.controller.enqueue(new Uint8Array([4, 5]));
    upstream.controller.close();
    expect([...(await reader.read()).value!]).toEqual([4, 5]);
    expect((await reader.read()).done).toBe(true);
    expect(await bytes(slow.body)).toEqual([1, 2, 3, 4, 5]);
    const hit = await store.open('s', 'key', fetcher, signal());
    expect(await bytes(hit.body)).toEqual([1, 2, 3, 4, 5]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('one disconnect leaves other viewers running; the last disconnect cancels upstream', async () => {
    const store = cache();
    const upstream = source();
    const fetcher = vi.fn(async () => upstream.response);
    const a = new AbortController(), b = new AbortController();
    const [first, second] = await Promise.all([store.open('s', 'key', fetcher, a.signal), store.open('s', 'key', fetcher, b.signal)]);
    a.abort();
    await expect(first.body.getReader().read()).rejects.toBeTruthy();
    expect(upstream.cancel).not.toHaveBeenCalled();
    upstream.controller.enqueue(new Uint8Array([7]));
    const reader = second.body.getReader();
    expect([...(await reader.read()).value!]).toEqual([7]);
    b.abort();
    await expect(reader.read()).rejects.toBeTruthy();
    await tick();
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it('reserves memory before fetching and refuses new work while slow readers pin buffers', async () => {
    const store = cache({ maxBytes: block * 2 });
    const first = await store.open('s', 'a', async () => new Response(new Uint8Array(block * 2)), signal());
    await tick();
    const fetcher = vi.fn(async () => new Response('b'));
    await expect(store.open('s', 'b', fetcher, signal())).rejects.toMatchObject({ code: 'media_capacity' });
    expect(fetcher).not.toHaveBeenCalled();
    await bytes(first.body);
    const second = await store.open('s', 'b', fetcher, signal());
    expect(await bytes(second.body)).toEqual([98]);
  });

  it('enforces upstream concurrency without blocking subscribers of the same transfer', async () => {
    const store = cache({ maxFetches: 1 });
    const upstream = source();
    const fetcher = vi.fn(async () => upstream.response);
    const first = await store.open('s', 'a', fetcher, signal());
    const second = await store.open('s', 'a', fetcher, signal());
    await expect(store.open('s', 'b', fetcher, signal())).rejects.toMatchObject({ code: 'media_capacity' });
    first.release(); second.release(); await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps aborted transfers charged until upstream cancellation has completed', async () => {
    const store = cache({ maxBytes: block * 2 });
    let finishCancel!: () => void;
    const cancelling = new Promise<void>((resolve) => { finishCancel = resolve; });
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { return cancelling; } }));
    const controller = new AbortController();
    const first = await store.open('s', 'a', async () => upstream, controller.signal);
    controller.abort();
    await expect(first.body.getReader().read()).rejects.toBeTruthy();
    // A retry must not remove the reservation while the old pump can still finish.
    const fetcher = vi.fn(async () => new Response('next'));
    await expect(store.open('s', 'a', fetcher, signal())).rejects.toMatchObject({ code: 'media_capacity' });
    await expect(store.open('s', 'b', fetcher, signal())).rejects.toMatchObject({ code: 'media_capacity' });
    expect(fetcher).not.toHaveBeenCalled();
    finishCancel();
    await tick();
    const second = await store.open('s', 'a', async () => new Response(new Uint8Array(block * 2)), signal());
    await tick();
    await expect(store.open('s', 'b', fetcher, signal())).rejects.toMatchObject({ code: 'media_capacity' });
    await bytes(second.body);
  });

  it('cancels oversized bodies during consumption and does not cache partial results', async () => {
    const store = cache();
    const upstream = source();
    const result = await store.open('s', 'a', async () => upstream.response, signal());
    upstream.controller.enqueue(new Uint8Array(block * 2 + 1));
    await expect(bytes(result.body)).rejects.toBeTruthy();
    await tick();
    expect(upstream.cancel).toHaveBeenCalled();
    const retry = await store.open('s', 'a', async () => new Response('ok'), signal());
    expect(await bytes(retry.body)).toEqual([111, 107]);
  });

  it('cancels rejected HTTP and oversized declared bodies', async () => {
    for (const response of [new Response(new ReadableStream(), { status: 500 }), new Response(new ReadableStream(), { headers: { 'content-length': String(block * 3) } })]) {
      const cancel = vi.spyOn(response.body!, 'cancel');
      await expect(cache().open('s', 'a', async () => response, signal())).rejects.toBeTruthy();
      expect(cancel).toHaveBeenCalled();
    }
  });

  it('times out an upstream body that stalls after headers and releases its reservation', async () => {
    vi.useFakeTimers();
    try {
      const store = cache({ maxBytes: block * 2 });
      const upstream = source();
      const result = await store.open('s', 'a', async () => upstream.response, signal());
      const failed = expect(bytes(result.body)).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(1001);
      await failed;
      expect(upstream.cancel).toHaveBeenCalled();
      const next = await store.open('s', 'b', async () => new Response('ok'), signal());
      expect(await bytes(next.body)).toEqual([111, 107]);
    } finally { vi.useRealTimers(); }
  });

  it('invalidates cached bytes and active readers on session termination', async () => {
    const store = cache();
    const active = await store.open('s', 'a', async () => new Response('secret'), signal());
    await tick();
    store.invalidate('s');
    await expect(bytes(active.body)).rejects.toBeTruthy();
    const fetcher = vi.fn(async () => new Response('new'));
    const next = await store.open('s', 'a', fetcher, signal());
    expect(await bytes(next.body)).toEqual([110, 101, 119]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
