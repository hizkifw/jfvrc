/**
 * Test harness: wires a real buildApp instance to the mock Jellyfin server.
 * Uses Fastify's inject for most assertions and a real listening socket for
 * streaming/abort/range tests.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../../../src/server/app';
import { loadConfig, type AppConfig } from '../../../src/server/config';
import { LinkStore, type LinkRecord } from '../../../src/server/store';
import { API_KEY, MockJellyfin, USER_ID, type MockJellyfinOptions } from './mockJellyfin';

export const ADMIN_TOKEN = 'test-admin-token-value';
export const TEST_USER_ID = USER_ID;

export interface StackOptions {
  basePath?: string;
  mock?: MockJellyfinOptions;
  env?: Record<string, string>;
  /** Use this directory for SPA static serving. */
  clientDir?: string;
}

export interface Stack {
  mock: MockJellyfin;
  config: AppConfig;
  store: LinkStore;
  built: BuiltApp;
  app: FastifyInstance;
  authHeaders: { authorization: string };
  close(): Promise<void>;
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const basePath = options.basePath ?? '';
  const mock = new MockJellyfin({ ...options.mock, basePath: options.mock?.basePath ?? basePath });
  await mock.start();

  const env: NodeJS.ProcessEnv = {
    ADMIN_TOKEN,
    JELLYFIN_URL: `${mock.origin}${basePath}`,
    JELLYFIN_API_KEY: API_KEY,
    JELLYFIN_USER_ID: TEST_USER_ID,
    PUBLIC_BASE_URL: 'https://gateway.example',
    DATABASE_PATH: ':memory:',
    SESSION_IDLE_TTL_SECONDS: '600',
    UPSTREAM_TIMEOUT_SECONDS: '5',
    ...options.env,
  };
  const config = loadConfig(env);
  const store = new LinkStore(':memory:');
  const built = buildApp({ config, store, clientDir: options.clientDir });
  await built.app.ready();

  return {
    mock,
    config,
    store,
    built,
    app: built.app,
    authHeaders: { authorization: `Bearer ${ADMIN_TOKEN}` },
    async close() {
      await built.app.close();
      await mock.stop();
    },
  };
}

export interface CreatedLink {
  id: string;
  url: string;
  expiresAt: string;
  title: string;
  token: string;
  path: string;
}

export async function createLink(
  app: FastifyInstance,
  authHeaders: { authorization: string },
  overrides: Record<string, unknown> = {},
): Promise<CreatedLink> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: {
      itemId: '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b',
      mediaSourceId: '3f2a1c4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b',
      subtitleStreamIndex: 2,
      preset: '1080p',
      startSeconds: 0,
      expiresInHours: 24,
      ...overrides,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createLink failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { id: string; url: string; expiresAt: string; title: string };
  const url = new URL(body.url);
  const match = /(\/s\/([^/]+)\/master\.m3u8)$/.exec(url.pathname);
  if (!match) throw new Error(`unexpected link url: ${body.url}`);
  // `path` is the app-relative route (the reverse proxy strips any PUBLIC_BASE_URL
  // sub-path before the request reaches Fastify).
  return { ...body, token: match[2]!, path: match[1]! };
}

export function tempClientDir(): string {
  return mkdtempSync(join(tmpdir(), 'jfvrc-client-'));
}

export function linkFromStore(store: LinkStore, token: string): LinkRecord | null {
  return store.findByToken(token);
}
