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

describe('HLS manifest rewriting', () => {
  it('recursively rewrites master, variant and segment URIs onto our origin', async () => {
    stack = await startStack({ mock: { includeTrickplay: false, includeSubtitleRenditions: false } });
    const link = await createLink(stack.app, stack.authHeaders);

    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    const masterUris = urisOf(master.body);
    expect(masterUris.length).toBeGreaterThan(0);
    for (const uri of masterUris) {
      expect(uri.startsWith('/s/')).toBe(true);
    }

    const variant = await stack.app.inject({ method: 'GET', url: masterUris[0]! });
    expect(variant.statusCode).toBe(200);
    expect(variant.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    const variantUris = urisOf(variant.body);
    expect(variantUris.length).toBeGreaterThan(0);
    for (const uri of variantUris) {
      expect(uri.startsWith('/s/')).toBe(true);
      expect(uri).toContain('runtimeTicks=');
      expect(uri).toContain('actualSegmentLengthTicks=');
      expect(uri.endsWith('.ts') || uri.includes('.ts?')).toBe(true);
    }

    const segment = await stack.app.inject({ method: 'GET', url: variantUris[0]! });
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['content-type']).toContain('video/mp2t');
    expect(segment.rawPayload.length).toBe(1024);
  });

  it('preserves HLS tags, ordering and timing while rewriting', async () => {
    stack = await startStack({ mock: { includeTrickplay: false, includeSubtitleRenditions: false } });
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    const variantPath = urisOf(master.body)[0]!;
    const variant = await stack.app.inject({ method: 'GET', url: variantPath });
    for (const tag of [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:6.000,',
      '#EXT-X-ENDLIST',
    ]) {
      expect(variant.body).toContain(tag);
    }
  });

  it('keeps credential-bearing upstream URIs (trickplay/subtitles) off the client', async () => {
    stack = await startStack({ mock: { includeTrickplay: true, includeSubtitleRenditions: true } });
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    expect(master.body).not.toContain('ApiKey');
    expect(master.body).not.toContain('subtitles.m3u8?SegmentLength');
    // The subtitle group is gone, so no dangling SUBTITLES="subs" reference.
    expect(master.body).not.toContain('SUBTITLES=');
    for (const uri of urisOf(master.body)) {
      expect(uri.startsWith('/s/')).toBe(true);
    }
    // Trickplay must be disabled on the upstream request so it is not emitted.
    expect(stack.mock.last('/master.m3u8')!.query.get('enableTrickplay')).toBe('false');
  });

  it('prefixes rewritten resource URIs when PUBLIC_BASE_URL has a sub-path', async () => {
    stack = await startStack({ env: { PUBLIC_BASE_URL: 'https://gateway.example/jfvrc' } });
    const link = await createLink(stack.app, stack.authHeaders);
    expect(link.url.startsWith('https://gateway.example/jfvrc/s/')).toBe(true);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    const uris = urisOf(master.body);
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) {
      expect(uri.startsWith('/jfvrc/s/')).toBe(true);
    }
  });

  it('does not require credentials for any rewritable resource', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    // No cookie/authorization is needed by the player.
    for (const uri of urisOf(master.body)) {
      const res = await stack.app.inject({ method: 'GET', url: uri });
      expect(res.statusCode).toBe(200);
    }
  });
});
