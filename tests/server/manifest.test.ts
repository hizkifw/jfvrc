import { describe, expect, it } from 'vitest';
import { rewriteManifest } from '../../src/server/manifest';
import { AppError } from '../../src/server/errors';
import type { JellyfinConfig } from '../../src/server/config';

const jellyfin: JellyfinConfig = {
  origin: 'https://jf.example',
  basePath: '',
  apiKey: 'k',
  userId: 'u',
};

function context(basePath = '') {
  let counter = 0;
  return {
    ctx: {
      jellyfin: { ...jellyfin, basePath },
      itemId: 'abc',
      manifestUrl: `https://jf.example/Videos/abc/master.m3u8`,
      mapResource: (url: string) => `/res/${++counter}?u=${encodeURIComponent(url)}`,
    },
  };
}

describe('rewriteManifest', () => {
  it('rewrites variant URIs and all URI-bearing tags while preserving structure', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      'main.m3u8?x=1',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="/Videos/abc/keys/k.key"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.x",URI="https://jf.example/Videos/abc/data.json"',
      '#EXT-X-CONTENT-STEERING:SERVER-URI="steer.json"',
      '',
    ].join('\r\n');
    const { ctx } = context();
    const out = rewriteManifest(input, ctx);
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out.split('\r\n').length - 1).toBe(9);
    expect(out).toContain('URI="/res/1?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Faudio.m3u8"');
    expect(out).toContain('/res/2?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Fmain.m3u8%3Fx%3D1');
    expect(out).toContain('URI="/res/3?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Fiframe.m3u8"');
    expect(out).toContain('URI="/res/4?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Fkeys%2Fk.key"');
    expect(out).toContain('/res/5?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Fdata.json');
    expect(out).toContain('SERVER-URI="/res/6?');
  });

  it('rewrites media playlist resources and preserves tags', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.key"',
      '#EXTINF:6.0,',
      'seg1.ts?ApiKey=SEGRET&runtimeTicks=100',
      '#EXT-X-PART:DURATION=1,URI="p1.ts"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="p2.ts"',
      '#EXT-X-RENDITION-REPORT:URI="alt/main.m3u8"',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const { ctx } = context();
    const out = rewriteManifest(input, ctx);
    expect(out).toContain('#EXT-X-TARGETDURATION:6');
    expect(out).toContain('#EXT-X-MAP:URI="/res/1?');
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="/res/2?');
    expect(out).toContain('#EXTINF:6.0,');
    expect(out).toContain('/res/3?u=https%3A%2F%2Fjf.example%2FVideos%2Fabc%2Fseg1.ts%3FruntimeTicks%3D100');
    expect(out).not.toContain('ApiKey');
    expect(out).not.toContain('SEGRET');
    expect(out).toContain('#EXT-X-PART:DURATION=1,URI="/res/4?');
    expect(out).toContain('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="/res/5?');
    expect(out).toContain('#EXT-X-RENDITION-REPORT:URI="/res/6?');

    const escape = '#EXT-X-RENDITION-REPORT:URI="../other/main.m3u8"\n';
    expect(() => rewriteManifest(escape, ctx)).toThrow(/namespace/i);
  });

  it('resolves root-relative references under a configured base path', () => {
    const { ctx } = context('/jellyfin');
    ctx.manifestUrl = 'https://jf.example/jellyfin/Videos/abc/master.m3u8';
    const out = rewriteManifest('seg.ts\n', ctx);
    expect(out).toContain('/res/1?u=https%3A%2F%2Fjf.example%2Fjellyfin%2FVideos%2Fabc%2Fseg.ts');
  });

  it('rejects unsafe schemes and untrusted origins', () => {
    const { ctx } = context();
    const dataUri = '#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,AAAA"\n';
    expect(() => rewriteManifest(dataUri, ctx)).toThrow(AppError);
    const evil = '#EXT-X-MAP:URI="https://evil.example/x.ts"\n';
    expect(() => rewriteManifest(evil, ctx)).toThrow(/origin|Jellyfin/i);
    const foreignItem = '#EXT-X-MAP:URI="https://jf.example/Videos/other/x.ts"\n';
    expect(() => rewriteManifest(foreignItem, ctx)).toThrow(/namespace/i);
  });
});
