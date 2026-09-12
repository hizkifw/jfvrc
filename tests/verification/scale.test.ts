import { afterEach, describe, expect, it } from 'vitest';
import { createLink, startStack, type Stack } from './support/harness';

let stack: Stack | undefined;
afterEach(async () => { await stack?.close(); stack = undefined; });
const uri = (text: string) => text.split('\n').find((line) => line.startsWith('/s/'))!;
async function setup(options: Parameters<typeof startStack>[0] = {}) {
  stack = await startStack(options);
  const link = await createLink(stack.app, stack.authHeaders);
  const master = await stack.app.inject({ method: 'GET', url: link.path });
  const variantPath = uri(master.body);
  const variant = await stack.app.inject({ method: 'GET', url: variantPath });
  return { link, segment: uri(variant.body), variantPath };
}
async function listen() {
  await stack!.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = stack!.app.server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('group playback over HTTP', () => {
  it('serves 40 same-link viewers with one upstream request per playlist and segment', async () => {
    const { link, segment, variantPath } = await setup();
    for (const path of [link.path, variantPath, segment]) {
      const responses = await Promise.all(Array.from({ length: 40 }, () => stack!.app.inject({ method: 'GET', url: path })));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(new Set(responses.map((r) => r.body)).size).toBe(1);
      expect(responses[0]!.headers['cache-control']).toBe('no-store');
    }
    expect(stack!.mock.find('/PlaybackInfo')).toHaveLength(1);
    expect(stack!.mock.find('/master.m3u8')).toHaveLength(1);
    expect(stack!.mock.find('/main.m3u8')).toHaveLength(1);
    expect(stack!.mock.find('/0.ts')).toHaveLength(1);
    const revoked = await stack!.app.inject({ method: 'DELETE', url: `/api/links/${link.id}`, headers: stack!.authHeaders });
    expect(revoked.statusCode).toBe(204);
    for (const path of [link.path, variantPath, segment]) {
      expect((await stack!.app.inject({ method: 'GET', url: path })).statusCode).toBe(410);
    }
  });

  it('keeps full responses and byte ranges separate in the shared cache', async () => {
    const { segment } = await setup();
    const [first, second, full] = await Promise.all([
      stack!.app.inject({ method: 'GET', url: segment, headers: { range: 'bytes=0-99' } }),
      stack!.app.inject({ method: 'GET', url: segment, headers: { range: 'bytes=100-199' } }),
      stack!.app.inject({ method: 'GET', url: segment }),
    ]);
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe('bytes 0-99/1024');
    expect(second.headers['content-range']).toBe('bytes 100-199/1024');
    expect([...second.rawPayload]).toEqual([...Buffer.from(Array.from({ length: 100 }, (_, i) => i + 100))]);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(1024);
    const repeat = await stack!.app.inject({ method: 'GET', url: segment, headers: { range: 'bytes=0-99' } });
    expect(repeat.rawPayload).toEqual(first.rawPayload);
    expect(stack!.mock.find('/0.ts')).toHaveLength(3);
  });

  it('rejects excess viewers promptly, keeps health available and recovers after disconnect', async () => {
    const { link, segment } = await setup({ env: { MAX_MEDIA_REQUESTS: '2' }, mock: { hangSegments: [0] } });
    const base = await listen();
    const a = new AbortController(), b = new AbortController();
    const [first, second] = await Promise.all([
      fetch(base + segment, { signal: a.signal }), fetch(base + segment, { signal: b.signal }),
    ]);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    const excess = await fetch(base + segment);
    expect(excess.status).toBe(503);
    expect(excess.headers.get('retry-after')).toBe('2');
    await excess.arrayBuffer();
    expect(await fetch(base + '/health').then((r) => r.json())).toEqual({ status: 'ok' });
    a.abort(); b.abort();
    await new Promise((r) => setTimeout(r, 50));
    const recovered = await fetch(base + link.path);
    expect(recovered.status).toBe(200);
    await recovered.text();
  });

  it('delivers delayed chunks through EOF and caches the complete segment', async () => {
    const { segment } = await setup({ env: { UPSTREAM_TIMEOUT_SECONDS: '10' }, mock: { hangSegments: [0] } });
    const base = await listen();
    const response = await fetch(base + segment);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
    const cached = await fetch(base + segment);
    expect((await cached.arrayBuffer()).byteLength).toBe(1024);
    expect(stack!.mock.find('/0.ts')).toHaveLength(1);
  });

  it('ends a stalled viewer at the overall request deadline', async () => {
    const { segment } = await setup({ env: { MEDIA_REQUEST_TIMEOUT_SECONDS: '1' }, mock: { hangSegments: [0] } });
    const base = await listen();
    const response = await fetch(base + segment);
    await expect(response.arrayBuffer()).rejects.toBeTruthy();
    expect((await stack!.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('shutdown finishes even with a stalled active media response', async () => {
    const { segment } = await setup({ mock: { hangSegments: [0] } });
    const base = await listen();
    const response = await fetch(base + segment);
    const body = response.arrayBuffer().catch(() => null);
    await stack!.app.close();
    expect(await body).toBeNull();
  });
});
