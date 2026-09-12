import { describe, expect, it } from 'vitest';
import type { JellyfinConfig } from '../../src/server/config';
import { AppError } from '../../src/server/errors';
import { stripSensitiveParams, validateUpstreamUrl, resolveUpstreamReference } from '../../src/server/urls';
import { createLink, startStack, type Stack } from './support/harness';

const JF: JellyfinConfig = {
  origin: 'http://jellyfin.test:8096',
  basePath: '/jellyfin',
  apiKey: 'key',
  userId: 'user',
};

const ITEM = '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected to throw');
}

describe('upstream URL validation (unit)', () => {
  it('rejects foreign origins, credentials and base-path escapes', () => {
    expect(codeOf(() => validateUpstreamUrl('https://evil.example/x', JF))).toBe('untrusted_origin');
    expect(codeOf(() => validateUpstreamUrl('http://user:pass@jellyfin.test:8096/x', JF))).toBe(
      'invalid_url_credentials',
    );
    expect(codeOf(() => validateUpstreamUrl('http://jellyfin.test:8096/other/x', JF))).toBe(
      'untrusted_path',
    );
  });

  it('rejects unsafe schemes and protocol-relative references in manifests', () => {
    const ctx = `http://jellyfin.test:8096/jellyfin/Videos/${ITEM}/master.m3u8`;
    expect(codeOf(() => resolveUpstreamReference('file:///etc/passwd', ctx, JF))).toBe('unsafe_uri_scheme');
    expect(codeOf(() => resolveUpstreamReference('javascript:alert(1)', ctx, JF))).toBe('unsafe_uri_scheme');
    expect(codeOf(() => resolveUpstreamReference('//evil.example/a.ts', ctx, JF))).toBe('untrusted_path');
    expect(codeOf(() => resolveUpstreamReference('https://evil.example/a.ts', ctx, JF))).toBe(
      'untrusted_origin',
    );
  });

  it('treats 32-hex and dashed UUID spellings as the same item namespace', () => {
    const itemDashed = '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b';
    const itemHex = itemDashed.replace(/-/g, '');
    // Jellyfin 10.11 returns 32-hex ids but uses dashed ids in HLS paths.
    const byPath = validateUpstreamUrl(
      `http://jellyfin.test:8096/jellyfin/videos/${itemDashed}/master.m3u8`,
      JF,
      { itemId: itemHex },
    );
    expect(byPath.pathname).toContain(itemDashed);
    const ctx = `http://jellyfin.test:8096/jellyfin/Videos/${itemHex}/master.m3u8`;
    const resolved = resolveUpstreamReference(
      `/Videos/${itemDashed}/hls1/main/0.ts`,
      ctx,
      JF,
      { itemId: itemHex },
    );
    expect(resolved.pathname).toContain(itemDashed);
    // A genuinely different item id is still rejected.
    expect(
      codeOf(() =>
        validateUpstreamUrl(
          'http://jellyfin.test:8096/jellyfin/videos/11111111-2222-4333-8444-555555555555/master.m3u8',
          JF,
          { itemId: itemHex },
        ),
      ),
    ).toBe('untrusted_path');
  });

  it('rejects plain and encoded traversal that escapes the item namespace', () => {
    const ctx = `http://jellyfin.test:8096/jellyfin/Videos/${ITEM}/hls1/main/main.m3u8`;
    expect(codeOf(() => resolveUpstreamReference('../../../../etc/passwd', ctx, JF))).toBe('untrusted_path');
    expect(
      codeOf(() =>
        resolveUpstreamReference('hls1/main/%2e%2e/%2e%2e/%2e%2e/etc/passwd', ctx, JF),
      ),
    ).toBe('untrusted_path');
  });

  it('resolves root-relative references beneath the configured base path and preserves queries', () => {
    const ctx = `http://jellyfin.test:8096/jellyfin/Videos/${ITEM}/master.m3u8`;
    const resolved = resolveUpstreamReference(
      `/Videos/${ITEM}/hls1/main/0.ts?runtimeTicks=0&actualSegmentLengthTicks=1`,
      ctx,
      JF,
      { itemId: ITEM },
    );
    expect(resolved.origin).toBe(JF.origin);
    expect(resolved.pathname).toBe(`/jellyfin/Videos/${ITEM}/hls1/main/0.ts`);
    expect(resolved.searchParams.get('runtimeTicks')).toBe('0');
  });

  it('resolves relative references against the manifest URL', () => {
    const ctx = `http://jellyfin.test:8096/jellyfin/Videos/${ITEM}/hls1/main/main.m3u8`;
    const resolved = resolveUpstreamReference('../0.ts', ctx, JF, { itemId: ITEM });
    expect(resolved.pathname).toBe(`/jellyfin/Videos/${ITEM}/hls1/0.ts`);
  });

  it('strips credential query parameters case-insensitively', () => {
    const url = new URL(
      'http://jellyfin.test:8096/jellyfin/Videos/x/master.m3u8?ApiKey=a&api_key=b&X-Emby-Token=c&Token=d&keep=1',
    );
    const stripped = stripSensitiveParams(url);
    expect(stripped.searchParams.get('ApiKey')).toBeNull();
    expect(stripped.searchParams.get('api_key')).toBeNull();
    expect(stripped.searchParams.get('X-Emby-Token')).toBeNull();
    expect(stripped.searchParams.get('Token')).toBeNull();
    expect(stripped.searchParams.get('keep')).toBe('1');
  });
});

describe('hostile manifest references (integration)', () => {
  let stack: Stack | undefined;
  it('rejects dangerous URI mechanisms instead of leaking them', async () => {
    stack = await startStack({ mock: { includeHostileRefs: true } });
    try {
      const link = await createLink(stack.app, stack.authHeaders);
      const master = await stack.app.inject({ method: 'GET', url: link.path });
      expect(master.statusCode).toBe(200);
      const variantPath = master.body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))!;
      const variant = await stack.app.inject({ method: 'GET', url: variantPath });
      expect(variant.statusCode).toBeGreaterThanOrEqual(400);
      expect(variant.body).not.toContain('evil.example');
      expect(variant.body).not.toContain('passwd');
      expect(variant.body).not.toContain('key.bin');
    } finally {
      await stack.close();
      stack = undefined;
    }
  });
});
