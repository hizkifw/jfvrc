import { describe, expect, it } from 'vitest';
import type { JellyfinConfig } from '../../src/server/config';
import { rewriteManifest } from '../../src/server/manifest';

const JF: JellyfinConfig = {
  origin: 'http://jellyfin.test:8096',
  basePath: '/jellyfin',
  apiKey: 'key',
  userId: 'user',
};

const ITEM = '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b';

function variant(extra: string): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:6.000,',
    `hls1/main/0.ts?${extra}&runtimeTicks=0&actualSegmentLengthTicks=60000000`,
    '#EXTINF:6.000,',
    `hls1/main/1.ts?${extra}&runtimeTicks=60000000&actualSegmentLengthTicks=60000000`,
    '#EXTINF:6.000,',
    `hls1/main/2.ts?${extra}&runtimeTicks=120000000&actualSegmentLengthTicks=60000000`,
    '#EXTINF:6.000,',
    `hls1/main/3.ts?${extra}&runtimeTicks=180000000&actualSegmentLengthTicks=60000000`,
    '#EXT-X-ENDLIST',
  ].join('\n');
}

function ctx(startTicks: number) {
  return {
    jellyfin: JF,
    itemId: ITEM,
    manifestUrl: `http://jellyfin.test:8096/jellyfin/Videos/${ITEM}/hls1/main/main.m3u8`,
    startTicks,
    mapResource: (url: string) => {
      const parsed = new URL(url);
      return `/res/${parsed.pathname.split('/').pop()}${parsed.search}`;
    },
  };
}

describe('variant start offset and StartTimeTicks handling', () => {
  it('trims segments before the requested start and shifts the media sequence', () => {
    const out = rewriteManifest(variant('StartTimeTicks=120000000'), ctx(120_000_000));
    expect(out).not.toContain('0.ts');
    expect(out).not.toContain('1.ts');
    expect(out).toContain('2.ts');
    expect(out).toContain('3.ts');
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    // Jellyfin rejects StartTimeTicks>0 on segment requests, so it must be gone.
    expect(out).not.toContain('StartTimeTicks');
    expect(out).toContain('runtimeTicks=120000000');
  });

  it('leaves the full playlist when starting at zero', () => {
    const out = rewriteManifest(variant('StartTimeTicks=0'), ctx(0));
    expect(out).toContain('0.ts');
    expect(out).toContain('3.ts');
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(out).not.toContain('StartTimeTicks');
  });

  it('does not emit an empty playlist when the offset exceeds the duration', () => {
    const out = rewriteManifest(variant('StartTimeTicks=0'), ctx(999_000_000_000));
    expect(out).toContain('3.ts');
  });
});
