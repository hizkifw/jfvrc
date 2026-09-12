# JFVRC live verification (real Jellyfin)

Verifier: independent agent (DeepSeek V4.1 Flash via Fireworks). Date: 2026-09-12.
User explicitly authorized live verification and normal test transcoding. No
server/user/library settings were changed; no item was marked watched; no
progress was reported; no deploy or commit.

## Tested environment (sanitized)

- Jellyfin Server **10.11.11** over HTTPS on the configured host
  (`jellyfinUrl` reported by `/api/status` as `https://<configured-jellyfin-host>`).
- Configured user exists and is enabled. Library total: 8352 items.
- Gateway: local build of this repo, started on `127.0.0.1:34117` with
  task-only overrides (`PUBLIC_BASE_URL` forced to the loopback gateway,
  `DATABASE_PATH` under `.tasks/live`, 60s upstream timeout). The user's `.env`
  was read in-process only and never modified or printed.
- Media selected from the live library (names/ids withheld): a short
  English-subtitled 10-bit HEVC 1080p episode (subtitle burn-in + 8-bit
  conversion), and a multi-audio H.264 episode (audio selection + start offset).
- Tooling: no host ffprobe/ffmpeg/VLC. A static `mwader/static-ffmpeg` container
  was used for `ffprobe`. Upstream requests were observed via a sanitizing
  in-process `fetch` wrapper (records parameter names/values only, never tokens
  or credentialed URLs). Jellyfin's own transcode log was parsed for ffmpeg
  flags and only booleans/sanitized matches were recorded.

## Scenario outcomes (9 passed, 0 failed)

1. **Auth/status** — `/api/status` without token `401`; with admin bearer `200`
   and `configured=true`; returned URLs sanitized (no credentials).
2. **Resolve/library + source/track mapping** — resolve by raw id and by a
   Jellyfin details URL both `200`; audio/subtitle track counts and indices
   matched the live `MediaStreams`; library search `200` (`total=8352`).
3. **No-subtitle chain** — link `201`; master `200`
   (`application/vnd.apple.mpegurl`); every URI on the gateway namespace, no
   upstream host or credential leakage; variant and first real segment `200`.
   Real relayed media (ffprobe): MPEG-TS, **H.264 High 1920x1080 yuv420p**,
   **AAC LC stereo 48 kHz**, ~6.03s, 3.4 MB. Negotiation sent
   `EnableDirectPlay/DirectStream=false`, `EnableTranscoding=true`,
   `AllowVideo/AudioStreamCopy=false`, `SubtitleStreamIndex=-1`,
   `SubtitleMethod=Drop`, `enableTrickplay=false`, H.264/AAC/TS profile with a
   `VideoBitDepth<=8` condition; no `ApiKey` in the master query.
4. **Entry HEAD** — `200`, playlist content type, empty body, and no
   `PlaybackInfo` call (no session or transcode started).
5. **Binary Range** — `Range: bytes=0-1023` → `206` with
   `Content-Range: bytes 0-1023/3435700` and `Accept-Ranges: bytes`;
   unsatisfiable range → `416`.
6. **Revoke existing session** — `DELETE /api/links/:id` `204`; a previously
   served resource then `410`; upstream
   `DELETE /Videos/ActiveEncodings?deviceId&playSessionId` was called.
7. **Subtitle burn-in (selected ASS track)** — negotiation sent
   `AlwaysBurnInSubtitleWhenTranscoding=true`, `SubtitleStreamIndex=2`,
   `SubtitleMethod=Encode`, no video copy. The rewritten master contained no
   subtitle renditions and no credentials. **Strong evidence:** Jellyfin's own
   ffmpeg log for the job contained a `subtitles=` filter with `-filter_complex`
   and `libx264`, and the relayed segment was H.264 8-bit yuv420p (i.e. the
   video was re-encoded, not copied). Frame-level pixel proof was not performed.
8. **Preset + audio + start offset** — 720p preset and a non-default audio
   index negotiated (`StartTimeTicks=300000000`, `MaxStreamingBitrate=4000000`,
   `AudioStreamIndex=2`). Relayed first segment (ffprobe): **H.264 Main
   1280x720 yuv420p**, **AAC LC stereo**, first PTS **~33.98s** for a requested
   30s start (within one segment); Jellyfin's ffmpeg log showed an `-ss` seek.
9. **Cleanup** — three `ActiveEncodings` stop calls, **0 remaining test
   sessions / device ids**, gateway process stopped, 0 ffmpeg containers.

Configured `PUBLIC_BASE_URL` is `http://localhost:3000`; that host answered
`/health` `200` but is a different local service, so external
reverse-proxy/HTTPS reachability of JFVRC was **not** verified.

## Discovered issues and fixes (real, from live traffic)

### L1 (blocker) — item ids returned as 32-hex but used as dashed UUIDs in HLS paths
Live PlaybackInfo returned `MediaSources[].Id`/`Item.Id` as 32 hex characters,
while the negotiated `TranscodingUrl` path used the dashed UUID form
(`/videos/<dashed>/master.m3u8`). `validateUpstreamUrl` compared the strings
literally and rejected every real negotiation
(`untrusted_path: outside the expected media namespace`), so **no** playback
worked against live 10.11.
Fix: compare canonical, dash-free, lowercase GUIDs in `src/server/urls.ts`
(`canonicalGuid`). Regression in `tests/verification/trust-boundaries.test.ts`
(both spellings accepted, a genuinely different id still rejected).

### L2 (blocker) — `StartTimeTicks` forwarded to segments breaks playback; offset not honored
Jellyfin injects the requested `StartTimeTicks` into the variant playlist's
segment URIs, and `DynamicHlsController.GetDynamicSegment` rejects
`StartTimeTicks > 0` with HTTP 400. Direct masked probe on the live server:

```
variant segment URI contains StartTimeTicks=300000000   (yes)
segment request with StartTimeTicks>0                    -> 400
same segment without StartTimeTicks                      -> 200 (1.6 MB)
```

So any link with `startSeconds > 0` failed to play, and the full playlist always
started at zero.
Fix:
- `manifest.ts` strips `StartTimeTicks` from every child reference.
- `manifest.ts` trims a VOD variant playlist to the requested start position and
  shifts `#EXT-X-MEDIA-SEQUENCE`, so a player that begins at the top of the
  playlist starts at the offset (Jellyfin then seeks using the first requested
  segment's `runtimeTicks`).
- `playback.ts` stores `startTicks` per session and passes it to the rewriter.
Regression: `tests/verification/manifest-offset.test.ts` (trim + sequence shift +
no `StartTimeTicks`; start-at-zero unchanged; offset past the end does not
produce an empty playlist).

## Commands and results (all exit 0)

```
npm run typecheck                 # server + client + verifier tests
npm test                          # Test Files 12 passed (12); Tests 76 passed (76)
npm run build                     # dist/client + dist/server
node .tasks/live/probe.mjs        # sanitized live library/metadata probe
node .tasks/live/verify.mjs       # live end-to-end: 9 passed, 0 failed, 2 info
node .tasks/live/debug-start.mjs  # masked raw-upstream seek diagnosis (L2)
```

## Evidence strength and limits

- **Burn-in: strong.** Proven by Jellyfin's own ffmpeg `subtitles=` filter and a
  non-copied H.264 8-bit output. Not proven by decoded pixels/rendered frames.
- **Seek: good.** `StartTimeTicks` negotiated, first relayed segment PTS ~34s for
  a 30s start (one segment boundary), and `-ss` present in the transcode log.
  Exact player-timeline behavior in a real client was not exercised.
- **Not verified:** VLC and VRChat PC/Quest playback, external subtitle formats
  beyond the selected ASS track, concurrent players, hardware (CPU/GPU) burn-in
  load, HTTPS/reverse-proxy path (configured `PUBLIC_BASE_URL` is a different
  local service), and 7-day expiry.
- Jellyfin `/Sessions` listed no transcode entries because the gateway
  intentionally does not report playback; cleanup was verified instead via the
  scoped `Videos/ActiveEncodings` DELETE calls and zero remaining test sessions.

## Cleanup and hygiene

- All test links revoked; gateway closed (stops child sessions and transcodes);
  no lingering gateway process on the test port; no ffmpeg containers.
- Temporary segment media, item-id state and SQLite files were deleted; the
  remaining `.tasks/live` scripts and sanitized `results.json` contain no
  credentials (verified programmatically: 0 secret occurrences).
- `.env` was not modified (its mtime is unchanged) and remains git-ignored.

## Recommendations

- Set `PUBLIC_BASE_URL` to the actual external gateway origin before sharing
  links; the current value points at a different local service.
- Consider `chmod 600 .env` (currently group/other-readable) since it holds the
  Jellyfin API key and admin token.
- A future client-side smoke test (VLC/VRChat) is still required for player
  compatibility; the server-side pipeline is now verified end-to-end.
