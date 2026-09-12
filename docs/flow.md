# Request flow

```mermaid
flowchart LR
  UI[Operator webpage] -->|Admin bearer token| API[Fastify management API]
  API -->|Save item and playback settings| DB[(SQLite link definitions)]
  API -->|Metadata and library requests| JF[Jellyfin API]
  API -->|Return revocable HLS link| UI
  Player[VLC or VRChat] -->|GET share link| Sessions[Playback session manager]
  DB -->|Validate link token and expiry| Sessions
  Sessions -->|PlaybackInfo with codec and subtitle profile| JF
  JF -->|Negotiated HLS URL| Relay[HLS relay]
  Player -->|Session playlists and segments| Relay
  Relay -->|Authenticated upstream requests| HLS[Jellyfin HLS and transcoding]
  HLS -->|Manifests or media bytes| Relay
  Relay -->|Rewritten manifests or streamed media| Player
  Sessions -->|Idle, revoke, shutdown cleanup| JF
```

The management API requires the operator's admin token. Playback only requires the generated link token, so third-party players need no cookies or custom headers. Entry-link GET requests share one playback session per link for synchronized group viewing, with bounded server-side segment buffers. All nested manifest references remain on the gateway. Jellyfin owns codecs, subtitle rendering, hardware acceleration, and segment generation; the gateway owns authorization, URL rewriting, transport, and session cleanup.

This is video-on-demand delivery, not a synchronized broadcast. VRChat's world player owns synchronization between participants. The first version does not try to infer watched position from HTTP segment reads or mark items watched.
