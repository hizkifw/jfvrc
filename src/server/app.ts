import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config';
import { AppError, badRequest, notFound, toErrorBody, unprocessable } from './errors';
import { JellyfinClient, isValidItemId } from './jellyfin';
import { PlaybackManager } from './playback';
import { LinkStore, toLinkSummary } from './store';
import type { CreateLinkResponse, LinksResponse, LibraryResponse, StatusResponse } from '../shared/contracts';

const resolveSchema = z.object({
  input: z.string().min(1, 'input is required'),
});

const createLinkSchema = z.object({
  itemId: z.string().min(1),
  mediaSourceId: z.string().min(1),
  audioStreamIndex: z.number().int().nullable().optional(),
  subtitleStreamIndex: z.number().int(),
  preset: z.enum(['1080p', '720p']),
  startSeconds: z.number().finite().nonnegative(),
  expiresInHours: z.number().finite().positive(),
});

export interface BuildAppOptions {
  config: AppConfig;
  store?: LinkStore;
  fetchImpl?: typeof fetch;
  logger?: boolean | Record<string, unknown>;
  clientDir?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  store: LinkStore;
  playback: PlaybackManager | null;
  jellyfin: JellyfinClient | null;
}

const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const CONTENT_TYPES: Record<string, string> = {
  m3u8: PLAYLIST_CONTENT_TYPE,
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/mp4',
  m4v: 'video/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  key: 'application/octet-stream',
  bin: 'application/octet-stream',
};

function contentTypeForFilename(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function setMediaCors(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Range, Origin, Accept, Content-Type, If-None-Match');
  reply.header(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Date',
  );
  reply.header('Access-Control-Max-Age', '600');
}

function setNoStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}

function normalizeId(id: string): string {
  const lower = id.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(lower)) {
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  }
  return lower;
}

export function extractItemIdFromUrl(url: URL): string | null {
  const direct =
    url.searchParams.get('id') ??
    url.searchParams.get('itemId') ??
    url.searchParams.get('ItemId');
  if (direct) return direct;

  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (hash) {
    const queryIndex = hash.indexOf('?');
    if (queryIndex >= 0) {
      const params = new URLSearchParams(hash.slice(queryIndex + 1));
      const id = params.get('id') ?? params.get('itemId') ?? params.get('ItemId');
      if (id) return id;
    }
  }
  return null;
}

export function extractItemId(input: string, config: AppConfig): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw badRequest('empty_input', 'Enter a Jellyfin item URL or id');
  }
  if (isValidItemId(trimmed)) {
    return normalizeId(trimmed);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest('invalid_input', 'Enter a valid Jellyfin item URL or id');
  }
  const jellyfin = config.jellyfin;
  if (!jellyfin) {
    throw new AppError(503, 'not_configured', 'Jellyfin is not configured');
  }
  if (url.origin !== jellyfin.origin) {
    throw badRequest('untrusted_origin', 'URL does not match the configured Jellyfin server');
  }
  const base = jellyfin.basePath;
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
    throw badRequest('untrusted_path', 'URL is outside the configured Jellyfin base path');
  }
  const id = extractItemIdFromUrl(url);
  if (!id || !isValidItemId(id)) {
    throw badRequest('missing_item_id', 'Could not find a valid item id in the URL');
  }
  return normalizeId(id);
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  const { config } = options;
  const store = options.store ?? new LinkStore(config.databasePath);
  const jellyfin = config.jellyfin
    ? new JellyfinClient(config, options.fetchImpl ?? globalThis.fetch)
    : null;
  const playback = jellyfin ? new PlaybackManager(config, store, jellyfin) : null;
  if (playback) playback.startSweeper();

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 64,
    logController: new LogController({ disableRequestLogging: true }),
    exposeHeadRoutes: false,
  });

  const requireJellyfin = (): JellyfinClient => {
    if (!jellyfin) {
      throw new AppError(503, 'not_configured', 'Jellyfin is not configured');
    }
    return jellyfin;
  };
  const requirePlayback = (): PlaybackManager => {
    if (!playback) {
      throw new AppError(503, 'not_configured', 'Jellyfin is not configured');
    }
    return playback;
  };

  app.addHook('onRequest', async (request) => {
    const path = (request.raw.url ?? '').split('?', 1)[0]!;
    if (!path.startsWith('/api/')) return;
    const header = request.headers.authorization;
    if (!header) throw new AppError(401, 'unauthorized', 'Missing or invalid admin token');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match ? match[1]! : '';
    if (!constantTimeEqual(provided, config.adminToken)) {
      throw new AppError(401, 'unauthorized', 'Missing or invalid admin token');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(toErrorBody(error));
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply
        .code(400)
        .send(toErrorBody(badRequest('bad_request', 'The request could not be processed')));
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .code(500)
      .send(toErrorBody(new AppError(500, 'internal_error', 'Internal server error')));
  });

  app.get('/health', async () => ({ status: 'ok' as const }));

  app.get('/api/status', async (): Promise<StatusResponse> => ({
    configured: config.configured,
    jellyfinUrl: config.jellyfinDisplayUrl,
    publicBaseUrl: config.publicBaseUrl,
  }));

  app.post('/api/resolve', async (request) => {
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('invalid_request', 'A non-empty input string is required');
    }
    const itemId = extractItemId(parsed.data.input, config);
    return requireJellyfin().getItem(itemId);
  });

  app.get('/api/library', async (request): Promise<LibraryResponse> => {
    const q = request.query as Record<string, unknown>;
    const query = typeof q.query === 'string' ? q.query : '';
    const startIndex = clampInt(q.startIndex, 0, 0, 100000, 'startIndex');
    const limit = clampInt(q.limit, 24, 1, 100, 'limit');
    return requireJellyfin().search(query, startIndex, limit);
  });

  app.get('/api/items/:id', async (request) => {
    const { id } = request.params as { id: string };
    if (!isValidItemId(id)) {
      throw badRequest('invalid_item_id', 'Item id must be a UUID or 32 character hex string');
    }
    return requireJellyfin().getItem(normalizeId(id));
  });

  app.post('/api/links', async (request, reply): Promise<CreateLinkResponse> => {
    const parsed = createLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest('invalid_request', issue ? issue.message : 'Invalid link request');
    }
    const body = parsed.data;
    if (body.expiresInHours > config.linkMaxExpiryHours) {
      throw badRequest(
        'expiry_too_long',
        `expiresInHours must not exceed ${config.linkMaxExpiryHours}`,
      );
    }
    const client = requireJellyfin();
    const details = await client.getItem(body.itemId);
    const source = details.mediaSources.find((s) => s.id === body.mediaSourceId);
    if (!source) {
      throw unprocessable('unknown_media_source', 'The selected media source does not belong to this item');
    }
    if (body.audioStreamIndex !== undefined && body.audioStreamIndex !== null) {
      if (!source.audioTracks.some((t) => t.index === body.audioStreamIndex)) {
        throw unprocessable('unknown_audio_track', 'The selected audio track does not belong to this source');
      }
    }
    if (body.subtitleStreamIndex >= 0) {
      if (!source.subtitleTracks.some((t) => t.index === body.subtitleStreamIndex)) {
        throw unprocessable(
          'unknown_subtitle_track',
          'The selected subtitle track does not belong to this source',
        );
      }
    }
    if (details.runTimeSeconds && body.startSeconds > details.runTimeSeconds) {
      throw badRequest('start_out_of_range', 'Start position is beyond the end of the item');
    }
    const expiresAt = new Date(Date.now() + body.expiresInHours * 3_600_000).toISOString();
    const { record, token } = store.createLink({
      item: details,
      mediaSourceId: body.mediaSourceId,
      audioStreamIndex: body.audioStreamIndex ?? null,
      subtitleStreamIndex: body.subtitleStreamIndex,
      preset: body.preset,
      startSeconds: body.startSeconds,
      expiresAt,
    });
    reply.code(201);
    return {
      id: record.id,
      url: `${config.publicBaseUrl}/s/${token}/master.m3u8`,
      expiresAt: record.expiresAt,
      title: record.item.name,
    };
  });

  app.get('/api/links', async (): Promise<LinksResponse> => ({
    links: store.list().map(toLinkSummary),
  }));

  app.delete('/api/links/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = store.findById(id);
    if (!record) {
      throw notFound('link_not_found', 'Playback link not found');
    }
    store.revoke(id);
    playback?.closeSessionsForLink(id);
    reply.code(204);
    return null;
  });

  app.get('/s/:token/master.m3u8', async (request, reply) => {
    const { token } = request.params as { token: string };
    setMediaCors(reply);
    setNoStore(reply);
    const manager = requirePlayback();
    const link = manager.resolveLink(token);
    const session = await manager.createSession(link, token);
    const text = await manager.fetchManifest(session, session.masterUrl);
    reply.type(PLAYLIST_CONTENT_TYPE);
    return text;
  });

  app.head('/s/:token/master.m3u8', async (request, reply) => {
    const { token } = request.params as { token: string };
    setMediaCors(reply);
    setNoStore(reply);
    const manager = requirePlayback();
    manager.resolveLink(token);
    reply.type(PLAYLIST_CONTENT_TYPE);
    return null;
  });

  app.options('/s/:token/master.m3u8', async (_request, reply) => {
    setMediaCors(reply);
    setNoStore(reply);
    return null;
  });

  const resourceHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { token, sessionId, resourceId, filename } = request.params as {
      token: string;
      sessionId: string;
      resourceId: string;
      filename: string;
    };
    setMediaCors(reply);
    setNoStore(reply);
    const manager = requirePlayback();
    const { session } = manager.getSession(token, sessionId);
    const resource = session.resources.get(resourceId);
    if (!resource) {
      throw notFound('resource_not_found', 'Playback resource not found or expired');
    }
    if (request.method === 'HEAD' || request.method === 'OPTIONS') {
      reply.type(contentTypeForFilename(resource.filename));
      return null;
    }
    if (resource.isPlaylist) {
      const text = await manager.fetchManifest(session, resource.url);
      reply.type(PLAYLIST_CONTENT_TYPE);
      return text;
    }

    const clientAbort = new AbortController();
    reply.raw.on('close', () => clientAbort.abort());
    const binary = await manager.openBinary(session, resource.url, {
      range: request.headers.range,
      signal: clientAbort.signal,
    });
    reply.code(binary.status);
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const header of passthrough) {
      const value = binary.headers.get(header);
      if (value !== null) reply.header(header, value);
    }
    if (!reply.hasHeader('content-type')) {
      reply.type(contentTypeForFilename(filename || resource.filename));
    }
    if (!binary.body) {
      binary.release();
      return null;
    }
    const stream = Readable.fromWeb(binary.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on('close', () => binary.release());
    stream.on('error', () => binary.release());
    return reply.send(stream);
  };

  app.get('/s/:token/p/:sessionId/:resourceId/:filename', resourceHandler);
  app.head('/s/:token/p/:sessionId/:resourceId/:filename', resourceHandler);
  app.options('/s/:token/p/:sessionId/:resourceId/:filename', resourceHandler);

  const clientDir = options.clientDir ?? resolve(__dirname, '../client');
  const hasClient = existsSync(join(clientDir, 'index.html'));
  if (hasClient) {
    void app.register(fastifyStatic, { root: clientDir, prefix: '/' });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = (request.raw.url ?? '').split('?', 1)[0]!;
    const reserved = path.startsWith('/api/') || path.startsWith('/s/') || path === '/health';
    if (hasClient && request.method === 'GET' && !reserved) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send(toErrorBody(notFound('not_found', 'Not found')));
  });

  app.addHook('onClose', async () => {
    await playback?.shutdown();
    store.close();
  });

  return { app, store, playback, jellyfin };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw badRequest('invalid_query', `${field} must be an integer`);
  }
  if (parsed < min || parsed > max) {
    throw badRequest('invalid_query', `${field} must be between ${min} and ${max}`);
  }
  return parsed;
}
