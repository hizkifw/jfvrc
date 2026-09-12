/**
 * Live probe: validates credentials and selects test items.
 * Prints only sanitized metadata (no names, ids, urls-with-creds, or secrets).
 */
import { loadEnv, maskUrl, makeJellyfin, safeError, writeState } from './lib.mjs';

const env = loadEnv();
const STATE = '/home/kitsune/workspace/jfvrc/.tasks/live/state.json';

const required = ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USER_ID', 'ADMIN_TOKEN'];
console.log('env keys present:', required.map((k) => `${k}=${env[k] ? 'yes' : 'NO'}`).join(' '));
console.log('jellyfin url (sanitized):', env.JELLYFIN_URL ? maskUrl(env.JELLYFIN_URL) : 'MISSING');
console.log('public base url (sanitized):', env.PUBLIC_BASE_URL ? maskUrl(env.PUBLIC_BASE_URL) : 'unset');

const { base, jget } = makeJellyfin(env);

try {
  const pub = await jgetRaw('/System/Info/Public');
  console.log('public system:', `product=${pub.ProductName ?? '?'} version=${pub.Version ?? '?'} startupWizardCompleted=${pub.StartupWizardCompleted}`);
} catch (error) {
  console.log('public system: FAILED', safeError(error));
}

async function jgetRaw(path) {
  const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
  if (!response.ok) {
    const e = new Error('failed');
    e.status = response.status;
    throw e;
  }
  return response.json();
}

try {
  const info = await jget('/System/Info');
  console.log('authenticated system: version=' + (info.Version ?? '?') + ' serverName=' + (info.ServerName ? '[redacted]' : '?') + ' operatingSystem=' + (info.OperatingSystem ?? '?'));
} catch (error) {
  console.log('authenticated system: FAILED', safeError(error));
}

try {
  const user = await jget(`/Users/${env.JELLYFIN_USER_ID}`);
  console.log('configured user: exists=true name=' + (user.Name ? '[redacted]' : '?') + ' disabled=' + String(user.Policy?.IsDisabled ?? '?'));
} catch (error) {
  console.log('configured user: FAILED', safeError(error));
}

let candidates = [];
try {
  const query = new URLSearchParams({
    userId: env.JELLYFIN_USER_ID,
    recursive: 'true',
    includeItemTypes: 'Movie,Episode',
    limit: '80',
    sortBy: 'SortName',
    sortOrder: 'Ascending',
    fields: 'MediaSources',
    enableImages: 'false',
    enableTotalRecordCount: 'true',
  });
  const result = await jget(`/Items?${query.toString()}`);
  const items = result.Items ?? [];
  console.log(`library search: total=${result.TotalRecordCount ?? '?'} returned=${items.length}`);

  candidates = items.map((item, index) => {
    const sources = item.MediaSources ?? [];
    const source = sources[0];
    const streams = source?.MediaStreams ?? [];
    const video = streams.find((s) => s.Type === 'Video');
    const audio = streams.filter((s) => s.Type === 'Audio');
    const subs = streams.filter((s) => s.Type === 'Subtitle');
    const textSubs = subs.filter((s) => s.IsTextSubtitleStream !== false && /srt|subrip|ass|ssa|vtt|webvtt|mov_text|ttml/i.test(s.Codec ?? ''));
    const runtimeSec = Math.round((item.RunTimeTicks ?? 0) / 10_000_000);
    return {
      index,
      id: item.Id,
      type: item.Type,
      runtimeSec,
      sourceId: source?.Id,
      container: source?.Container,
      videoCodec: video?.Codec,
      width: video?.Width,
      height: video?.Height,
      bitDepth: video?.BitDepth,
      audioCount: audio.length,
      audioDefault: audio.find((a) => a.IsDefault)?.Index ?? audio[0]?.Index,
      subCount: subs.length,
      textSubCount: textSubs.length,
      textSubIndex: textSubs[0]?.Index,
      textSubCodec: textSubs[0]?.Codec,
      textSubLang: textSubs[0]?.Language,
    };
  });

  for (const c of candidates) {
    console.log(
      `  #${c.index} type=${c.type} runtimeMin=${(c.runtimeSec / 60).toFixed(1)} video=${c.videoCodec} ${c.width}x${c.height}@${c.bitDepth}bit container=${c.container} audio=${c.audioCount} subs=${c.subCount}(text=${c.textSubCount})`,
    );
  }
} catch (error) {
  console.log('library search: FAILED', safeError(error));
}

function pick(list, predicate) {
  return list.find(predicate);
}

const subItem =
  pick(candidates, (c) => c.type === 'Movie' && c.textSubCount > 0 && c.runtimeSec > 120 && c.runtimeSec <= 2400) ??
  pick(candidates, (c) => c.textSubCount > 0 && c.runtimeSec > 120) ??
  pick(candidates, (c) => c.textSubCount > 0);

const audioItem =
  pick(candidates, (c) => c.audioCount > 1 && c.videoCodec === 'h264' && c.bitDepth === 8 && c.runtimeSec > 120 && c.runtimeSec <= 1800 && c.textSubCount > 0) ??
  pick(candidates, (c) => c.audioCount > 1 && c.videoCodec === 'h264' && c.bitDepth === 8 && c.runtimeSec > 120 && c.runtimeSec <= 1800) ??
  pick(candidates, (c) => c.audioCount > 1 && c.runtimeSec > 120 && c.runtimeSec <= 1800) ??
  pick(candidates, (c) => c.audioCount > 1) ??
  subItem ??
  candidates[0];

if (!subItem) {
  console.log('selection: no item with a text subtitle found; live subtitle test will be limited');
} else {
  console.log('selection: subtitle item chosen (sanitized):', JSON.stringify({
    type: subItem.type,
    runtimeMin: Number((subItem.runtimeSec / 60).toFixed(1)),
    video: subItem.videoCodec,
    resolution: `${subItem.width}x${subItem.height}`,
    bitDepth: subItem.bitDepth,
    audioCount: subItem.audioCount,
    textSubIndex: subItem.textSubIndex,
    textSubCodec: subItem.textSubCodec,
    textSubLang: subItem.textSubLang,
  }));
}

writeState(STATE, {
  createdAt: new Date().toISOString(),
  jellyfinVersion: 'probe',
  subItem: subItem ?? null,
  audioItem: audioItem ?? null,
  candidates: candidates.map((c) => ({ type: c.type, runtimeSec: c.runtimeSec })),
});
console.log('state written (sanitized, secret-free).');
