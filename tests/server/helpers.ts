import { loadConfig, type AppConfig } from '../../src/server/config';
import { buildApp, type BuiltApp } from '../../src/server/app';
import { startMockJellyfin, type MockJellyfin } from './mock-jellyfin';

export const ADMIN_TOKEN = 'test-admin-token';
export const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

export interface TestContext {
  mock: MockJellyfin;
  built: BuiltApp;
  config: AppConfig;
  basePath: string;
  auth: { authorization: string };
}

export async function setup(basePath = '', databasePath = ':memory:'): Promise<TestContext> {
  const mock = await startMockJellyfin(basePath);
  const env: NodeJS.ProcessEnv = {
    JELLYFIN_URL: `${mock.url}${basePath}`,
    JELLYFIN_API_KEY: 'test-api-key',
    JELLYFIN_USER_ID: USER_ID,
    ADMIN_TOKEN,
    PUBLIC_BASE_URL: 'https://gateway.test',
    DATABASE_PATH: databasePath,
    SESSION_IDLE_TTL_SECONDS: '600',
    LINK_DEFAULT_EXPIRY_HOURS: '24',
    LINK_MAX_EXPIRY_HOURS: '168',
    PREWARM_LINKS: 'false',
  };
  const config = loadConfig(env);
  const built = buildApp({ config, logger: false, clientDir: '/nonexistent-client-dir' });
  return {
    mock,
    built,
    config,
    basePath,
    auth: { authorization: `Bearer ${ADMIN_TOKEN}` },
  };
}

export async function teardown(ctx: TestContext): Promise<void> {
  await ctx.built.app.close();
  await ctx.mock.stop();
}

export function resourcePaths(body: string): string[] {
  return [...body.matchAll(/\/s\/[A-Za-z0-9_\-./]+/g)].map((m) => m[0]!);
}

export function findResource(body: string, needle: string): string {
  const match = [...body.matchAll(/\/s\/[A-Za-z0-9_\-./]+/g)]
    .map((m) => m[0]!)
    .find((p) => p.includes(needle));
  if (!match) throw new Error(`resource containing ${needle} not found in:\n${body}`);
  return match;
}
