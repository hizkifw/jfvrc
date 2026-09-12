import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/harness';

let stack: Stack | undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

function clientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jfvrc-spa-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>JFVRC-SPA</title><div id="root"></div>');
  writeFileSync(join(dir, 'app.js'), 'console.log("jfvrc")');
  return dir;
}

describe('production static serving', () => {
  it('serves the SPA shell for non-reserved GET routes', async () => {
    stack = await startStack({ clientDir: clientDir() });
    const res = await stack.app.inject({ method: 'GET', url: '/links' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('JFVRC-SPA');
  });

  it('serves built assets', async () => {
    stack = await startStack({ clientDir: clientDir() });
    const res = await stack.app.inject({ method: 'GET', url: '/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('jfvrc');
  });

  it('does not serve the SPA for unknown /api or /s routes', async () => {
    stack = await startStack({ clientDir: clientDir() });
    const api = await stack.app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: stack.authHeaders,
    });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    expect(api.body).not.toContain('JFVRC-SPA');

    const media = await stack.app.inject({ method: 'GET', url: '/s/nope/master.m3u8' });
    expect(media.statusCode).toBe(404);
    expect(media.body).not.toContain('JFVRC-SPA');

    const health = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('does not register an SPA fallback when no client build exists', async () => {
    stack = await startStack();
    const res = await stack.app.inject({ method: 'GET', url: '/links' });
    expect(res.statusCode).toBe(404);
  });
});
