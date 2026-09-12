import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config';
import { AppError, gone, notFound, upstreamError } from './errors';
import type { JellyfinClient } from './jellyfin';
import { MediaCache, withAbort } from './media-cache';
import { rewriteManifest } from './manifest';
import type { LinkRecord, LinkStore } from './store';

const MAX_RESOURCES_PER_SESSION = 32768;
const MAX_RESOURCE_URL_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_CACHE_BYTES = 8 * 1024 * 1024;
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
  resourceBytes: number;
  expiryTimer: NodeJS.Timeout;
  inflight: number;
  aborters: Set<AbortController>;
}

export interface BinaryResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  release(): void;
}

interface PendingSession {
  controller: AbortController;
  promise: Promise<PlaybackSession>;
  users: number;
  settled: boolean;
}
interface PendingManifest {
  controller: AbortController;
  promise: Promise<string>;
  users: number;
  settled: boolean;
}

export class PlaybackManager {
  private readonly config: AppConfig;
  private readonly store: LinkStore;
  private readonly jellyfin: JellyfinClient;
  private readonly publicBasePath: string;
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly sessionsByLink = new Map<string, PlaybackSession>();
  private readonly pendingByLink = new Map<string, PendingSession>();
  private readonly pendingManifests = new Map<string, PendingManifest>();
  private readonly manifestCache = new Map<string, { text: string; owner: string; expiresAt: number }>();
  private manifestCacheBytes = 0;
  private readonly mediaCache: MediaCache;
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, store: LinkStore, jellyfin: JellyfinClient) {
    this.config = config;
    this.store = store;
    this.jellyfin = jellyfin;
    this.mediaCache = new MediaCache({
      maxBytes: config.mediaCacheBytes, maxResourceBytes: config.maxMediaResourceBytes,
      maxFetches: config.maxUpstreamTransfers, timeoutMs: config.upstreamTimeoutMs,
      ttlMs: config.mediaCacheTtlMs,
    });
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

  async createSession(link: LinkRecord, token: string, signal?: AbortSignal): Promise<PlaybackSession> {
    signal?.throwIfAborted();
    if (this.closed) throw new AppError(503, 'shutting_down', 'Server is shutting down');
    this.resolveLink(token);
    const existing = this.sessionsByLink.get(link.id);
    if (existing && this.sessions.has(existing.id) && Date.now() < existing.expiresAt) {
      existing.lastAccess = Date.now();
      return existing;
    }
    let pending = this.pendingByLink.get(link.id);
    if (!pending) {
      this.purgeIdle();
      // Reserve before the first await. Pending negotiations consume capacity too.
      if (this.sessions.size + this.pendingByLink.size >= this.config.maxActiveSessions) {
        throw new AppError(503, 'too_many_sessions', 'Too many active playback sessions, try again later');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(
        this.config.upstreamTimeoutMs, Date.parse(link.expiresAt) - Date.now(),
      )));
      timer.unref();
      pending = { controller, promise: undefined!, users: 0, settled: false };
      const current = pending;
      this.pendingByLink.set(link.id, current);
      current.promise = Promise.resolve().then(() => this.negotiateSession(link, token, controller.signal)).finally(() => {
        current.settled = true;
        clearTimeout(timer);
        if (this.pendingByLink.get(link.id) === current) this.pendingByLink.delete(link.id);
      });
    }
    if (pending.controller.signal.aborted) throw new AppError(503, 'playback_restarting', 'Playback request is restarting, try again later');
    pending.users += 1;
    try {
      return await withAbort(pending.promise, signal);
    } finally {
      pending.users -= 1;
      if (pending.users === 0 && !pending.settled) pending.controller.abort();
    }
  }

  private async negotiateSession(link: LinkRecord, token: string, signal: AbortSignal): Promise<PlaybackSession> {
    signal.throwIfAborted();
    const deviceId = randomBytes(16).toString('hex');
    const negotiation = await this.jellyfin.negotiatePlayback({
      itemId: link.item.id,
      mediaSourceId: link.mediaSourceId,
      audioStreamIndex: link.audioStreamIndex,
      subtitleStreamIndex: link.subtitleStreamIndex,
      preset: link.preset,
      startSeconds: link.startSeconds,
      deviceId,
      signal,
    });
    try {
      signal.throwIfAborted();
      if (this.closed) throw new AppError(503, 'shutting_down', 'Server is shutting down');
      this.resolveLink(token);
    } catch (error) {
      await this.stopEncoding(negotiation.deviceId, negotiation.playSessionId);
      throw error;
    }
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
      resourceBytes: 0,
      expiryTimer: undefined!,
      inflight: 0,
      aborters: new Set(),
    };
    session.expiryTimer = setTimeout(() => this.dropSession(session), Math.max(1, session.expiresAt - now));
    session.expiryTimer.unref();
    this.sessions.set(session.id, session);
    this.sessionsByLink.set(link.id, session);
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
    const urlBytes = Buffer.byteLength(upstreamUrl, 'utf8');
    if (session.resources.size >= MAX_RESOURCES_PER_SESSION || session.resourceBytes + urlBytes > MAX_RESOURCE_URL_BYTES) {
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
    session.resourceBytes += urlBytes;
    return this.resourcePath(session, resource);
  }

  private resourcePath(session: PlaybackSession, resource: SessionResource): string {
    return `${this.publicBasePath}/s/${encodeURIComponent(session.token)}/p/${session.id}/${resource.id}/${encodeURIComponent(resource.filename)}${resource.search}`;
  }

  private operation(session: PlaybackSession, timeoutMs: number) {
    if (!this.sessions.has(session.id)) throw gone('session_ended', 'Playback session ended');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, session.expiresAt - Date.now())));
    timer.unref();
    session.inflight += 1;
    session.aborters.add(controller);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      session.inflight -= 1;
      session.aborters.delete(controller);
      session.lastAccess = Date.now();
    };
    controller.signal.addEventListener('abort', release, { once: true });
    return { controller, release };
  }

  async fetchManifest(session: PlaybackSession, upstreamUrl: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.sessions.has(session.id)) throw gone('session_ended', 'Playback session ended');
    const key = `${session.id}:${upstreamUrl}`;
    const cached = this.manifestCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.text;
    let pending = this.pendingManifests.get(key);
    if (!pending) {
      if (this.pendingManifests.size >= this.config.maxUpstreamTransfers) {
        throw new AppError(503, 'media_capacity', 'Playlist transfer capacity reached, try again later');
      }
      const operation = this.operation(session, this.config.upstreamTimeoutMs);
      pending = { controller: operation.controller, promise: undefined!, users: 0, settled: false };
      const current = pending;
      this.pendingManifests.set(key, current);
      current.promise = Promise.resolve().then(async () => {
        const response = await this.jellyfin.fetchResource(upstreamUrl, {
          deviceId: session.deviceId, signal: current.controller.signal,
        });
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_PLAYLIST_BYTES) {
          await response.body?.cancel();
          throw upstreamError('Jellyfin returned an invalid or oversized playlist');
        }
        const reader = response.body?.getReader();
        let bytes = 0;
        const buffer = Buffer.allocUnsafe(MAX_PLAYLIST_BYTES);
        try {
          if (reader) while (true) {
            const { done, value } = await withAbort(reader.read(), current.controller.signal);
            if (done) break;
            if (bytes + value.byteLength > MAX_PLAYLIST_BYTES) throw upstreamError('The upstream playlist is unexpectedly large');
            buffer.set(value, bytes);
            bytes += value.byteLength;
          }
        } catch (error) {
          current.controller.abort();
          await reader?.cancel().catch(() => {});
          throw error;
        } finally {
          reader?.releaseLock();
        }
        current.controller.signal.throwIfAborted();
        const text = rewriteManifest(buffer.subarray(0, bytes).toString('utf8'), {
          jellyfin: this.config.jellyfin!, itemId: session.itemId, manifestUrl: upstreamUrl,
          startTicks: session.startTicks,
          mapResource: (url, filename) => this.registerResource(session, url, filename),
        });
        this.cacheManifest(key, session.id, text);
        return text;
      }).catch((error: unknown) => {
        if (error instanceof AppError) throw error;
        throw upstreamError('Jellyfin could not provide the playlist');
      }).finally(() => {
        current.settled = true;
        operation.release();
        this.pendingManifests.delete(key);
      });
    }
    if (pending.controller.signal.aborted) throw new AppError(503, 'playback_restarting', 'Playback request is restarting, try again later');
    pending.users += 1;
    try {
      return await withAbort(pending.promise, signal);
    } finally {
      pending.users -= 1;
      if (pending.users === 0 && !pending.settled) pending.controller.abort();
    }
  }

  private cacheManifest(key: string, owner: string, text: string): void {
    const charge = text.length * 2;
    const old = this.manifestCache.get(key);
    if (old) { this.manifestCacheBytes -= old.text.length * 2; this.manifestCache.delete(key); }
    if (charge > MAX_MANIFEST_CACHE_BYTES) return;
    for (const [id, entry] of this.manifestCache) {
      if (entry.expiresAt <= Date.now() || this.manifestCacheBytes + charge > MAX_MANIFEST_CACHE_BYTES || this.manifestCache.size >= 32) {
        this.manifestCache.delete(id);
        this.manifestCacheBytes -= entry.text.length * 2;
      }
    }
    this.manifestCache.set(key, { text, owner, expiresAt: Date.now() + 1000 });
    this.manifestCacheBytes += charge;
  }

  async openBinary(session: PlaybackSession, upstreamUrl: string, options: { range?: string; signal?: AbortSignal }): Promise<BinaryResult> {
    const operation = this.operation(session, this.config.mediaRequestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([operation.controller.signal, options.signal]) : operation.controller.signal;
    try {
      const binary = await this.mediaCache.open(session.id, JSON.stringify([session.id, upstreamUrl, options.range ?? '']), (upstreamSignal) => {
        const headers: Record<string, string> = {};
        if (options.range) headers.Range = options.range;
        return this.jellyfin.fetchResource(upstreamUrl, { headers, signal: upstreamSignal, deviceId: session.deviceId });
      }, signal);
      return { ...binary, release() { binary.release(); operation.release(); } };
    } catch (error) {
      operation.release();
      if (error instanceof AppError) throw error;
      throw upstreamError('Jellyfin could not provide the requested resource');
    }
  }

  /**
   * Best-effort warm-up when a link is created. Negotiates the Jellyfin
   * session, fetches the master and first media playlist (which starts the
   * upstream transcoder), then buffers the first segment into the shared media
   * cache so a player that connects shortly after gets an immediate start.
   * Errors are swallowed: a later playback request simply negotiates on demand.
   */
  async warmLink(link: LinkRecord, token: string): Promise<void> {
    if (this.closed) return;
    try {
      const session = await this.createSession(link, token);
      if (this.closed) return;
      const master = await this.fetchManifest(session, session.masterUrl);
      const variant = this.firstVariantUrl(master, session);
      if (!variant) return;
      await this.fetchManifest(session, variant);
      const segment = this.firstSegmentUrl(session);
      if (segment) await this.prefetchBinary(session, segment);
    } catch {
      // Warm-up is opportunistic; never surface it to the caller.
    }
  }

  /** First media playlist referenced by a rewritten master manifest. */
  private firstVariantUrl(masterText: string, session: PlaybackSession): string | undefined {
    const lines = masterText.split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i]!.trim())) continue;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j]!.trim();
        if (candidate === '') continue;
        if (candidate.startsWith('#')) break;
        const match = /\/s\/[^/]+\/p\/[^/]+\/([^/]+)\//.exec(candidate);
        const resource = match ? session.resources.get(decodeURIComponent(match[1]!)) : undefined;
        return resource?.url;
      }
    }
    return undefined;
  }

  /** First media segment registered while rewriting a variant playlist. */
  private firstSegmentUrl(session: PlaybackSession): string | undefined {
    for (const resource of session.resources.values()) {
      if (/\.(ts|m4s|aac|mp3)$/i.test(resource.url.split('?', 1)[0]!)) return resource.url;
    }
    return undefined;
  }

  private async prefetchBinary(session: PlaybackSession, upstreamUrl: string): Promise<void> {
    const binary = await this.openBinary(session, upstreamUrl, {});
    const body = binary.body;
    if (!body) {
      binary.release();
      return;
    }
    const reader = body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
      binary.release();
    }
  }

  private stopEncoding(deviceId: string, playSessionId: string): Promise<void> {
    const stopping = this.jellyfin.stopEncoding(deviceId, playSessionId);
    this.stopping.add(stopping);
    void stopping.finally(() => this.stopping.delete(stopping));
    return stopping;
  }

  dropSession(session: PlaybackSession): void {
    if (!this.sessions.has(session.id)) return;
    clearTimeout(session.expiryTimer);
    this.mediaCache.invalidate(session.id);
    for (const [key, entry] of this.manifestCache) {
      if (entry.owner === session.id) { this.manifestCache.delete(key); this.manifestCacheBytes -= entry.text.length * 2; }
    }
    for (const aborter of session.aborters) {
      try {
        aborter.abort();
      } catch {
        // ignore
      }
    }
    session.aborters.clear();
    session.resources.clear();
    session.resourcesByUrl.clear();
    session.resourceBytes = 0;
    this.sessions.delete(session.id);
    if (this.sessionsByLink.get(session.linkId) === session) {
      this.sessionsByLink.delete(session.linkId);
    }
    void this.stopEncoding(session.deviceId, session.playSessionId);
  }

  closeSessionsForLink(linkId: string): void {
    this.pendingByLink.get(linkId)?.controller.abort();
    for (const session of [...this.sessions.values()]) {
      if (session.linkId === linkId) {
        this.dropSession(session);
      }
    }
  }

  purgeIdle(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      const idle = now - session.lastAccess > this.config.sessionIdleTtlMs;
      const expired = now > session.expiresAt;
      if (expired || (idle && session.inflight === 0)) {
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
    this.closed = true;
    this.stopSweeper();
    for (const pending of this.pendingByLink.values()) pending.controller.abort();
    for (const session of [...this.sessions.values()]) {
      this.dropSession(session);
    }
    await Promise.allSettled([...this.pendingByLink.values()].map((p) => p.promise));
    await Promise.allSettled([...this.pendingManifests.values()].map((p) => p.promise));
    await Promise.allSettled([...this.stopping]);
  }
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'resource.bin';
  return cleaned.slice(0, 120);
}
