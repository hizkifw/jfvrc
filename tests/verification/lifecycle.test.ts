import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaItem } from '../../src/shared/contracts';
import { LinkStore } from '../../src/server/store';
import { MOVIE_ID } from './support/mockJellyfin';
import { createLink, startStack, type Stack } from './support/harness';

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const ITEM: MediaItem = { id: MOVIE_ID, name: 'Test Movie', type: 'Movie' };

function resourcePaths(manifest: string): string[] {
  const uris: string[] = [];
  for (const line of manifest.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    uris.push(trimmed);
  }
  return uris.filter((u) => u.startsWith('/s/'));
}

describe('link and session lifecycle', () => {
  it('rejects a link expired before use with 410', async () => {
    stack = await startStack();
    const { token } = stack.store.createLink({
      item: ITEM,
      mediaSourceId: MOVIE_ID,
      audioStreamIndex: null,
      subtitleStreamIndex: -1,
      preset: '1080p',
      startSeconds: 0,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await stack.app.inject({ method: 'GET', url: `/s/${token}/master.m3u8` });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: 'link_expired' } });
  });

  it('stops existing sessions and rejects their resources after revoke', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const master = await stack.app.inject({ method: 'GET', url: link.path });
    expect(master.statusCode).toBe(200);
    const resources = resourcePaths(master.body);
    expect(resources.length).toBeGreaterThan(0);

    await stack.app.inject({
      method: 'DELETE',
      url: `/api/links/${link.id}`,
      headers: stack.authHeaders,
    });

    const afterRevoke = await stack.app.inject({ method: 'GET', url: resources[0]! });
    expect(afterRevoke.statusCode).toBe(410);
    expect(afterRevoke.json()).toMatchObject({ error: { code: 'link_revoked' } });

    const masterAgain = await stack.app.inject({ method: 'GET', url: link.path });
    expect(masterAgain.statusCode).toBe(410);
  });

  it('rejects forged token/session/resource combinations', async () => {
    stack = await startStack();
    const a = await createLink(stack.app, stack.authHeaders);
    const b = await createLink(stack.app, stack.authHeaders);
    const masterA = await stack.app.inject({ method: 'GET', url: a.path });
    const resourcePath = resourcePaths(masterA.body)[0]!;

    // Use link A's session but link B's token via path tampering.
    const forged = resourcePath.replace(`/s/${a.token}/`, `/s/${b.token}/`);
    const forgedRes = await stack.app.inject({ method: 'GET', url: forged });
    expect(forgedRes.statusCode).toBe(404);

    const badResource = resourcePath.replace(/\/p\/([^/]+)\/([^/]+)\//, '/p/$1/does-not-exist/');
    const badResourceRes = await stack.app.inject({ method: 'GET', url: badResource });
    expect(badResourceRes.statusCode).toBe(404);

    const badSession = resourcePath.replace(/\/p\/([^/]+)\//, '/p/not-a-session/');
    const badSessionRes = await stack.app.inject({ method: 'GET', url: badSession });
    expect(badSessionRes.statusCode).toBe(404);
  });

  it('persists links and revocations across a store restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jfvrc-store-'));
    const dbPath = join(dir, 'links.db');
    try {
      const first = new LinkStore(dbPath);
      const { token, record } = first.createLink({
        item: ITEM,
        mediaSourceId: MOVIE_ID,
        audioStreamIndex: 1,
        subtitleStreamIndex: 2,
        preset: '720p',
        startSeconds: 42,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      first.revoke(record.id);
      first.close();

      const second = new LinkStore(dbPath);
      const reloaded = second.findByToken(token);
      expect(reloaded).toBeTruthy();
      expect(reloaded!.id).toBe(record.id);
      expect(reloaded!.preset).toBe('720p');
      expect(reloaded!.startSeconds).toBe(42);
      expect(reloaded!.audioStreamIndex).toBe(1);
      expect(reloaded!.subtitleStreamIndex).toBe(2);
      expect(reloaded!.revoked).toBe(true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses a single session across repeated master manifest requests', async () => {
    stack = await startStack();
    const link = await createLink(stack.app, stack.authHeaders);
    const first = await stack.app.inject({ method: 'GET', url: link.path });
    const second = await stack.app.inject({ method: 'GET', url: link.path });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(stack.built.playback!.activeSessionCount).toBe(1);
    const sessionIds = new Set<string>();
    for (const manifest of [first.body, second.body]) {
      for (const uri of resourcePaths(manifest)) {
        const match = /\/p\/([^/]+)\//.exec(uri);
        if (match) sessionIds.add(match[1]!);
      }
    }
    expect(sessionIds.size).toBe(1);
  });

  it('bounds active sessions and rejects once the cap is reached', async () => {
    stack = await startStack({ env: { MAX_ACTIVE_SESSIONS: '1' } });
    const first = await createLink(stack.app, stack.authHeaders);
    const second = await createLink(stack.app, stack.authHeaders);
    const firstRes = await stack.app.inject({ method: 'GET', url: first.path });
    expect(firstRes.statusCode).toBe(200);
    const secondRes = await stack.app.inject({ method: 'GET', url: second.path });
    expect(secondRes.statusCode).toBe(503);
    expect(secondRes.json()).toMatchObject({ error: { code: 'too_many_sessions' } });
  });
});
