import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { ITEM_ID, MEDIA_SOURCE_ID } from './mock-jellyfin';
import { setup, type TestContext } from './helpers';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe('persistence', () => {
  it('keeps link definitions across a process restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jfvrc-'));
    const dbPath = join(dir, 'links.db');
    const ctx: TestContext = await setup('', dbPath);
    const created = await ctx.built.app.inject({
      method: 'POST',
      url: '/api/links',
      headers: ctx.auth,
      payload: {
        itemId: ITEM_ID,
        mediaSourceId: MEDIA_SOURCE_ID,
        subtitleStreamIndex: -1,
        preset: '720p',
        startSeconds: 0,
        expiresInHours: 24,
      },
    });
    expect(created.statusCode).toBe(201);
    const linkId = created.json().id as string;
    const path = new URL(created.json().url as string).pathname;

    await ctx.built.app.close();

    const second = buildApp({
      config: ctx.config,
      logger: false,
      clientDir: '/nonexistent-client-dir',
    });
    cleanup = async () => {
      await second.app.close();
      await ctx.mock.stop();
      rmSync(dir, { recursive: true, force: true });
    };

    const list = await second.app.inject({ method: 'GET', url: '/api/links', headers: ctx.auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().links.map((l: { id: string }) => l.id)).toContain(linkId);

    const master = await second.app.inject({ method: 'GET', url: path });
    expect(master.statusCode).toBe(200);
    expect(master.body).toContain('#EXTM3U');
  });
});
