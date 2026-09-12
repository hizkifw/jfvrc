import { afterEach, describe, expect, it } from 'vitest';
import { createLink, startStack, type Stack } from './support/harness';

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

function urisOf(manifest: string): string[] {
  const uris: string[] = [];
  for (const line of manifest.split('\n')) {
    const attr = /URI="([^"]+)"/.exec(line);
    if (attr) uris.push(attr[1]!);
    else if (line.trim() && !line.trimStart().startsWith('#')) uris.push(line.trim());
  }
  return uris;
}

async function listen(stack: Stack): Promise<string> {
  await stack.app.listen({ port: 0, host: '127.0.0.1' });
  const address = stack.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

async function segmentPath(stack: Stack, index: number): Promise<string> {
  const link = await createLink(stack.app, stack.authHeaders);
  const master = await stack.app.inject({ method: 'GET', url: link.path });
  const variant = await stack.app.inject({ method: 'GET', url: urisOf(master.body)[0]! });
  const segments = urisOf(variant.body).filter((u) => /\.ts/.test(u));
  return segments[index]!;
}

describe('streaming, HEAD, ranges and aborts', () => {
  it('HEAD on the entry link does not negotiate or start a transcode', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const head = await stack.app.inject({ method: 'HEAD', url: link.path });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(head.body).toBe('');
    expect(stack.mock.find('/PlaybackInfo').length).toBe(0);
  });

  it('HEAD on a resource returns metadata without a body', async () => {
    stack = await startStack();
    const seg = await segmentPath(stack, 0);
    const head = await stack.app.inject({ method: 'HEAD', url: seg });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toContain('video/mp2t');
    expect(head.body).toBe('');
  });

  it('answers media preflight with permissive CORS for players', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const res = await stack.app.inject({
      method: 'OPTIONS',
      url: link.path,
      headers: {
        origin: 'https://player.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-allow-methods'])).toContain('GET');
  });

  it('passes through Range requests as 206 with content-range', async () => {
    stack = await startStack();
    const base = await listen(stack);
    const seg = await segmentPath(stack, 0);
    const res = await fetch(`${base}${seg}`, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1024');
    expect(res.headers.get('content-length')).toBe('100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
  });

  it('returns 416 for an unsatisfiable range', async () => {
    stack = await startStack();
    const base = await listen(stack);
    const seg = await segmentPath(stack, 0);
    const res = await fetch(`${base}${seg}`, { headers: { Range: 'bytes=999999-1000000' } });
    expect(res.status).toBe(416);
  });

  it('aborts the upstream transfer when the player disconnects', async () => {
    stack = await startStack({ mock: { hangSegments: [0] } });
    const base = await listen(stack);
    const seg = await segmentPath(stack, 0);

    const controller = new AbortController();
    const response = await fetch(`${base}${seg}`, { signal: controller.signal });
    expect(response.status).toBe(200);
    // Headers arrive before the body: aborting now must error the body stream
    // (not buffer the whole segment), which is the point of streaming.
    const bodyRead = response.arrayBuffer();
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await expect(bodyRead).rejects.toBeTruthy();

    // The service must remain healthy after the abort.
    const health = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const after = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(after.statusCode).toBe(200);
  });

  it('reports missing segments as an upstream failure without crashing', async () => {
    stack = await startStack({ mock: { missingSegments: [1] } });
    const base = await listen(stack);
    const seg = await segmentPath(stack, 1);
    const res = await fetch(`${base}${seg}`);
    expect([404, 502]).toContain(res.status);
    const health = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });
});
