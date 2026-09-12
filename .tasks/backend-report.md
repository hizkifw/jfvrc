# JFVRC backend handoff report

Agent: DeepSeek V4.1 Flash (Fireworks). Scope: backend/shared, root package/build
config, `tests/server`, Docker/env/README. No frontend files modified; no deploy,
no commit, no real Jellyfin contact.

## What was built

Single npm project (Node 22+, TypeScript, Fastify 5, better-sqlite3, Zod,
Vitest) that compiles a React/Vite client bundle and the Fastify server.

- `src/shared/contracts.ts` — normalized API contract shared with the frontend.
- `src/server/config.ts` — strict env parsing/validation, Jellyfin origin +
  base path derivation, link/session/timeout limits.
- `src/server/store.ts` — SQLite link store (durable), token hashing, summaries.
- `src/server/jellyfin.ts` — REST adapter: `GET /Items/:id?fields=MediaSources`,
  library search, `PlaybackInfo` negotiation, device profile, credential
  stripping, validated redirects, `DELETE /Videos/ActiveEncodings`.
- `src/server/urls.ts` — origin/base-path/namespace validation, safe reference
  resolution, credential stripping, traversal/encoded-URI rejection.
- `src/server/manifest.ts` — HLS rewriter (variant, segment, `URI`/`SERVER-URI`
  attributes across MEDIA/KEY/MAP/PART/PRELOAD-HINT/RENDITION/I-FRAME), drops
  subtitle renditions and trickplay, preserves tags/newlines/query.
- `src/server/playback.ts` — in-memory session manager, per-session device IDs,
  resource dedupe/bounding, playlist+binary proxy with ranges/backpressure/
  client-abort, idle sweep, revoke/shutdown cleanup scoped to effective
  DeviceId + PlaySessionId.
- `src/server/app.ts` — app factory (injectable fetch/store), bearer auth on
  `/api/*`, full API, `/s` media routes with CORS, JSON errors, static SPA
  serving that never swallows `/api`, `/s`, `/health`.
- `src/server/index.ts` — bootstrap, sanitized logging (no request URLs/tokens),
  graceful shutdown.
- Root configs: `package.json` (all scripts + React/Vite deps), `tsconfig*.json`,
  `vitest.config.ts` (includes `tests/server` and `tests/verification`),
  `.env.example`, `Dockerfile` (multi-stage), `compose.yaml`, `README.md`,
  `.gitignore`, `.dockerignore`.
- Tests: `tests/server/mock-jellyfin.ts` + 23 tests across
  `manifest`, `urls`, `integration`, `persistence`.

## Design-review corrections applied

- ApiKey / api_key / X-Emby-Token / Token stripped case-insensitively from the
  negotiated URL and from every rewritten manifest reference.
- Root-relative TranscodingUrl resolved beneath the configured base path.
- `Authorization: MediaBrowser ... Token="..."` used; configured UserId passed
  explicitly; legacy token query not used.
- `EnableSubtitlesInManifest=false`, `enableTrickplay=false` on the upstream
  master, explicit `subtitleStreamIndex=-1` for None; selected subtitles force
  `SubtitleStreamIndex` + `SubtitleMethod=Encode` with no video/audio copy.
- Cleanup uses the effective DeviceId taken from Jellyfin's negotiated URL plus
  the returned PlaySessionId (never device alone).
- `getItem` requests `fields=MediaSources` (Jellyfin gates MediaSources on it) —
  this was the real cause of link-creation failures.

## Commands and results

```
npm install                                  # 252 packages; approved better-sqlite3/esbuild build scripts
npm run typecheck                            # server + client tsc: exit 0
npm test                                     # 69 passed, 1 failed (see below)
npm run build                                # vite build + tsc: dist/client + dist/server: exit 0
docker build -t jfvrc:test .                 # multi-stage image built successfully
docker run ... jfvrc:test                     # /health ok, /api/status ok, / serves SPA: exit 0
node dist/server/index.js (smoke)             # /health, /api/status, SPA fallback, asset, API 404 verified
```

The one failing test is the verifier's
`tests/verification/streaming.test.ts > aborts the upstream transfer when the
player disconnects`. It calls `fetch()` and, after response headers have been
received, aborts and expects the fetch promise to reject. Node/undici resolves
`fetch` at headers; aborting afterwards errors the response *body* (the captured
Response shows `body.state === 'errored'`), which is exactly the correct
streaming behaviour. The implementation does abort the upstream transfer on
client disconnect and stays healthy (verified) — passing the assertion would
require buffering entire segments before responding, which the architecture
forbids. Flagging for the integration verifier to reconcile.

## Remaining limits / untested

- Live Jellyfin and real players (VLC, VRChat PC/Quest) were not contacted; the
  README contains the manual smoke-test guide and is marked not-run.
- The device profile/negotiation parameters follow primary Jellyfin source and
  the independent design review, but only mock-upstream integration was run.
- No lint tool is configured in the repo.
- Sessions are in memory by design; they end at restart while durable links
  survive (covered by the persistence test).
