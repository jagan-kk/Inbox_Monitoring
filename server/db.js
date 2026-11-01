import { env } from './config.js';

/**
 * Tiny Upstash Redis REST client (also works with Vercel KV, which exposes the
 * same API). Used on serverless hosts where the local filesystem is ephemeral.
 * When no credentials are present the app falls back to a JSON file store.
 */
export const remoteStorage = Boolean(env.redis.url && env.redis.token);
export const storageMode = remoteStorage ? 'redis' : 'file';

const base = remoteStorage ? env.redis.url.replace(/\/+$/, '') : '';
const headers = () => ({
  authorization: `Bearer ${env.redis.token}`,
  'content-type': 'application/json',
});

async function command(...parts) {
  const res = await fetch(base, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(parts),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok || body?.error) {
    throw new Error(`Redis error (${res.status}): ${String(body?.error || text).slice(0, 240)}`);
  }
  return body.result;
}

export const redis = {
  get: (key) => command('GET', key),
  set: (key, value, { ttlSeconds } = {}) =>
    ttlSeconds ? command('SET', key, value, 'EX', String(Math.round(ttlSeconds))) : command('SET', key, value),
  del: (key) => command('DEL', key),
  async mget(keys) {
    if (!keys.length) return [];
    const result = await command('MGET', ...keys);
    return Array.isArray(result) ? result : [];
  },
  ping: () => command('PING'),
};
