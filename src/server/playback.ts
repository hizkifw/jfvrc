import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config';
import { AppError, gone, notFound, upstreamError } from './errors';
import type { JellyfinClient, PlaybackNegotiation } from './jellyfin';
import { rewriteManifest } from './manifest';
import type { LinkRecord, LinkStore } from './store';

const MAX_RESOURCES_PER_SESSION = 4096;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

export interface SessionResource {
  id: string;
  url: string;
  filename: string;
  isPlaylist: boolean;
  /** Original (credential-stripped) query string, echoed for player compatibility. */
  search: string;
}

export interface PlaybackSession {
  id: string;
  linkId: string;
  token: string;
  deviceId: string;
  playSessionId: string;
  itemId: string;
  masterUrl: string;
  startTicks: number;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
  resources: Map<string, SessionResource>;
  resourcesByUrl: Map<string, SessionResource>;
  counter: number;
  inflight: number;
  aborters: Set<AbortController>;
}

export interface BinaryResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  release(): void;
}

export class PlaybackManager {
  private readonly config: AppConfig;
  private readonly store: LinkStore;
  private readonly jellyfin: JellyfinClient;
  private readonly publicBasePath: string;
  private readonly sessions = new Map<string, PlaybackSession>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, store: LinkStore, jellyfin: JellyfinClient) {
    this.config = config;
    this.store = store;
    this.jellyfin = jellyfin;
    // When PUBLIC_BASE_URL includes a sub-path (reverse proxy mount point), the
    // rewritten manifest URIs must carry it too or players resolve to the wrong
    // root. The proxy is expected to strip the prefix before our routes.
    try {
      const path = new URL(config.publicBaseUrl).pathname.replace(/\/+$/, '');
      this.publicBasePath = path === '/' ? '' : path;
    } catch {
      this.publicBasePath = '';
    }
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  resolveLink(token: string): LinkRecord {
    if (!token) {
      throw notFound('link_not_found', 'Playback link not found');
    }
    const link = this.store.findByToken(token);
    if (!link) {
      throw notFound('link_not_found', 'Playback link not found');
    }
    if (link.revoked) {
      throw gone('link_revoked', 'This playback link has been revoked');
    }
    if (Date.parse(link.expiresAt) <= Date.now()) {
      throw gone('link_expired', 'This playback link has expired');
    }
    return link;
  }

  async createSession(link: LinkRecord, token: string): Promise<PlaybackSession> {
    if (this.sessions.size >= this.config.maxActiveSessions) {
      this.purgeIdle();
    }
    if (this.sessions.size >= this.config.maxActiveSessions) {
      throw new AppError(503, 'too_many_sessions', 'Too many active playback sessions, try again later');
    }
    const deviceId = randomBytes(16).toString('hex');
    const negotiation = await this.jellyfin.negotiatePlayback({
      itemId: link.item.id,
      mediaSourceId: link.mediaSourceId,
      audioStreamIndex: link.audioStreamIndex,
      subtitleStreamIndex: link.subtitleStreamIndex,
      preset: link.preset,
      startSeconds: link.startSeconds,
      deviceId,
    });
    const now = Date.now();
    const session: PlaybackSession = {
      id: randomBytes(12).toString('base64url'),
      linkId: link.id,
      token,
      deviceId: negotiation.deviceId,
      playSessionId: negotiation.playSessionId,
      itemId: negotiation.itemId,
      masterUrl: negotiation.transcodeUrl,
      startTicks: Math.max(0, Math.round(link.startSeconds * 10_000_000)),
      createdAt: now,
      lastAccess: now,
      expiresAt: Date.parse(link.expiresAt),
      resources: new Map(),
      resourcesByUrl: new Map(),
      counter: 0,
      inflight: 0,
      aborters: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(token: string, sessionId: string): { link: LinkRecord; session: PlaybackSession } {
    const link = this.resolveLink(token);
    const session = this.sessions.get(sessionId);
    if (!session || session.linkId !== link.id) {
      throw notFound('session_not_found', 'Playback session not found or expired');
    }
    if (Date.now() > session.expiresAt) {
      this.dropSession(session);
      throw gone('link_expired', 'This playback link has expired');
    }
    session.lastAccess = Date.now();
    return { link, session };
  }

  registerResource(session: PlaybackSession, upstreamUrl: string, filename: string): string {
    const existing = session.resourcesByUrl.get(upstreamUrl);
    if (existing) {
      return this.resourcePath(session, existing);
    }
    if (session.resources.size >= MAX_RESOURCES_PER_SESSION) {
      throw new AppError(503, 'session_resource_limit', 'Playback session referenced too many resources');
    }
    const id = randomBytes(9).toString('base64url');
    const safeFilename = sanitizeFilename(filename);
    const parsed = new URL(upstreamUrl);
    const resource: SessionResource = {
      id,
      url: upstreamUrl,
      filename: safeFilename,
      isPlaylist: /\.m3u8$/i.test(parsed.pathname),
      search: parsed.search,
    };
    session.resources.set(id, resource);
    session.resourcesByUrl.set(upstreamUrl, resource);
    session.counter += 1;
    return this.resourcePath(session, resource);
  }

  private resourcePath(session: PlaybackSession, resource: SessionResource): string {
    return `${this.publicBasePath}/s/${encodeURIComponent(session.token)}/p/${session.id}/${resource.id}/${encodeURIComponent(resource.filename)}${resource.search}`;
  }

  async fetchManifest(session: PlaybackSession, upstreamUrl: string): Promise<string> {
    const response = await this.jellyfin.fetchResource(upstreamUrl, {
      deviceId: session.deviceId,
      signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
    });
    if (!response.ok) {
      throw upstreamError('Jellyfin could not provide the playlist');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_PLAYLIST_BYTES) {
      throw upstreamError('The upstream playlist is unexpectedly large');
    }
    const text = await response.text();
    if (text.length > MAX_PLAYLIST_BYTES) {
      throw upstreamError('The upstream playlist is unexpectedly large');
    }
    return rewriteManifest(text, {
      jellyfin: this.config.jellyfin!,
      itemId: session.itemId,
      manifestUrl: upstreamUrl,
      startTicks: session.startTicks,
      mapResource: (url, filename) => this.registerResource(session, url, filename),
    });
  }

  async openBinary(
    session: PlaybackSession,
    upstreamUrl: string,
    options: { range?: string; signal?: AbortSignal },
  ): Promise<BinaryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    const signals: AbortSignal[] = [controller.signal];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);

    session.inflight += 1;
    session.aborters.add(controller);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.inflight = Math.max(0, session.inflight - 1);
      session.aborters.delete(controller);
    };

    try {
      const headers: Record<string, string> = {};
      if (options.range) headers.Range = options.range;
      const response = await this.jellyfin.fetchResource(upstreamUrl, {
        headers,
        signal,
        deviceId: session.deviceId,
      });
      clearTimeout(timer);
      if (!response.ok && response.status !== 206 && response.status !== 416) {
        release();
        throw upstreamError('Jellyfin could not provide the requested resource');
      }
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        release,
      };
    } catch (error) {
      clearTimeout(timer);
      release();
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw upstreamError('Jellyfin could not provide the requested resource');
    }
  }

  dropSession(session: PlaybackSession): void {
    if (!this.sessions.has(session.id)) return;
    for (const aborter of session.aborters) {
      try {
        aborter.abort();
      } catch {
        // ignore
      }
    }
    session.aborters.clear();
    this.sessions.delete(session.id);
    void this.jellyfin.stopEncoding(session.deviceId, session.playSessionId);
  }

  closeSessionsForLink(linkId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.linkId === linkId) {
        this.dropSession(session);
      }
    }
  }

  purgeIdle(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.inflight > 0) continue;
      const idle = now - session.lastAccess > this.config.sessionIdleTtlMs;
      const expired = now > session.expiresAt;
      if (idle || expired) {
        this.dropSession(session);
      }
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      try {
        this.purgeIdle();
      } catch {
        // never crash on cleanup
      }
    }, intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopSweeper();
    for (const session of [...this.sessions.values()]) {
      this.dropSession(session);
    }
  }
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'resource.bin';
  return cleaned.slice(0, 120);
}
