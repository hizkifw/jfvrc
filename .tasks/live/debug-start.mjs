/** Masked direct probe of Jellyfin's HLS seek mechanism (start offset). */
import { createRequire } from 'node:module';
import { loadEnv, makeJellyfin, safeError } from './lib.mjs';

const ROOT = '/home/kitsune/workspace/jfvrc';
const require = createRequire(import.meta.url);
const env = loadEnv();
const { base, jget } = makeJellyfin(env);
const state = JSON.parse(require('node:fs').readFileSync(`${ROOT}/.tasks/live/state.json`, 'utf8'));
const item = state.audioItem;
const { buildDeviceProfile } = require(`${ROOT}/dist/server/jellyfin.js`);

const detail = await jget(`/Items/${item.id}?userId=${env.JELLYFIN_USER_ID}&fields=MediaSources`);
const sourceId = detail.MediaSources?.[0]?.Id;
const audioTracks = (detail.MediaSources?.[0]?.MediaStreams ?? []).filter((s) => s.Type === 'Audio');
const chosenAudio = audioTracks.find((a) => !a.IsDefault)?.Index ?? audioTracks[0]?.Index;
console.log('audioTracks=' + audioTracks.length + ' chosenAudio=' + chosenAudio);

const auth = `MediaBrowser Client="JFVRC-debug", Device="d", DeviceId="debug-start", Version="1.0.0", Token="${env.JELLYFIN_API_KEY}"`;
const body = {
  UserId: env.JELLYFIN_USER_ID,
  MediaSourceId: sourceId,
  AudioStreamIndex: chosenAudio,
  SubtitleStreamIndex: -1,
  StartTimeTicks: 300_000_000,
  MaxStreamingBitrate: 4_000_000,
  MaxAudioChannels: 2,
  EnableDirectPlay: false,
  EnableDirectStream: false,
  EnableTranscoding: true,
  AllowVideoStreamCopy: false,
  AllowAudioStreamCopy: false,
  AlwaysBurnInSubtitleWhenTranscoding: false,
  DeviceProfile: buildDeviceProfile('720p'),
};
const pi = await fetch(`${base}/Items/${item.id}/PlaybackInfo?userId=${env.JELLYFIN_USER_ID}`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const raw = await pi.json();
const ms = raw.MediaSources?.find((s) => s.Id === sourceId) ?? raw.MediaSources?.[0];
let masterUrl = new URL(ms.TranscodingUrl, base);
console.log('transcodingUrl has StartTimeTicks=' + masterUrl.searchParams.get('StartTimeTicks'));

// Mimic our gateway: add StartTimeTicks.
masterUrl.searchParams.set('StartTimeTicks', '300000000');

async function fetchText(url) {
  const r = await fetch(url, { headers: { Authorization: auth } });
  return { status: r.status, text: await r.text(), url: r.url };
}

const master = await fetchText(masterUrl.toString());
console.log('master status=' + master.status);
const variantRef = master.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
const variantUrl = new URL(variantRef, masterUrl);
console.log('variant ref has StartTimeTicks=' + variantUrl.searchParams.get('StartTimeTicks'));

const variant = await fetchText(variantUrl.toString());
console.log('variant status=' + variant.status);
const segLines = variant.text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
console.log('segments=' + segLines.length);
const seg0 = new URL(segLines[0], variantUrl);
console.log('seg0 runtimeTicks=' + seg0.searchParams.get('runtimeTicks') + ' hasStartTimeTicks=' + seg0.searchParams.get('StartTimeTicks'));

const s0 = await fetchText(seg0.toString());
console.log('seg0 status=' + s0.status + ' len=' + s0.text.length + ' ctype=' + (await Promise.resolve('')));
if (s0.status >= 400) console.log('seg0 body(first120)=' + s0.text.slice(0, 120).replace(/\s+/g, ' '));

// Find a segment near 30s.
let target = null;
for (const line of segLines) {
  const u = new URL(line, variantUrl);
  const rt = Number(u.searchParams.get('runtimeTicks') ?? '0');
  if (rt <= 300_000_000 && (!target || rt > target.rt)) target = { rt, url: u };
}
if (target) {
  const st = await fetchText(target.url.toString());
  console.log('targetSegment runtimeTicks=' + target.rt + ' status=' + st.status + ' len=' + st.text.length);
}

// Retry seg0 with StartTimeTicks removed.
const seg0NoStart = new URL(seg0.toString());
seg0NoStart.searchParams.delete('StartTimeTicks');
const s0b = await fetchText(seg0NoStart.toString());
console.log('seg0 without StartTimeTicks status=' + s0b.status + ' len=' + s0b.text.length);
if (s0b.status >= 400) console.log('seg0b body(first120)=' + s0b.text.slice(0, 120).replace(/\s+/g, ' '));
