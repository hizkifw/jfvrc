/**
 * Secret-safe helpers for live verification. NEVER print the parsed env object.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function loadEnv(path = '/home/kitsune/workspace/jfvrc/.env') {
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Strip any userinfo/query/hash and trailing slash for safe display. */
export function maskUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return '[invalid-url]';
  }
}

export function writeState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readState(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function authHeader(apiKey) {
  return `MediaBrowser Client="JFVRC-verify", Device="jfvrc-verify", DeviceId="jfvrc-live-verify", Version="1.0.0", Token="${apiKey}"`;
}

export function safeError(error) {
  if (error && typeof error === 'object' && 'status' in error) {
    return `HTTP ${error.status}`;
  }
  const name = error instanceof Error ? error.name : 'Error';
  return name;
}

export function makeJellyfin(env) {
  const base = env.JELLYFIN_URL.replace(/\/+$/, '');
  const headers = {
    Authorization: authHeader(env.JELLYFIN_API_KEY),
    Accept: 'application/json',
  };
  async function jget(path, extraHeaders = {}) {
    const response = await fetch(`${base}${path}`, {
      headers: { ...headers, ...extraHeaders },
      redirect: 'manual',
    });
    if (!response.ok) {
      const error = new Error('jellyfin request failed');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  return { base, jget };
}
