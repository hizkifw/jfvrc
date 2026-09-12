/** Masked diagnosis of the real PlaybackInfo TranscodingUrl shape. */
import { createRequire } from 'node:module';
import { loadEnv, makeJellyfin, safeError } from './lib.mjs';

const ROOT = '/home/kitsune/workspace/jfvrc';
const require = createRequire(import.meta.url);
const env = loadEnv();
const { base, jget } = makeJellyfin(env);
const state = JSON.parse(require('node:fs').readFileSync(`${ROOT}/.tasks/live/state.json`, 'utf8'));
const item = state.subItem;

function maskIds(text, ids) {
  let out = String(text);
  for (const id of ids) {
    if (!id) continue;
    out = out.split(id).join('{ID}');
  }
  return out;
}

const detail = await jget(`/Items/${item.id}?userId=${env.JELLYFIN_USER_ID}&fields=MediaSources`);
const source = detail.MediaSources?.[0];
const sourceId = source?.Id;
console.log('item vs source: same=' + String((item.id ?? '').toLowerCase() === (sourceId ?? '').toLowerCase()) + ' itemLen=' + (item.id ?? '').length + ' sourceLen=' + (sourceId ?? '').length);

const { buildDeviceProfile } = require(`${ROOT}/dist/server/jellyfin.js`);
const body = {
  UserId: env.JELLYFIN_USER_ID,
  MediaSourceId: sourceId,
  SubtitleStreamIndex: item.textSubIndex,
  StartTimeTicks: 0,
  MaxStreamingBitrate: 8_000_000,
  MaxAudioChannels: 2,
  EnableDirectPlay: false,
  EnableDirectStream: false,
  EnableTranscoding: true,
  AllowVideoStreamCopy: false,
  AllowAudioStreamCopy: false,
  AlwaysBurnInSubtitleWhenTranscoding: true,
  DeviceProfile: buildDeviceProfile('1080p'),
};

const response = await fetch(`${base}/Items/${item.id}/PlaybackInfo?userId=${env.JELLYFIN_USER_ID}`, {
  method: 'POST',
  headers: {
    Authorization: `MediaBrowser Client="JFVRC-debug", Device="d", DeviceId="debug-device", Version="1.0.0", Token="${env.JELLYFIN_API_KEY}"`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
console.log('playbackInfo status=' + response.status);
const raw = await response.json();
const ms = (raw.MediaSources ?? []).find((s) => s.Id === sourceId) ?? raw.MediaSources?.[0];
if (!ms) {
  console.log('no media source in response; errorCode=' + (raw.ErrorCode ?? '?'));
} else {
  const url = ms.TranscodingUrl;
  console.log('hasTranscodingUrl=' + !!url + ' supportsTranscoding=' + String(ms.SupportsTranscoding));
  if (url) {
    try {
      const u = new URL(url, base);
      console.log('masked path=' + maskIds(u.pathname, [item.id, sourceId]));
      console.log('isAbsolute=' + /^https?:/i.test(url) + ' startsWithSlash=' + url.startsWith('/'));
      console.log('queryParamNames=' + [...u.searchParams.keys()].sort().join(','));
      console.log('hasApiKey=' + (u.searchParams.has('ApiKey') || u.searchParams.has('api_key')));
      console.log('deviceIdEqualsSource=' + String(u.searchParams.get('DeviceId') === sourceId));
      console.log('subtitleMethod=' + u.searchParams.get('SubtitleMethod') + ' subtitleIndex=' + u.searchParams.get('SubtitleStreamIndex'));
    } catch (error) {
      console.log('url parse failed: ' + safeError(error));
    }
  }
  console.log('defaultAudioStreamIndex=' + ms.DefaultAudioStreamIndex + ' defaultSubtitleStreamIndex=' + ms.DefaultSubtitleStreamIndex);
}
