# JFVRC independent integration verification

Verifier: independent agent (DeepSeek V4.1 Flash via Fireworks). Date: 2026-09-12.
Scope: integration verification of the finished backend + frontend against the
architecture contract and the primary-source Jellyfin findings in
`.tasks/design-review.md`. No deploy, no commit, no contact with any real
Jellyfin host.

Artifacts added by this verifier (owned):

- `tests/verification/support/mockJellyfin.ts` — realistic mock upstream
  (BaseItemDto, PlaybackInfoResponse, DynamicHls master/main/segment routes,
  `Videos/ActiveEncodings`, field-gated vs default-field DTO behavior, ranges,
  hangs, redirects, hostile refs), recording every upstream request.
- `tests/verification/support/harness.ts` — wires `buildApp` to the mock.
- `tests/verification/{api-contract,playback-negotiation,manifest-rewrite,trust-boundaries,lifecycle,streaming,production-serving}.test.ts`
  (42 tests).
- `src/client/types.ts` now re-exports the shared contract (drift removed).
- `tsconfig.json` includes `tests/verification`; `vitest.config.ts` already did.
- Fixes below in `src/server/{jellyfin,playback,manifest}.ts` + regressions.

## Final commands and results (all exit 0)

```
npm run typecheck   # server + client + tests/verification: clean
npm test            # Test Files 11 passed (11); Tests 72 passed (72)
npm run build       # vite dist/client + tsc dist/server: clean
docker build -t jfvrc:verify2 .   # multi-stage image built
docker run ... jfvrc:verify2      # /health 200, SPA /links 200,
                                  # /api/nope 404 json, /s/nope/master.m3u8 404 json
```

The combined backend and independent verification suites total 72 passing
tests. No lint tool is configured in the repo.

## Findings and fixes (real bugs)

### F1 (playback blocker, fixed) — saved start position lost for HLS
Jellyfin's `StreamInfo.ToUrl` emits `StartTimeTicks` only for non-HLS targets;
for HLS it emits `SegmentContainer`/`SegmentLength`/`MinSegments` instead. The
gateway preserved the negotiated URL but never added `StartTimeTicks`, so a link
created with `startSeconds > 0` would always start the transcode at 0.
Fix: `JellyfinClient.enforceTranscodeParams` now sets `StartTimeTicks` from the
saved start seconds when absent.
Regression: `playback-negotiation.test.ts` "honours the saved start position and
audio track on the master request".
Primary source: `MediaBrowser.Model/Dlna/StreamInfo.cs` (`ToUrl`) and
`Jellyfin.Api/Controllers/DynamicHlsController.cs`.

### F2 (deployment correctness, fixed) — PUBLIC_BASE_URL sub-path ignored in manifests
Rewritten manifest URIs were root-absolute (`/s/...`), so when `PUBLIC_BASE_URL`
includes a mount path (e.g. `https://host/jfvrc`) the generated link path was
correct but every variant/segment URI resolved to the wrong root.
Fix: `PlaybackManager` derives the public base path and prefixes every
client-facing resource URI; the reverse proxy is expected to strip the prefix
before Fastify (link URLs and resource URLs now agree).
Regression: `manifest-rewrite.test.ts` "prefixes rewritten resource URIs when
PUBLIC_BASE_URL has a sub-path".

### F3 (HLS validity, fixed) — dangling subtitle group reference
Dropping `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions (subtitles are burned in) left
`SUBTITLES="subs"` on `#EXT-X-STREAM-INF`, a dangling reference (RFC 8216).
Fix: `manifest.ts` strips the `SUBTITLES="..."` attribute from stream-inf lines
after dropping the group.
Regression: `manifest-rewrite.test.ts` asserts no `SUBTITLES=` remains.

### F4 (mock fidelity correction) — `Items/{itemId}` already returns MediaSources
An intermediate verifier/mock asserted that `GET /Items/{id}` needs
`fields=MediaSources`. Primary source shows `UserLibraryController.GetItem`
uses `new DtoOptions()`, whose default constructor is `: this(true)` (ALL
fields), so real Jellyfin always returns `MediaSources` on the single-item
route. The backend's added `&fields=MediaSources` is harmless (ignored by that
route). The mock was corrected to match Jellyfin instead of failing the backend
falsely. (The library list route uses explicit `Fields` and does not need
MediaSources, which the app does not consume there.)

## Verified behaviors (no change needed)

- **Negotiation**: `EnableDirectPlay=false`, `EnableDirectStream=false`,
  `EnableTranscoding=true`, `AllowVideo/AudioStreamCopy=false`,
  `AlwaysBurnInSubtitleWhenTranscoding=true` when a subtitle is selected,
  `SubtitleStreamIndex=-1` + `SubtitleMethod=Drop` for None, and explicit
  `SubtitleStreamIndex` + `SubtitleMethod=Encode` when selected.
- **Device profile**: TS/HLS, `h264`/`aac`, `Context=Streaming`,
  `EnableSubtitlesInManifest=false`, `MaxAudioChannels=2`, and a
  `VideoBitDepth <= 8` codec condition.
- **Auth**: upstream `Authorization: MediaBrowser ... Token="<API key>"`
  (no credentials in URLs); configured `JELLYFIN_USER_ID` passed explicitly;
  API key / user token not present in `/api/status`, link listings or manifests.
- **Credential stripping**: `ApiKey`/`api_key`/`X-Emby-Token`/`Token` stripped
  case-insensitively from the negotiated URL and every manifest reference.
- **Base-path resolution**: root-relative TranscodingUrl with and without the
  `/jellyfin` prefix and absolute URLs under the base path all resolve to the
  correct upstream master.
- **Trickplay/subtitles**: `enableTrickplay=false` sent upstream; subtitle and
  trickplay renditions never reach clients; manifest URIs only point at `/s/`.
- **Cleanup scoping**: `DELETE /Videos/ActiveEncodings` uses the *effective*
  DeviceId from the negotiated URL plus the returned PlaySessionId; distinct per
  session; never stops by device alone.
- **Trust boundaries**: foreign origins, userinfo, unsafe schemes,
  protocol-relative URIs, plain and percent-encoded traversal, and redirects off
  the configured origin are rejected; no upstream URL/credential leaks in
  errors or manifests.
- **Streaming**: HEAD on the entry link opens no session and starts no transcode;
  HEAD/OPTIONS on resources; CORS for players; `206` with `Content-Range` and
  `416`; client disconnect aborts the upstream transfer (fetch resolves at
  headers, the body stream errors — correct non-buffering behavior) and the
  service stays healthy; missing segments surface as an upstream failure.
- **Lifecycle**: expiry and revocation return `410` for existing session
  resources; forged token/session/resource combinations return `404`; links and
  revocations persist across a store restart; concurrent consumers get
  independent sessions; the global session cap returns `503`.
- **API contract**: health without auth; bearer auth on all `/api`; resolve from
  id or details URL; episode mapping; library pagination with validation and
  totals; media-source/audio/subtitle/start/expiry validation; list/revoke;
  unknown `/api` returns JSON `404` (never the SPA).
- **Production**: `dist/client` served with SPA fallback for non-reserved GETs;
  `/api`, `/s`, `/health` are never swallowed by the fallback; Docker image
  builds and serves correctly; `.dockerignore` excludes `node_modules`/`dist`/
  `.env`.
- **Frontend/API type compatibility**: client types now re-export
  `src/shared/contracts.ts`; client and shared typecheck together.

## Residual observations (low severity, not fixed)

- After upstream headers arrive there is no idle read timeout on the binary
  body; a client that stays connected to a stalled upstream could hold a
  connection until it disconnects. `UPSTREAM_TIMEOUT_SECONDS` covers
  connect/headers only.
- A missing upstream segment is surfaced as `502 upstream_unavailable` rather
  than `404`; both are acceptable upstream-failure responses.
- `fetchManifest` does not assert the upstream content type; a 200 HTML error
  page would fail manifest validation rather than being relayed, which is fail-safe.

## Untested limits (require real Jellyfin/players; not run)

- Live Jellyfin negotiation, H.264 8-bit/AAC MPEG-TS transcode and subtitle
  burn-in for SRT/ASS and image-based (PGS/DVD) subtitles.
- VLC and VRChat PC/Quest playback, seek/reopen, concurrent consumers,
  custom/allow-listed URLs, and hardware (CPU/GPU) burn-in load.
- Reverse proxy/HTTPS behavior (sub-path support is unit/integration tested but
  not exercised behind a real proxy), and 7-day expiry behavior.
- `README.md` contains the live smoke-test guide and marks these as not run.
