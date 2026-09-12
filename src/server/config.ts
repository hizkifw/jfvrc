import { z } from 'zod';

export interface JellyfinConfig {
  /** Origin only, e.g. https://jellyfin.example.com:8920 (no path, no credentials). */
  origin: string;
  /** Web path prefix beneath the origin, '' or '/jellyfin' (no trailing slash). */
  basePath: string;
  apiKey: string;
  userId: string;
}

export interface AppConfig {
  jellyfin: JellyfinConfig | null;
  configured: boolean;
  /** Sanitized display URL (origin + basePath), or '' when unconfigured. */
  jellyfinDisplayUrl: string;
  adminToken: string;
  publicBaseUrl: string;
  databasePath: string;
  port: number;
  host: string;
  sessionIdleTtlMs: number;
  maxActiveSessions: number;
  linkDefaultExpiryHours: number;
  linkMaxExpiryHours: number;
  upstreamTimeoutMs: number;
  maxMediaRequests: number;
  maxUpstreamTransfers: number;
  mediaRequestTimeoutMs: number;
  mediaCacheBytes: number;
  maxMediaResourceBytes: number;
  mediaCacheTtlMs: number;
}

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  JELLYFIN_URL: z.string().trim().optional(),
  JELLYFIN_API_KEY: z.string().trim().optional(),
  JELLYFIN_USER_ID: z.string().trim().optional(),
  ADMIN_TOKEN: z.string().min(1, 'ADMIN_TOKEN is required'),
  PUBLIC_BASE_URL: z.string().trim().optional(),
  DATABASE_PATH: z.string().trim().default('./data/jfvrc.db'),
  PORT: intFromEnv(3000),
  HOST: z.string().trim().default('0.0.0.0'),
  SESSION_IDLE_TTL_SECONDS: intFromEnv(600),
  MAX_ACTIVE_SESSIONS: intFromEnv(12),
  LINK_DEFAULT_EXPIRY_HOURS: intFromEnv(24),
  LINK_MAX_EXPIRY_HOURS: intFromEnv(168),
  UPSTREAM_TIMEOUT_SECONDS: intFromEnv(30),
  MAX_MEDIA_REQUESTS: intFromEnv(512),
  MAX_UPSTREAM_TRANSFERS: intFromEnv(8),
  MEDIA_REQUEST_TIMEOUT_SECONDS: intFromEnv(120),
  MEDIA_CACHE_MB: intFromEnv(128),
  MAX_MEDIA_RESOURCE_MB: intFromEnv(16),
  MEDIA_CACHE_TTL_SECONDS: intFromEnv(120),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseJellyfin(raw: string): { origin: string; basePath: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('JELLYFIN_URL must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('JELLYFIN_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new ConfigError('JELLYFIN_URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new ConfigError('JELLYFIN_URL must not contain a query or fragment');
  }
  let basePath = url.pathname.replace(/\/+$/, '');
  if (basePath === '/') {
    basePath = '';
  }
  return { origin: url.origin, basePath };
}

function parsePublicBaseUrl(raw: string, port: number): string {
  const candidate = raw || `http://localhost:${port}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new ConfigError('PUBLIC_BASE_URL must not contain credentials');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(
      `Invalid configuration: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown error'}`,
    );
  }
  const e = parsed.data;

  let jellyfin: JellyfinConfig | null = null;
  if (e.JELLYFIN_URL || e.JELLYFIN_API_KEY || e.JELLYFIN_USER_ID) {
    if (!e.JELLYFIN_URL || !e.JELLYFIN_API_KEY || !e.JELLYFIN_USER_ID) {
      throw new ConfigError(
        'JELLYFIN_URL, JELLYFIN_API_KEY and JELLYFIN_USER_ID must all be set together',
      );
    }
    const { origin, basePath } = parseJellyfin(e.JELLYFIN_URL);
    if (!/^[0-9a-fA-F-]{32,36}$/.test(e.JELLYFIN_USER_ID)) {
      throw new ConfigError('JELLYFIN_USER_ID must look like a UUID');
    }
    jellyfin = {
      origin,
      basePath,
      apiKey: e.JELLYFIN_API_KEY,
      userId: e.JELLYFIN_USER_ID,
    };
  }

  if (e.LINK_DEFAULT_EXPIRY_HOURS > e.LINK_MAX_EXPIRY_HOURS) {
    throw new ConfigError('LINK_DEFAULT_EXPIRY_HOURS must not exceed LINK_MAX_EXPIRY_HOURS');
  }

  if (e.MEDIA_CACHE_MB < e.MAX_MEDIA_RESOURCE_MB) {
    throw new ConfigError('MEDIA_CACHE_MB must be at least MAX_MEDIA_RESOURCE_MB');
  }

  return {
    jellyfin,
    configured: jellyfin !== null,
    jellyfinDisplayUrl: jellyfin ? `${jellyfin.origin}${jellyfin.basePath}` : '',
    adminToken: e.ADMIN_TOKEN,
    publicBaseUrl: parsePublicBaseUrl(e.PUBLIC_BASE_URL ?? '', e.PORT),
    databasePath: e.DATABASE_PATH,
    port: e.PORT,
    host: e.HOST,
    sessionIdleTtlMs: e.SESSION_IDLE_TTL_SECONDS * 1000,
    maxActiveSessions: e.MAX_ACTIVE_SESSIONS,
    linkDefaultExpiryHours: e.LINK_DEFAULT_EXPIRY_HOURS,
    linkMaxExpiryHours: e.LINK_MAX_EXPIRY_HOURS,
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_SECONDS * 1000,
    maxMediaRequests: e.MAX_MEDIA_REQUESTS,
    maxUpstreamTransfers: e.MAX_UPSTREAM_TRANSFERS,
    mediaRequestTimeoutMs: e.MEDIA_REQUEST_TIMEOUT_SECONDS * 1000,
    mediaCacheBytes: e.MEDIA_CACHE_MB * 1024 * 1024,
    maxMediaResourceBytes: e.MAX_MEDIA_RESOURCE_MB * 1024 * 1024,
    mediaCacheTtlMs: e.MEDIA_CACHE_TTL_SECONDS * 1000,
  };
}
