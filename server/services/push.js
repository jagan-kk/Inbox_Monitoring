import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, env } from '../config.js';
import { flushStores, pushStore } from '../store.js';
import { redis, storageMode } from '../db.js';

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

let vapid = null;
let configured = false;

async function readStoredKeys() {
  try {
    const raw =
      storageMode === 'redis' ? await redis.get('ricky:vapid') : fs.readFileSync(VAPID_FILE, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.publicKey && parsed?.privateKey ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredKeys(keys) {
  const raw = JSON.stringify(keys);
  if (storageMode === 'redis') {
    await redis.set('ricky:vapid', raw);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VAPID_FILE, raw);
}

/**
 * VAPID keys identify this server to the browser push service.
 * Set them via env in production; otherwise we generate and persist a pair.
 */
export async function initPush() {
  if (configured) return vapid;

  let keys = null;
  if (env.vapid.publicKey && env.vapid.privateKey) {
    keys = { publicKey: env.vapid.publicKey, privateKey: env.vapid.privateKey };
  } else {
    keys = await readStoredKeys();
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await writeStoredKeys(keys);
      console.log('[push] generated a new VAPID key pair (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to keep it stable).');
    }
  }

  webpush.setVapidDetails(env.vapid.subject, keys.publicKey, keys.privateKey);
  vapid = keys;
  configured = true;
  return vapid;
}

export async function publicKey() {
  await initPush();
  return vapid.publicKey;
}

export function subscriptions() {
  return Array.isArray(pushStore.data) ? pushStore.data : [];
}

export function subscriptionCount() {
  return subscriptions().length;
}

export async function addSubscription(subscription) {
  if (!subscription?.endpoint) throw new Error('Invalid push subscription.');

  const entry = {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    createdAt: Date.now(),
    userAgent: String(subscription.userAgent || '').slice(0, 160) || null,
  };

  const next = subscriptions().filter((s) => s.endpoint !== entry.endpoint);
  next.push(entry);
  pushStore.data = next.slice(-20); // one person, but a few devices
  pushStore.save();
  await flushStores();
  return pushStore.data.length;
}

export async function removeSubscription(endpoint) {
  const next = subscriptions().filter((s) => s.endpoint !== endpoint);
  pushStore.data = next;
  pushStore.save();
  await flushStores();
  return next.length;
}

/** Fan out to every registered device. Dead endpoints are pruned. */
export async function sendPush(payload) {
  await initPush();
  const list = subscriptions();
  const gone = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    list.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: 3600,
          urgency: 'high',
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error.statusCode === 404 || error.statusCode === 410) gone.push(subscription.endpoint);
        else console.error('[push]', error.statusCode || '', error.message);
      }
    })
  );

  if (gone.length) {
    pushStore.data = subscriptions().filter((s) => !gone.includes(s.endpoint));
    pushStore.save();
    await flushStores();
  }

  return { sent, failed, devices: list.length, pruned: gone.length };
}

export function pushStatus() {
  return { devices: subscriptionCount(), ready: Boolean(vapid) || Boolean(env.vapid.publicKey) };
}
