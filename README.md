# JFVRC

JFVRC turns a Jellyfin movie or episode details link into a revocable HLS URL
that plays without cookies or custom headers. Jellyfin does all transcoding and
burns subtitles; JFVRC negotiates playback and relays the manifest and media
segments through stable, opaque URLs.

It is built for one household/operator and one configured Jellyfin server.

> Anyone who has a playback URL can watch until it expires or is revoked.
> Treat links as secrets. Use HTTPS (an external reverse proxy in front of
> JFVRC) whenever links leave your local network.

## Features

- Resolve a Jellyfin details URL or item id, or search the library.
- Pick media source, audio track, subtitle track, a `1080p`/`720p` preset,
  optional start position and link lifetime.
- Generates a shareable link of the form
  `https://<public-base>/s/<token>/master.m3u8`.
- Rewrites Jellyfin master/media playlists recursively so keys, init maps,
  variant playlists and segments all stay on JFVRC; upstream credentials never
  reach clients.
- Revocable, expiring links stored in SQLite; tokens are only stored hashed and
  the full URL is shown once at creation.
- Concurrent consumers get independent Jellyfin play sessions.
- Media endpoints support `GET`/`HEAD`/`OPTIONS`, byte ranges and CORS so
  players such as VLC and VRChat can consume them.

## Quick start (Docker Compose)

1. Copy `.env.example` to `.env` and fill in `ADMIN_TOKEN`, `JELLYFIN_URL`,
   `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID` and `PUBLIC_BASE_URL`.
2. Run:

   ```sh
   docker compose up --build -d
   ```

3. Open the UI at the address in `PUBLIC_BASE_URL` (default
   `http://localhost:3000`), paste the admin token and create a link.

The SQLite database lives on the `jfvrc-data` volume at `/data/jfvrc.db`, so
links survive container restarts. Export `/data` as part of your backups.

## Local development

```sh
npm install
cp .env.example .env        # then edit
npm run dev                 # Fastify on :3000 + Vite on :5173
```

Vite proxies `/api`, `/health` and `/s` to `http://localhost:3000`.

Other scripts:

```sh
npm run typecheck   # server + client TypeScript
npm test            # Vitest integration/unit tests (mock Jellyfin)
npm run build       # client bundle (dist/client) + server (dist/)
npm start           # run the compiled server
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | required | Bearer token for all `/api` routes. |
| `JELLYFIN_URL` | required for playback | Jellyfin base URL; may include a `/jellyfin` prefix. No credentials/query/fragment. |
| `JELLYFIN_API_KEY` | required for playback | Jellyfin API key. |
| `JELLYFIN_USER_ID` | required for playback | User whose library/playback is used. |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | External URL used to build playback links. Never derived from request headers. |
| `DATABASE_PATH` | `./data/jfvrc.db` | SQLite file, `/data/jfvrc.db` in Docker. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address. |
| `SESSION_IDLE_TTL_SECONDS` | `600` | Idle playback session lifetime. |
| `MAX_ACTIVE_SESSIONS` | `12` | Global cap on concurrent sessions. |
| `LINK_DEFAULT_EXPIRY_HOURS` | `24` | Default link lifetime. |
| `LINK_MAX_EXPIRY_HOURS` | `168` | Maximum link lifetime (7 days). |
| `UPSTREAM_TIMEOUT_SECONDS` | `30` | Timeout to connect to Jellyfin / receive headers. |
| `LOG_LEVEL` | `info` | Log level. Request URLs and tokens are never logged. |

## API

All `/api/*` routes require `Authorization: Bearer <ADMIN_TOKEN>`.
The webpage and `/health` are public. Playback routes authorize with the link
token in their path; players need no admin token, cookies, or custom headers.
Errors are `{ "error": { "code": string, "message": string } }`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | `{status:'ok'}`. |
| `GET` | `/api/status` | Configured state and sanitized URLs. |
| `POST` | `/api/resolve` | `{input}` → normalized `ItemDetails`. |
| `GET` | `/api/library?query=&startIndex=&limit=` | `{items,total}`. |
| `GET` | `/api/items/:id` | Normalized `ItemDetails`. |
| `POST` | `/api/links` | Create a link; returns `{id,url,expiresAt,title}`. |
| `GET` | `/api/links` | List link summaries (no URLs/tokens). |
| `DELETE` | `/api/links/:id` | Revoke link and stop its sessions. |
| `GET/HEAD/OPTIONS` | `/s/:token/master.m3u8` | GET opens a session; HEAD checks the link without starting playback; OPTIONS handles CORS. |
| `GET/HEAD/OPTIONS` | `/s/:token/p/:sessionId/:resourceId/:filename` | Proxied playlist/segment. |

Shared request/response types live in `src/shared/contracts.ts`.

## Deployment notes

- Put a reverse proxy with a valid TLS certificate in front of JFVRC and set
  `PUBLIC_BASE_URL` to that HTTPS origin.
- The reverse proxy should pass `Range` headers through and must not buffer
  media responses; keep timeouts generous for long segments.
- `PUBLIC_BASE_URL` is authoritative. The `Host`/`X-Forwarded-*` headers are
  intentionally ignored when building links.
- JFVRC stores durable link definitions only. Playback sessions and resolved
  upstream resource maps are in memory; after a restart, existing session URLs
  stop working — reopen the `/s/<token>/master.m3u8` link.
- Configure transcoding and GPU access on Jellyfin. JFVRC does not need GPU
  access and does not run ffmpeg.
- A path prefix in `PUBLIC_BASE_URL` is included in generated playback links
  and nested playlist URLs. Your reverse proxy must strip that prefix before
  forwarding playback requests to Fastify. The default management UI is
  served at the origin root.

## Live smoke test guide (not run automatically)

These checks need a real Jellyfin server, credentials and a player; the
automated tests use a mock upstream only.

1. **VLC**: create a link, open `.../s/<token>/master.m3u8` in VLC. Confirm
   playback starts, seeking works, and audio/subtitle choices match the link.
2. **VLC external subtitle formats**: create links selecting SRT, ASS/SSA and
   image-based (PGS/DVD) subtitles. Text subtitles should be burned in; verify
   image-based behavior against your Jellyfin/ffmpeg build.
3. **Reopen and concurrency**: open the link twice simultaneously and confirm
   independent sessions and seeking; also revoke the link and confirm both stop
   and that Jellyfin no longer lists the transcodes.
4. **Range/binary**: `curl -H 'Range: bytes=0-1023' <segment-url> -D -` returns
   `206` with `Content-Range`.
5. **VRChat**: add `PUBLIC_BASE_URL` host to VRChat's trusted URLs if the world
   uses untrusted URLs, then play on PC and Quest. In public/group-public
   instances the world may also need the domain on its allow list.
6. **Expiry/revocation**: create a short-lived link, wait for expiry, confirm
   `410`; revoke another and confirm `410` immediately.
7. **Reverse proxy/HTTPS**: confirm links use the HTTPS origin and play through
   the proxy from outside the LAN.
8. **Hardware burn-in**: verify CPU vs GPU transcode and subtitle burn-in load
   in the Jellyfin dashboard for both presets.

## Limitations (v1)

- Movies and episodes only; no live TV, uploads, multi-tenant accounts, CDN or
  local ffmpeg.
- One configured Jellyfin server.
- No adaptive bitrate ladder; two conservative presets.
- No playback progress reporting.
- Single process; horizontal scaling would need shared sessions/sticky routing.

## License

MIT
