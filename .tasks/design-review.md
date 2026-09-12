# JFVRC design verification — Jellyfin playback assumptions

Verifier: independent agent (DeepSeek V4.1 Flash). Date: 2026-09-12.
Scope: `docs/architecture.md` playback/negotiation/proxy assumptions validated against
primary Jellyfin source (jellyfin/jellyfin `master`), not the user's host. No implementation
files edited; no deploy/commit.

## Verdict

Overall architecture is sound and correctly chooses server-side negotiation + manifest
rewriting. The flow (PlaybackInfo → TranscodingUrl → rewrite master → serve mapped
segments) matches how Jellyfin actually works. However there are **six concrete playback
blockers / misassumptions** that must be fixed in implementation. Ranked by likelihood of
breaking real playback or leaking credentials.

---

## Blockers and required corrections

### B1 (critical) — Negotiated `TranscodingUrl` embeds a credential in `ApiKey`
`MediaInfoHelper.SetDeviceSpecificData` builds it as
`streamInfo.ToUrl(null, claimsPrincipal.GetToken(), null)`; `StreamInfo.ToUrl` then appends
`&ApiKey=<token>` whenever `accessToken` is non-empty. With API-key auth the token is the
**Jellyfin API key itself**; for a user token it is the user's access token.
- MUST strip `ApiKey`/`api_key` (and any token-bearing knob) from `TranscodingUrl` before
  logging, storing in the resource map, or emitting anywhere.
- Authenticate upstream with a header instead (see B7). The URL's `ApiKey` must never be
  echoed to clients or persisted.
- Preserve the rest of the query: `MediaSourceId`, `DeviceId`, `PlaySessionId`,
  `VideoCodec`, `AudioCodec`, `SubtitleStreamIndex`, `SubtitleMethod`, `SegmentContainer`,
  `TranscodeReasons`, stream options, etc.

### B2 (critical) — Base-path resolution drops a Jellyfin sub-path
`TranscodingUrl` is **relative**, starts with a leading slash, and uses lowercase segments:
`/videos/{itemId}/master.m3u8?...` (or `/audio/...`). `new URL(transcodingUrl, JELLYFIN_URL)`
will discard any `/jellyfin` path prefix. When `JELLYFIN_URL` includes a base path, resolve
by concatenating the configured base path and the relative URL, e.g.
`origin + basePath.replace(/\/$/,'') + transcodingUrl`, then re-validate origin/path.
ASP.NET routing is case-insensitive, so the lowercase `/videos/...` matches the
`Videos/{itemId}/master.m3u8` route.

### B3 (critical) — Relative intra-playlist URIs resolve against the playlist, not our session
Confirmed patterns (all relative, no leading slash):
- Master variant line: bare `main.m3u8?<full master query>`.
- Variant playlist segments: `hls1/main/{n}.ts?<query>&runtimeTicks=<t>&actualSegmentLengthTicks=<t>`.
- fMP4 init: `#EXT-X-MAP:URI="hls1/main/-1.mp4?<query>&runtimeTicks=0&actualSegmentLengthTicks=0"`.
The rewriter must resolve each reference **against the upstream playlist URL** (not against
`/s/:token/...`) before mapping, otherwise it will map the wrong upstream path. Preserve the
full original query semantics. Segment endpoint requires `runtimeTicks` and
`actualSegmentLengthTicks` (`[FromQuery, Required]`) — carry them through.

### B4 (high) — Master playlist can carry API-key-bearing / off-proxy URIs
Even with burn-in, the master may include:
- `#EXT-X-MEDIA:...URI="{mediaSourceId}/Subtitles/{index}/subtitles.m3u8?SegmentLength=30&ApiKey=<token>"`
  (`DynamicHlsHelper.AddSubtitles`), emitted when subtitle delivery is `Hls` **or**
  `TranscodingProfile.EnableSubtitlesInManifest=true`.
- `#EXT-X-IMAGE-STREAM-INF:...URI="Trickplay/{width}/tiles.m3u8?MediaSourceId=...&ApiKey=<token>"`.
  The master endpoint's `enableTrickplay` parameter **defaults to true**, and the negotiated
  `TranscodingUrl` does not disable it.
Required: set `TranscodingProfile.EnableSubtitlesInManifest=false`; append
`enableTrickplay=false` to the upstream master fetch; burn selected subtitles (delivery
`Encode` nulls the subtitle group); and in the rewriter, **reject/strip any tag whose URI
contains a credential**, rather than passing unknown URI tags through.

### B5 (high) — "Subtitle delivery Encode device profile" is not how burn-in works
`StreamBuilder.GetSubtitleProfile` only matches device-profile `Embed`, then `External`/`Hls`.
`Encode` is solely the fallback when nothing else matches; a `SubtitleProfile` with
`Method=Encode` is effectively ignored. `AlwaysBurnInSubtitleWhenTranscoding` is not consulted
there either. Reliable burn-in requires all of:
1. PlaybackInfo body `AlwaysBurnInSubtitleWhenTranscoding=true`;
2. negotiated delivery resolves to `Encode` (do **not** declare a matching `External`/`Hls`
   subtitle profile for the selected codec, so the fallback applies);
3. video is genuinely re-encoded (`AllowVideoStreamCopy=false`, H.264 profile), because
   `ShouldEncodeSubtitle` = `delivery==Encode || (AlwaysBurnIn && !IsCopyCodec(output))`.
Then verify the negotiated URL literally contains `SubtitleStreamIndex=<idx>&SubtitleMethod=Encode`.
Subtlety: `StreamInfo.ToUrl` only appends `SubtitleMethod` when delivery != `External`; an
accidental `External` match would silently stop burn-in. For subtitle `None` (-1), send no
`SubtitleStreamIndex` and do not set `AlwaysBurnIn`.

### B6 (medium) — Force-transcode flags are right, but verify gating
PlaybackInfo body should set `EnableDirectPlay=false`, `EnableDirectStream=false`,
`EnableTranscoding=true`, `AllowVideoStreamCopy=false`, `AllowAudioStreamCopy=false`.
Note Jellyfin already forces `options.EnableDirectStream=false` ("direct-stream http
streaming is currently broken"), and `AllowVideoStreamCopy=false` also sets
`SupportsDirectStream=false`. Also pre-flight that the configured user has
`EnableVideoPlaybackTranscoding`/`EnableAudioPlaybackTranscoding`/`EnablePlaybackRemuxing`;
otherwise `SupportsTranscoding=false` and negotiation yields no playback — surface a clear error.

### B7 (medium) — Auth headers / user-id handling
- `MediaBrowser` `Authorization` scheme is parsed unconditionally; `X-Emby-Token`,
  `X-MediaBrowser-Token`, `?api_key=` are legacy-gated by `EnableLegacyAuthorization`;
  `?ApiKey=` is always accepted. Recommended upstream auth:
  `Authorization: MediaBrowser Token="<JELLYFIN_API_KEY>", Client="JFVRC", Device="server", DeviceId="...", Version="..."`.
  Keep credentials out of URLs. `Authorization` is parsed always, so prefer it.
- API keys have no owning user (`authInfo.User` is null, `IsApiKey=true`). The configured
  `JELLYFIN_USER_ID` is mandatory; pass it explicitly (prefer PlaybackInfo body `UserId`;
  `?userId=` is marked `[FromParameterObsolete]`). API-key auth sets `DeviceId` to the server
  SystemId, so `DeviceId` is not unique per session — use `PlaySessionId` as the discriminator.
- Credentialed fetches: validate/deny redirects (already in architecture).

---

## Validated assumptions (no change needed)

- **HLS/TS H.264/AAC target**: `_supportedHlsVideoCodecs = h264,hevc,vp9,av1` and
  `_supportedHlsAudioCodecsTs = aac,ac3,eac3,mp3`. H.264 + AAC in MPEG-TS HLS is valid.
- **8-bit forcing**: Jellyfin defaults software output to `yuv420p`/`nv12` (8-bit), forces
  HEVC Main10→Main, and H.264 High10→High for all encoders except libx264. Explicitly add a
  `CodecProfile` Type=Video, Codec=h264 with `VideoBitDepth LessThanEqual 8` (and optionally
  `VideoProfile EqualsAny high|main|baseline|constrained baseline|high 10`). This both
  prevents 10-bit direct play and sets the 8-bit transcode target (`videobitdepth`).
- **TranscodingProfile**: `Container="ts"`, `Protocol="hls"`, `Context="Streaming"`,
  `VideoCodec="h264"`, `AudioCodec="aac"`, `EnableSubtitlesInManifest=false` (model default is
  false, but set explicitly), `MaxAudioChannels="2"`, `SegmentLength>0`. `SegmentContainer` ts
  follows from the profile container.
- **Stop encoding**: `DELETE Videos/ActiveEncodings?deviceId=<d>&playSessionId=<p>`
  (`HlsSegmentController.StopEncodingProcess`, `[Authorize]`) both params Required, calls
  `KillTranscodingJobs(deviceId, playSessionId, _ => true)`. Persisting DeviceId + PlaySessionId
  and scoping cleanup this way is correct and narrow (PlaySessionId is unique per session).
- **HEAD**: only `Videos/{itemId}/master.m3u8` (and audio master) have `[HttpHead]`; it
  short-circuits with an empty body + playlist MIME type and does not start a transcode.
  Handle HEAD on our master without starting upstream work.
- **PlaySessionId**: server-generated in `PlaybackInfo`; use the returned value verbatim in
  the master request and cleanup.
- **Media source/track selection**: `SetDeviceSpecificData` only applies
  `MediaSourceId`/`AudioStreamIndex`/`SubtitleStreamIndex` when the passed `mediaSourceId`
  exactly equals the resolved source id — always pass the exact id returned by resolve.
- **Manifest tags/timing**: VOD playlists are `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`;
  `#EXT-X-VERSION:3` (ts) / `7` (fmp4). Preserve tags/newlines/quoted attributes when rewriting.

---

## Upstream HLS URL reference (for allowlist and rewrite tests)

Relative to Jellyfin server root (base path prefixed for actual URL):

```
Videos/{itemId}/master.m3u8?<query>                      # variant: main.m3u8 (relative)
Videos/{itemId}/main.m3u8?<query>                        # segments below, relative
Videos/{itemId}/hls1/{playlistId}/{segmentId}.{container}   # playlistId=main; fmp4 init = -1.mp4
Videos/{itemId}/hls/{playlistId}/...                     # legacy HlsSegmentController (some unauthenticated)
{mediaSourceId}/Subtitles/{index}/subtitles.m3u8?...      # only if HLS subs/manifest subs enabled
Trickplay/{width}/tiles.m3u8?...                          # disable via enableTrickplay=false
Videos/{routeItemId}/{routeMediaSourceId}/Subtitles/{routeIndex}/Stream.{format}?...
```

Recommendation: allowlist case-insensitively only `/Videos/{selectedItemId}/` (and audio
equivalents if ever added), reject `Trickplay`, `Subtitles`, and legacy `hls/` unless a
feature explicitly needs them.

---

## Official references (checked 2026-09-12, `master`)

- MediaInfo/PlaybackInfo + TranscodingUrl construction:
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/MediaInfoController.cs
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Helpers/MediaInfoHelper.cs
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/StreamInfo.cs
- Dynamic HLS routes/manifest/subtitles/trickplay:
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/DynamicHlsController.cs
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Helpers/DynamicHlsHelper.cs
- Streaming state/params:
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Helpers/StreamingHelpers.cs
- Stop encoding + legacy segments:
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/HlsSegmentController.cs
- Subtitle profiles/burn-in, HLS codec allowlists, bit depth:
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/StreamBuilder.cs
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs
- Device profile model:
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/DeviceProfile.cs
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/TranscodingProfile.cs
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/CodecProfile.cs
  https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Dlna/SubtitleProfile.cs
- PlaybackInfoDto (request fields incl. AlwaysBurnIn/Allow*Copy):
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Models/MediaInfoDtos/PlaybackInfoDto.cs
- Auth header/token parsing:
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs
  https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Auth/CustomAuthenticationHandler.cs

## Follow-ups for the integration phase (after builders finish)

1. Assert the stored/served TranscodingUrl and rewritten manifests contain no `ApiKey`.
2. Test base-path (`JELLYFIN_URL=https://host/jellyfin`) master resolution end-to-end.
3. Test burn-in: negotiate a movie with an SRT/ASS track and assert `SubtitleMethod=Encode`
   plus absence of an `#EXT-X-MEDIA` subtitle rendition.
4. Test `enableTrickplay=false` behavior and that no `#EXT-X-IMAGE-STREAM-INF` leaks.
5. Test relative `hls1/main/...` resolution and `runtimeTicks`/`actualSegmentLengthTicks` passthrough.
6. Test `DELETE Videos/ActiveEncodings` scope and that idle cleanup cannot kill in-flight reads.
