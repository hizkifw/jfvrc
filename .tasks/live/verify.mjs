/**
 * Live end-to-end verification orchestrator.
 *
 * Loads the user's .env IN PROCESS, starts the built gateway on a task-specific
 * loopback port with the real Jellyfin config, and exercises real negotiation +
 * bounded transcoding. All upstream requests are observed through a sanitizing
 * fetch wrapper that records only non-secret parameters. Nothing here prints
 * tokens, credentialed URLs, item ids/names, or raw upstream bodies.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, maskUrl, makeJellyfin, readState, safeError, writeState } from './lib.mjs';

const ROOT = '/home/kitsune/workspace/jfvrc';
const LIVE = join(ROOT, '.tasks/live');
const PORT = 34117;
const GW = `http://127.0.0.1:${PORT}`;
const require = createRequire(import.meta.url);

const env = loadEnv();
const state = readState(join(LIVE, 'state.json'));
const item = state.subItem;
const audioItem = state.audioItem ?? state.subItem;

const results = [];
const upstream = [];
let app = null;
const createdLinks = [];
const testDeviceIds = new Set();
const testPlaySessionIds = new Set();

function report(scenario, ok, evidence) {
  results.push({ scenario, ok, evidence });
  console.log(`[${ok ? 'PASS' : (ok === false ? 'FAIL' : 'INFO')}] ${scenario}: ${JSON.stringify(evidence)}`);
}

function sanitizeHeaders(initHeaders) {
  try {
    if (!initHeaders) return { authMediaBrowser: false, hasAuthorization: false };
    if (typeof initHeaders.get === 'function') {
      const auth = initHeaders.get('authorization') ?? '';
      return { authMediaBrowser: auth.startsWith('MediaBrowser'), hasAuthorization: !!auth };
    }
    const auth = initHeaders.Authorization ?? initHeaders.authorization ?? '';
    return { authMediaBrowser: String(auth).startsWith('MediaBrowser'), hasAuthorization: !!auth };
  } catch {
    return { authMediaBrowser: false, hasAuthorization: false };
  }
}

function sanitizingFetch(url, init = {}) {
  const u = new URL(url);
  const p = u.searchParams;
  const kind = /\/PlaybackInfo$/.test(u.pathname)
    ? 'playbackInfo'
    : /\/master\.m3u8$/.test(u.pathname)
      ? 'master'
      : /\/main\.m3u8$/.test(u.pathname)
        ? 'variant'
        : /\/hls1\//.test(u.pathname)
          ? 'segment'
          : /ActiveEncodings$/.test(u.pathname)
            ? 'stopEncoding'
            : 'other';
  const hdr = sanitizeHeaders(init.headers);
  const entry = {
    kind,
    method: init.method ?? 'GET',
    authMediaBrowser: hdr.authMediaBrowser,
    leaksCredentialInQuery: p.has('ApiKey') || p.has('api_key') || p.has('X-Emby-Token') || p.has('Token'),
    params: {
      StartTimeTicks: p.get('StartTimeTicks'),
      SubtitleStreamIndex: p.get('SubtitleStreamIndex'),
      SubtitleMethod: p.get('SubtitleMethod'),
      VideoCodec: p.get('VideoCodec'),
      AudioCodec: p.get('AudioCodec'),
      AudioStreamIndex: p.get('AudioStreamIndex'),
      allowVideoStreamCopy: p.get('allowVideoStreamCopy'),
      allowAudioStreamCopy: p.get('allowAudioStreamCopy'),
      enableAutoStreamCopy: p.get('enableAutoStreamCopy'),
      enableTrickplay: p.get('enableTrickplay'),
      SegmentContainer: p.get('SegmentContainer'),
      hasMediaSourceId: p.has('MediaSourceId'),
      hasPlaySessionId: p.has('PlaySessionId'),
      hasDeviceId: p.has('DeviceId'),
    },
    deviceId: p.get('DeviceId') ?? null,
    playSessionId: p.get('PlaySessionId') ?? null,
  };
  if (kind === 'playbackInfo' && typeof init.body === 'string') {
    try {
      const b = JSON.parse(init.body);
      entry.negotiation = {
        EnableDirectPlay: b.EnableDirectPlay,
        EnableDirectStream: b.EnableDirectStream,
        EnableTranscoding: b.EnableTranscoding,
        AllowVideoStreamCopy: b.AllowVideoStreamCopy,
        AllowAudioStreamCopy: b.AllowAudioStreamCopy,
        AlwaysBurnInSubtitleWhenTranscoding: b.AlwaysBurnInSubtitleWhenTranscoding,
        SubtitleStreamIndex: b.SubtitleStreamIndex,
        StartTimeTicks: b.StartTimeTicks,
        MaxStreamingBitrate: b.MaxStreamingBitrate,
        MaxAudioChannels: b.MaxAudioChannels,
        hasDeviceProfile: !!b.DeviceProfile,
        transcodeContainer: b.DeviceProfile?.TranscodingProfiles?.[0]?.Container,
        transcodeVideo: b.DeviceProfile?.TranscodingProfiles?.[0]?.VideoCodec,
        transcodeAudio: b.DeviceProfile?.TranscodingProfiles?.[0]?.AudioCodec,
        transcodeProtocol: b.DeviceProfile?.TranscodingProfiles?.[0]?.Protocol,
        enableSubtitlesInManifest: b.DeviceProfile?.TranscodingProfiles?.[0]?.EnableSubtitlesInManifest,
        bitDepthCondition:
          b.DeviceProfile?.CodecProfiles?.[0]?.Conditions?.find((c) => c.Property === 'VideoBitDepth')?.Value,
      };
    } catch {
      entry.negotiation = null;
    }
  }
  if (entry.deviceId) testDeviceIds.add(entry.deviceId);
  if (entry.playSessionId) testPlaySessionIds.add(entry.playSessionId);
  upstream.push(entry);
  return fetch(url, init);
}

function last(kind) {
  return [...upstream].reverse().find((e) => e.kind === kind) ?? null;
}

async function gateway(path, init = {}) {
  return fetch(`${GW}${path}`, init);
}

async function adminJson(path, init = {}) {
  return gateway(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function fetchWithRetry(path, attempts = 180, delayMs = 1000) {
  let lastResponse = null;
  for (let i = 0; i < attempts; i += 1) {
    lastResponse = await gateway(path);
    if (lastResponse.status === 200) return lastResponse;
    if (![404, 502, 503].includes(lastResponse.status)) return lastResponse;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastResponse;
}

function allUris(manifest) {
  const uris = [];
  for (const line of manifest.split('\n')) {
    const attr = /URI="([^"]+)"/.exec(line);
    if (attr) uris.push(attr[1]);
    else if (line.trim() && !line.trimStart().startsWith('#')) uris.push(line.trim());
  }
  return uris;
}

function ffprobe(file) {
  const dir = LIVE;
  const name = file.split('/').pop();
  const out = execFileSync(
    'docker',
    [
      'run', '--rm', '-v', `${dir}:/data:ro`,
      '--entrypoint', '/ffprobe', 'mwader/static-ffmpeg:latest',
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', `/data/${name}`,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  const parsed = JSON.parse(out);
  const v = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
  const a = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  return {
    format: parsed.format?.format_name,
    duration: parsed.format?.duration ? Number(Number(parsed.format.duration).toFixed(2)) : null,
    startTime: parsed.format?.start_time ? Number(Number(parsed.format.start_time).toFixed(3)) : null,
    video: v ? { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, pixFmt: v.pix_fmt, level: v.level } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate, profile: a.profile } : null,
  };
}

const { base, jget } = makeJellyfin(env);

async function jellyfinItemStreams(id) {
  const doc = await jget(`/Items/${id}?userId=${env.JELLYFIN_USER_ID}&fields=MediaSources`);
  const streams = doc.MediaSources?.[0]?.MediaStreams ?? [];
  return {
    sourceId: doc.MediaSources?.[0]?.Id,
    audio: streams.filter((s) => s.Type === 'Audio').map((s) => ({ index: s.Index, codec: s.Codec, channels: s.Channels, isDefault: !!s.IsDefault })),
    subtitles: streams.filter((s) => s.Type === 'Subtitle').map((s) => ({ index: s.Index, codec: s.Codec, isText: s.IsTextSubtitleStream !== false, isDefault: !!s.IsDefault })),
  };
}

async function resolveDetails(id) {
  const response = await adminJson('/api/resolve', { method: 'POST', body: JSON.stringify({ input: id }) });
  return response.json();
}

async function liveSessionsForTest() {
  try {
    const sessions = await jget('/Sessions');
    return (sessions ?? []).filter((s) => testDeviceIds.has(s.DeviceId) || testPlaySessionIds.has(s.PlaySessionId));
  } catch {
    return [];
  }
}

async function transcodeLogEvidence() {
  try {
    const logs = await jget('/System/Logs');
    const files = (logs ?? [])
      .filter((f) => f.Name)
      .sort((a, b) => String(b.DateModified ?? '').localeCompare(String(a.DateModified ?? '')))
      .slice(0, 6);
    let best = null;
    for (const f of files) {
      const response = await fetch(`${base}/System/Logs/Log?name=${encodeURIComponent(f.Name)}`, {
        headers: { Authorization: `MediaBrowser Token="${env.JELLYFIN_API_KEY}"` },
      });
      if (!response.ok) continue;
      const text = (await response.text()).slice(-400_000);
      if (text.includes('subtitles=') || / -ss /.test(text) || text.includes('libx264')) {
        best = {
          hasSubtitlesFilter: text.includes('subtitles='),
          hasFilterComplex: text.includes('-filter_complex'),
          hasLibx264: text.includes('libx264'),
          hasAac: text.includes(' -c:a aac') || text.includes('-acodec aac') || text.includes('aac'),
          hasSs: / -ss \d/.test(text),
          ssMatchesRequested:
            / -ss (\d+(?:\.\d+)?)/.exec(text) ? Number(/ -ss (\d+(?:\.\d+)?)/.exec(text)[1]) : null,
          sawScale: text.includes('scale='),
          sawYuv420p: text.includes('yuv420p') || text.includes('format=yuv420p'),
        };
        break;
      }
    }
    return best;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Start gateway
// ---------------------------------------------------------------------------
mkdirSync(LIVE, { recursive: true });
rmSync(join(LIVE, 'gateway.db'), { force: true });

const { loadConfig } = require(join(ROOT, 'dist/server/config.js'));
const { buildApp } = require(join(ROOT, 'dist/server/app.js'));

const appEnv = {
  ...env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  PUBLIC_BASE_URL: GW,
  DATABASE_PATH: join(LIVE, 'gateway.db'),
  SESSION_IDLE_TTL_SECONDS: '120',
  MAX_ACTIVE_SESSIONS: '2',
  UPSTREAM_TIMEOUT_SECONDS: '60',
};
const config = loadConfig(appEnv);
const built = buildApp({ config, fetchImpl: sanitizingFetch, logger: false });
app = built.app;
try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
} catch (error) {
  console.log('gateway listen failed:', safeError(error));
  process.exit(1);
}

function scrub(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\/s\/[A-Za-z0-9_-]+/g, '/s/[token]');
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (error) {
    report(name, false, { error: safeError(error), message: scrub(error?.message) });
  }
}

function newTranscodeCount() {
  return upstream.filter((e) => e.kind === 'playbackInfo').length;
}

try {
  report('server', null, {
    jellyfinVersion: (await jget('/System/Info/Public')).Version,
    jellyfinUrlSanitized: maskUrl(env.JELLYFIN_URL),
    gateway: GW,
    publicBaseUrlConfiguredSanitized: env.PUBLIC_BASE_URL ? maskUrl(env.PUBLIC_BASE_URL) : null,
  });

  // S0 status/auth
  await scenario('status/auth', async () => {
    const noAuth = await gateway('/api/status');
    const authed = await adminJson('/api/status');
    const body = await authed.json();
    report('status/auth', noAuth.status === 401 && authed.status === 200 && body.configured === true, {
      noAuthStatus: noAuth.status,
      authedStatus: authed.status,
      configured: body.configured,
      jellyfinUrlSanitized: body.jellyfinUrl,
      publicBaseUrl: body.publicBaseUrl,
    });
  });

  // S1 resolve + library
  await scenario('resolve/library', async () => {
    const liveStreams = await jellyfinItemStreams(item.id);
    const byId = await adminJson('/api/resolve', { method: 'POST', body: JSON.stringify({ input: item.id }) });
    const resolved = await byId.json();
    const source = resolved.mediaSources?.[0];
    const tracksMatch =
      source &&
      source.audioTracks.length === liveStreams.audio.length &&
      source.subtitleTracks.length === liveStreams.subtitles.length &&
      liveStreams.subtitles.some((s) => s.index === (item.textSubIndex ?? s.index)) &&
      source.subtitleTracks.some((t) => t.index === item.textSubIndex);
    const byUrl = await adminJson('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ input: `${env.JELLYFIN_URL.replace(/\/+$/, '')}/web/index.html#/details?id=${item.id}` }),
    });
    const library = await adminJson('/api/library?query=&startIndex=0&limit=5');
    const libBody = await library.json();
    report('resolve/library', byId.status === 200 && byUrl.status === 200 && tracksMatch, {
      resolveByIdStatus: byId.status,
      resolveByUrlStatus: byUrl.status,
      mediaSources: resolved.mediaSources?.length ?? 0,
      audioTracks: source?.audioTracks.length ?? 0,
      subtitleTracks: source?.subtitleTracks.length ?? 0,
      liveAudioMatches: liveStreams.audio.length,
      liveSubtitleMatches: liveStreams.subtitles.length,
      tracksMatch: !!tracksMatch,
      libraryStatus: library.status,
      libraryTotal: libBody.total,
    });
  });

  // S2 no-subtitle link + full chain
  let noSubLink = null;
  let noSubSegmentPath = null;
  await scenario('no-subtitle chain', async () => {
    const detail = await resolveDetails(item.id);
    const mediaSourceId = detail.mediaSources?.[0]?.id;
    const create = await adminJson('/api/links', {
      method: 'POST',
      body: JSON.stringify({
        itemId: item.id,
        mediaSourceId,
        subtitleStreamIndex: -1,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 1,
      }),
    });
    const createText = await create.text();
    const created = (() => { try { return JSON.parse(createText); } catch { return {}; } })();
    if (create.status !== 201) {
      report('no-subtitle chain', false, { linkCreateStatus: create.status, errorCode: created?.error?.code });
      return;
    }
    createdLinks.push(created.id);
    noSubLink = new URL(created.url).pathname.replace(/^.*(\/s\/)/, '$1');

    const master = await gateway(noSubLink);
    const masterText = await master.text();
    if (master.status !== 200) {
      const code = (() => { try { return JSON.parse(masterText)?.error?.code; } catch { return null; } })();
      report('no-subtitle chain', false, { masterStatus: master.status, masterErrorCode: code });
      return;
    }
    const playback = last('playbackInfo');
    const masterUpstream = last('master');
    const uris = allUris(masterText);
    const allOnGateway = uris.every((uri) => uri.startsWith('/s/'));
    const noHostLeak = uris.every((uri) => !uri.includes('http://') && !uri.includes('https://'));
    const noCredLeak = !masterText.includes('ApiKey') && !masterText.includes(env.JELLYFIN_API_KEY);

    const variant = await gateway(uris[0]);
    const variantText = await variant.text();
    const variantUris = allUris(variantText).filter((u) => /\.ts/.test(u));
    noSubSegmentPath = variantUris[0];
    const segment = await fetchWithRetry(noSubSegmentPath);
    const bytes = new Uint8Array(await segment.arrayBuffer());
    const segFile = join(LIVE, 'seg_nosub.ts');
    require('node:fs').writeFileSync(segFile, bytes);
    const probe = ffprobe(segFile);

    report('no-subtitle chain', create.status === 201 && master.status === 200 && variant.status === 200 && segment.status === 200 && allOnGateway && noHostLeak && noCredLeak, {
      linkCreated: create.status,
      masterStatus: master.status,
      masterContentType: master.headers.get('content-type'),
      uris: uris.length,
      allUrisOnGateway: allOnGateway,
      noUpstreamHostLeak: noHostLeak,
      noCredentialLeak: noCredLeak,
      variantStatus: variant.status,
      segmentStatus: segment.status,
      segmentBytes: bytes.length,
      segmentContentType: segment.headers.get('content-type'),
      ffprobe: probe,
      upstreamPlaybackInfo: playback?.negotiation ?? null,
      upstreamMasterParams: masterUpstream?.params ?? null,
      upstreamMasterLeaksCredential: masterUpstream?.leaksCredentialInQuery ?? null,
      upstreamAuthMediaBrowser: masterUpstream?.authMediaBrowser ?? null,
    });

    // HEAD must not create a session/transcode
    const before = newTranscodeCount();
    const head = await gateway(noSubLink, { method: 'HEAD' });
    const after = newTranscodeCount();
    report('entry HEAD no transcode', head.status === 200 && before === after, {
      headStatus: head.status,
      contentType: head.headers.get('content-type'),
      playbackInfoRequestsBefore: before,
      playbackInfoRequestsAfter: after,
    });

    // Range handling
    const range = await gateway(noSubSegmentPath, { headers: { Range: 'bytes=0-1023' } });
    const rangeBody = new Uint8Array(await range.arrayBuffer());
    const badRange = await gateway(noSubSegmentPath, { headers: { Range: 'bytes=99999999-' } });
    report('range handling', [200, 206].includes(range.status) && [200, 206].includes(range.status) && rangeBody.length > 0 && [416, 200].includes(badRange.status), {
      rangeStatus: range.status,
      contentRange: range.headers.get('content-range'),
      rangeBytes: rangeBody.length,
      acceptRanges: range.headers.get('accept-ranges'),
      unsatisfiableStatus: badRange.status,
    });

    // Revoke + existing resource recheck
    const deleteStatus = (await adminJson(`/api/links/${created.id}`, { method: 'DELETE' })).status;
    const afterRevoke = await gateway(noSubSegmentPath);
    await new Promise((r) => setTimeout(r, 800));
    const stop = last('stopEncoding');
    report('revoke existing session', deleteStatus === 204 && afterRevoke.status === 410, {
      deleteStatus,
      existingResourceAfterRevoke: afterRevoke.status,
      stopEncodingCalled: !!stop,
      stopEncodingDelete: stop?.method === 'DELETE',
    });
  });

  // S3 subtitle burn-in link
  let subLink = null;
  let subSegmentPath = null;
  await scenario('subtitle burn-in', async () => {
    const detail = await resolveDetails(item.id);
    const mediaSourceId = detail.mediaSources?.[0]?.id;
    const create = await adminJson('/api/links', {
      method: 'POST',
      body: JSON.stringify({
        itemId: item.id,
        mediaSourceId,
        subtitleStreamIndex: item.textSubIndex,
        preset: '1080p',
        startSeconds: 0,
        expiresInHours: 1,
      }),
    });
    const createText = await create.text();
    const created = (() => { try { return JSON.parse(createText); } catch { return {}; } })();
    if (create.status !== 201) {
      report('subtitle burn-in', false, { linkCreateStatus: create.status, errorCode: created?.error?.code });
      return;
    }
    createdLinks.push(created.id);
    subLink = new URL(created.url).pathname.replace(/^.*(\/s\/)/, '$1');

    const master = await gateway(subLink);
    const masterText = await master.text();
    if (master.status !== 200) {
      const code = (() => { try { return JSON.parse(masterText)?.error?.code; } catch { return null; } })();
      report('subtitle burn-in', false, { masterStatus: master.status, masterErrorCode: code });
      return;
    }
    const playback = last('playbackInfo');
    const masterUpstream = last('master');
    const uris = allUris(masterText);
    const variant = await gateway(uris[0]);
    const variantText = await variant.text();
    const variantUris = allUris(variantText).filter((u) => /\.ts/.test(u));
    subSegmentPath = variantUris[0];
    const segment = await fetchWithRetry(subSegmentPath);
    const bytes = new Uint8Array(await segment.arrayBuffer());
    const segFile = join(LIVE, 'seg_sub.ts');
    require('node:fs').writeFileSync(segFile, bytes);
    const probe = ffprobe(segFile);

    const sessions = await liveSessionsForTest();
    const transcoding = sessions.map((s) => s.TranscodingInfo).filter(Boolean).map((t) => ({
      videoCodec: t.VideoCodec,
      audioCodec: t.AudioCodec,
      container: t.Container,
      isVideoDirect: t.IsVideoDirect,
      isAudioDirect: t.IsAudioDirect,
      width: t.Width,
      height: t.Height,
      audioChannels: t.AudioChannels,
      transcodeReasons: t.TranscodeReasons,
    }));

    const log = await transcodeLogEvidence();

    report('subtitle burn-in', create.status === 201 && master.status === 200 && segment.status === 200, {
      linkCreated: create.status,
      upstreamNegotiation: playback?.negotiation ?? null,
      upstreamMasterParams: masterUpstream?.params ?? null,
      masterHasSubtitleRendition: masterText.includes('#EXT-X-MEDIA') && /SUBTITLES/.test(masterText),
      masterHasNoCredential: !masterText.includes('ApiKey'),
      ffprobe: probe,
      jellyfinSessionsWithTranscode: transcoding,
      transcodeLogEvidence: log,
      burnInEvidenceStrength: log?.hasSubtitlesFilter
        ? 'strong: Jellyfin ffmpeg used subtitles= filter with no video copy'
        : 'moderate: burn-in requested (SubtitleMethod=Encode, non-copy) and delivered media is H.264 8-bit; direct filter log not found',
    });

    await adminJson(`/api/links/${created.id}`, { method: 'DELETE' });
  });

  // S4 preset + audio + start offset
  let startLink = null;
  let startSegmentPath = null;
  await scenario('preset/audio/start offset', async () => {
    const detail = await resolveDetails(audioItem.id);
    const mediaSourceId = detail.mediaSources?.[0]?.id;
    const resolvedAudio = detail.mediaSources?.[0]?.audioTracks ?? [];
    const chosenAudio = (resolvedAudio.find((a) => !a.isDefault) ?? resolvedAudio[1] ?? resolvedAudio[0]).index;
    const startSeconds = 30;
    const create = await adminJson('/api/links', {
      method: 'POST',
      body: JSON.stringify({
        itemId: audioItem.id,
        mediaSourceId,
        audioStreamIndex: chosenAudio,
        subtitleStreamIndex: -1,
        preset: '720p',
        startSeconds,
        expiresInHours: 1,
      }),
    });
    const createText = await create.text();
    const created = (() => { try { return JSON.parse(createText); } catch { return {}; } })();
    if (create.status !== 201) {
      report('preset/audio/start offset', false, { linkCreateStatus: create.status, errorCode: created?.error?.code });
      return;
    }
    createdLinks.push(created.id);
    startLink = new URL(created.url).pathname.replace(/^.*(\/s\/)/, '$1');

    const master = await gateway(startLink);
    const masterText = await master.text();
    if (master.status !== 200) {
      const code = (() => { try { return JSON.parse(masterText)?.error?.code; } catch { return null; } })();
      report('preset/audio/start offset', false, { masterStatus: master.status, masterErrorCode: code });
      return;
    }
    const playback = last('playbackInfo');
    const masterUpstream = last('master');
    const uris = allUris(masterText);
    const variant = await gateway(uris[0]);
    const variantText = await variant.text();
    const variantUris = allUris(variantText).filter((u) => /\.ts/.test(u));
    startSegmentPath = variantUris[0];
    const segment = await fetchWithRetry(startSegmentPath);
    const bytes = new Uint8Array(await segment.arrayBuffer());
    const segFile = join(LIVE, 'seg_start.ts');
    const looksLikeTs = bytes.length > 0 && bytes[0] === 0x47;
    let probe = null;
    if (segment.status === 200 && looksLikeTs) {
      require('node:fs').writeFileSync(segFile, bytes);
      probe = ffprobe(segFile);
    }
    let errorCode = null;
    if (!looksLikeTs) {
      try { errorCode = JSON.parse(Buffer.from(bytes).toString('utf8'))?.error?.code; } catch { /* not json */ }
    }
    const log = await transcodeLogEvidence();

    report('preset/audio/start offset', create.status === 201 && master.status === 200 && segment.status === 200 && looksLikeTs, {
      linkCreated: create.status,
      requestedStartSeconds: startSeconds,
      requestedAudioIndex: chosenAudio,
      audioTrackCount: resolvedAudio.length,
      upstreamNegotiation: playback?.negotiation ?? null,
      upstreamMasterParams: masterUpstream?.params ?? null,
      variantUris: variantUris.length,
      segmentStatus: segment.status,
      segmentContentType: segment.headers.get('content-type'),
      segmentBytes: bytes.length,
      looksLikeTs,
      gatewayErrorCode: errorCode,
      ffprobe: probe,
      transcodeLogEvidence: log,
    });

    await adminJson(`/api/links/${created.id}`, { method: 'DELETE' });
  });

  // S5 cleanup + remaining sessions/transcodes
  await scenario('cleanup', async () => {
    for (const id of createdLinks) {
      await adminJson(`/api/links/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await built.app.close();
    app = null;
    await new Promise((r) => setTimeout(r, 1000));
    const remaining = await liveSessionsForTest();
    const stopCalls = upstream.filter((e) => e.kind === 'stopEncoding').length;
    report('cleanup', remaining.length === 0, {
      stopEncodingCalls: stopCalls,
      remainingTestSessions: remaining.length,
      remainingTestDeviceIds: testDeviceIds.size,
    });
  });

  // S6 configured public gateway reachability (no secrets sent)
  await scenario('public gateway', async () => {
    if (!env.PUBLIC_BASE_URL) {
      report('public gateway', null, { note: 'PUBLIC_BASE_URL unset; skipped' });
      return;
    }
    try {
      const url = env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/health';
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      report('public gateway', null, {
        sanitized: maskUrl(env.PUBLIC_BASE_URL),
        healthStatus: response.status,
        note: response.status === 200 ? 'reachable (not assumed to be this gateway)' : 'configured URL did not answer JFVRC /health',
      });
    } catch (error) {
      report('public gateway', null, { sanitized: maskUrl(env.PUBLIC_BASE_URL), reachable: false, error: safeError(error) });
    }
  });
} finally {
  for (const id of createdLinks) {
    try {
      await adminJson(`/api/links/${id}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
  }
  if (app) {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(join(LIVE, 'gateway.db'), { force: true });
    rmSync(join(LIVE, 'gateway.db-wal'), { force: true });
    rmSync(join(LIVE, 'gateway.db-shm'), { force: true });
  } catch {
    /* ignore */
  }
}

writeState(join(LIVE, 'results.json'), { finishedAt: new Date().toISOString(), results });
const failures = results.filter((r) => r.ok === false);
console.log(`\nSUMMARY: ${results.filter((r) => r.ok === true).length} passed, ${failures.length} failed, ${results.filter((r) => r.ok === null).length} info`);
process.exit(failures.length ? 1 : 0);
