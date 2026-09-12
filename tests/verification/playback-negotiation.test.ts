import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, MOVIE_ID, SECRET_TOKEN } from './support/mockJellyfin';
import { createLink, startStack, type Stack } from './support/harness';

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Playback negotiation and upstream requests', () => {
  it('forces a non-copy H.264/AAC TS HLS transcode with burned-in subtitles', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders, { subtitleStreamIndex: 2 });

    const master = await stack.app.inject({
      method: 'GET',
      url: link.path,
      headers: { origin: 'https://player.example' },
    });
    expect(master.statusCode).toBe(200);
    expect(master.headers['content-type']).toContain('application/vnd.apple.mpegurl');

    const playback = stack.mock.last('/PlaybackInfo');
    expect(playback, 'PlaybackInfo should have been called').toBeTruthy();
    const body = JSON.parse(playback!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      MediaSourceId: MOVIE_ID,
      SubtitleStreamIndex: 2,
      MaxAudioChannels: 2,
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      AllowVideoStreamCopy: false,
      AllowAudioStreamCopy: false,
      AlwaysBurnInSubtitleWhenTranscoding: true,
      MaxStreamingBitrate: 8_000_000,
    });
    const profile = body.DeviceProfile as {
      TranscodingProfiles: Array<Record<string, unknown>>;
      CodecProfiles: Array<{ Codec: string; Conditions: Array<Record<string, unknown>> }>;
      SubtitleProfiles: unknown[];
    };
    expect(profile.TranscodingProfiles[0]).toMatchObject({
      Container: 'ts',
      Type: 'Video',
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      Protocol: 'hls',
      Context: 'Streaming',
      MaxAudioChannels: '2',
      EnableSubtitlesInManifest: false,
    });
    const h264 = profile.CodecProfiles.find((c) => c.Codec === 'h264');
    const bitDepth = h264?.Conditions.find((c) => c.Property === 'VideoBitDepth');
    expect(bitDepth).toMatchObject({ Condition: 'LessThanEqual', Value: '8' });

    // Upstream authorization uses the MediaBrowser scheme with the API key.
    const auth = String(playback!.headers['authorization'] ?? '');
    expect(auth).toContain('MediaBrowser');
    expect(auth).toContain(`Token="${API_KEY}"`);
    // Credentials stay in the header; the configured user is passed explicitly.
    expect(playback!.query.get('userId')).toBe('d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70');
    expect(playback!.query.get('ApiKey')).toBeNull();
    expect(playback!.query.get('api_key')).toBeNull();

    // The master fetch must not carry credentials in the query and must
    // enforce our parameters plus disable trickplay.
    const masterReq = stack.mock.last('/master.m3u8');
    expect(masterReq, 'master.m3u8 should have been fetched upstream').toBeTruthy();
    expect(masterReq!.query.get('ApiKey')).toBeNull();
    expect(masterReq!.query.get('api_key')).toBeNull();
    expect(masterReq!.query.get('VideoCodec')).toBe('h264');
    expect(masterReq!.query.get('AudioCodec')).toBe('aac');
    expect(masterReq!.query.get('SubtitleMethod')).toBe('Encode');
    expect(masterReq!.query.get('SubtitleStreamIndex')).toBe('2');
    expect(masterReq!.query.get('enableTrickplay')).toBe('false');
    expect(masterReq!.query.get('DeviceId')).toBeTruthy();
    expect(masterReq!.query.get('PlaySessionId')).toBe('mock-play-session-123456');
    expect(String(masterReq!.headers['authorization'] ?? '')).toContain(`Token="${API_KEY}"`);
  });

  it('never leaks upstream credentials into the client-facing manifest', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    expect(master.body).not.toContain(SECRET_TOKEN);
    expect(master.body).not.toContain('ApiKey');
    expect(master.body).not.toContain(API_KEY);
    // Every URI-bearing line must point at our own /s/ namespace.
    const uriLines = master.body
      .split('\n')
      .filter((l) => /URI="/.test(l) || (/^[^#]/.test(l) && l.trim() !== ''));
    for (const line of uriLines) {
      expect(line).toMatch(/\/s\/|URI="\/s\//);
      expect(line).not.toContain('127.0.0.1');
    }
  });

  it('requests no subtitle for None (explicit -1) without burning or leaking', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders, { subtitleStreamIndex: -1 });

    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);

    const body = JSON.parse(stack.mock.last('/PlaybackInfo')!.body) as Record<string, unknown>;
    expect(body.SubtitleStreamIndex).toBe(-1);
    expect(body.AlwaysBurnInSubtitleWhenTranscoding).toBe(false);

    const masterReq = stack.mock.last('/master.m3u8')!;
    const index = masterReq.query.get('SubtitleStreamIndex');
    expect(index === null || index === '-1').toBe(true);
    expect(masterReq.query.get('SubtitleMethod')).not.toBe('Encode');
    expect(master.body).not.toContain('ApiKey');
  });

  it('honours the saved start position and audio track on the master request', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders, {
      startSeconds: 120,
      audioStreamIndex: 1,
    });
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);

    const body = JSON.parse(stack.mock.last('/PlaybackInfo')!.body) as Record<string, unknown>;
    expect(body.StartTimeTicks).toBe(120 * 10_000_000);
    expect(body.AudioStreamIndex).toBe(1);

    // Jellyfin's HLS TranscodingUrl intentionally omits StartTimeTicks
    // (StreamInfo.ToUrl only emits it for non-HLS), so the gateway must add it
    // or the saved start position is lost when the transcode starts.
    const masterReq = stack.mock.last('/master.m3u8')!;
    expect(masterReq.query.get('StartTimeTicks')).toBe(String(120 * 10_000_000));
    expect(masterReq.query.get('AudioStreamIndex')).toBe('1');
  });

  it('resolves a root-relative TranscodingUrl beneath the configured base path', async () => {
    for (const style of [
      'rootRelativeWithoutBase',
      'rootRelativeWithBase',
      'absoluteWithBase',
    ] as const) {
      stack = await startStack({
        basePath: '/jellyfin',
        mock: { transcodingUrlStyle: style },
      });
      const link = await createLink(stack.app, stack.authHeaders);
      const master = await stack.app.inject({ method: 'GET', url: link.path });
      expect(master.statusCode, `style=${style} body=${master.body}`).toBe(200);
      const masterReq = stack.mock.last('/master.m3u8');
      expect(masterReq, `style=${style} should fetch master`).toBeTruthy();
      expect(masterReq!.path).toBe(`/jellyfin/videos/${MOVIE_ID}/master.m3u8`);
      await stack.close();
      stack = undefined;
    }
  });

  it('rejects an untrusted TranscodingUrl instead of proxying it', async () => {
    stack = await startStack({ mock: { untrustedTranscodingUrl: true } });
    const link = await createLink(stack.app, stack.authHeaders).catch(() => null);
    // Link creation itself is fine; the master request must fail.
    expect(link).toBeTruthy();
    const master = await stack.app.inject({ method: 'GET', url: link!.path });
    expect(master.statusCode).toBeGreaterThanOrEqual(400);
    expect(master.body).not.toContain('evil.example');
    expect(stack.mock.find('/master.m3u8').length).toBe(0);
  });

  it('surfaces negotiation failures clearly', async () => {
    stack = await startStack({ mock: { playbackError: true } });
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(422);
    expect(master.json()).toMatchObject({ error: { code: 'negotiation_failed' } });
  });

  it('rejects an upstream redirect that leaves the configured origin', async () => {
    stack = await startStack({ mock: { redirectMasterTo: 'https://evil.example/master.m3u8' } });
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBeGreaterThanOrEqual(400);
    expect(master.body).not.toContain('evil.example');
  });

  it('scopes encoding cleanup to the effective DeviceId and PlaySessionId', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);

    const masterReq = stack.mock.last('/master.m3u8')!;
    const effectiveDeviceId = masterReq.query.get('DeviceId');
    expect(effectiveDeviceId).toBeTruthy();

    await stack.app.inject({
      method: 'DELETE',
      url: `/api/links/${link.id}`,
      headers: stack.authHeaders,
    });
    await waitFor(() => stack!.mock.find('/Videos/ActiveEncodings').length > 0);

    const stop = stack.mock.last('/Videos/ActiveEncodings')!;
    expect(stop.method).toBe('DELETE');
    expect(stop.query.get('deviceId')).toBe(effectiveDeviceId);
    expect(stop.query.get('playSessionId')).toBe('mock-play-session-123456');
    expect(stop.query.get('deviceId')).not.toBe('');
  });

  it('uses a distinct DeviceId/PlaySessionId per playback session', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const a = await stack.app.inject({ method: 'GET', url: link.path });
    const b = await stack.app.inject({ method: 'GET', url: link.path });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const playbackCalls = stack.mock.find('/PlaybackInfo');
    expect(playbackCalls.length).toBe(2);
    const deviceIds = playbackCalls.map(
      (r) => /DeviceId="([^"]+)"/.exec(String(r.headers['authorization'] ?? ''))?.[1],
    );
    expect(new Set(deviceIds).size).toBe(2);
  });
});
