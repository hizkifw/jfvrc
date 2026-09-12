import { describe, expect, it } from 'vitest';
import { resolveUpstreamReference, stripSensitiveParams, validateUpstreamUrl } from '../../src/server/urls';
import type { JellyfinConfig } from '../../src/server/config';

const jellyfin: JellyfinConfig = {
  origin: 'https://jf.example:8920',
  basePath: '/jellyfin',
  apiKey: 'k',
  userId: 'u',
};

describe('validateUpstreamUrl', () => {
  it('accepts configured origin and base path', () => {
    const url = validateUpstreamUrl('https://jf.example:8920/jellyfin/Videos/a/seg.ts', jellyfin, {
      itemId: 'a',
    });
    expect(url.pathname).toBe('/jellyfin/Videos/a/seg.ts');
  });

  it('rejects credentials, wrong origin, and paths outside the base path', () => {
    expect(() => validateUpstreamUrl('https://u:p@jf.example:8920/jellyfin/x', jellyfin)).toThrow();
    expect(() => validateUpstreamUrl('https://evil.example/jellyfin/x', jellyfin)).toThrow();
    expect(() => validateUpstreamUrl('https://jf.example:8920/other/x', jellyfin)).toThrow();
    expect(() =>
      validateUpstreamUrl('https://jf.example:8920/jellyfin/Videos/other/x.ts', jellyfin, {
        itemId: 'a',
      }),
    ).toThrow(/namespace/i);
    expect(() =>
      validateUpstreamUrl(
        'https://jf.example:8920/jellyfin/Videos/a/src/Subtitles/2/subtitles.m3u8',
        jellyfin,
        { itemId: 'a' },
      ),
    ).toThrow(/subtitle/i);
    expect(() =>
      validateUpstreamUrl('https://jf.example:8920/jellyfin/Videos/a/Trickplay/320/tiles.m3u8', jellyfin, {
        itemId: 'a',
      }),
    ).toThrow(/trickplay/i);
  });
});

describe('resolveUpstreamReference', () => {
  it('resolves relative, root-relative and absolute references', () => {
    const base = 'https://jf.example:8920/jellyfin/Videos/a/master.m3u8';
    const relative = resolveUpstreamReference('main.m3u8?x=1', base, jellyfin, { itemId: 'a' });
    expect(relative.toString()).toBe(
      'https://jf.example:8920/jellyfin/Videos/a/main.m3u8?x=1',
    );
    const root = resolveUpstreamReference('/Videos/a/seg.ts', base, jellyfin, { itemId: 'a' });
    expect(root.toString()).toBe('https://jf.example:8920/jellyfin/Videos/a/seg.ts');
    const absolute = resolveUpstreamReference(
      'https://jf.example:8920/jellyfin/Videos/a/x.ts',
      base,
      jellyfin,
      { itemId: 'a' },
    );
    expect(absolute.pathname).toBe('/jellyfin/Videos/a/x.ts');
  });

  it('rejects unsafe schemes', () => {
    const base = 'https://jf.example:8920/jellyfin/Videos/a/master.m3u8';
    expect(() => resolveUpstreamReference('data:text/plain,hi', base, jellyfin)).toThrow(/scheme/i);
    expect(() => resolveUpstreamReference('file:///etc/passwd', base, jellyfin)).toThrow(/scheme/i);
  });
});

describe('stripSensitiveParams', () => {
  it('removes api_key and emby tokens', () => {
    const cleaned = stripSensitiveParams(
      new URL('https://jf.example/x?api_key=secret&X-Emby-Token=t&ok=1'),
    );
    expect(cleaned.searchParams.get('api_key')).toBeNull();
    expect(cleaned.searchParams.get('X-Emby-Token')).toBeNull();
    expect(cleaned.searchParams.get('ok')).toBe('1');
  });
});
