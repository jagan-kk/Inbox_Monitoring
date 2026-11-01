import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_SETTINGS } from './config.js';
import { redis, storageMode } from './db.js';

const KEYS = {
  settings: 'ricky:settings',
  state: 'ricky:state',
  tokens: 'ricky:tokens',
  push: 'ricky:push',
  users: 'ricky:users',
};

/**
 * Small JSON store.
 * - Local / long-running host: loaded once, written to disk (debounced).
 * - Serverless: loaded per request from Redis, flushed explicitly after writes.
 */
export class JsonStore {
  constructor(name, file, fallback) {
    this.name = name;
    this.key = KEYS[name];
    this.file = file;
    this.fallback = fallback;
    this.dirty = false;
    this.timer = null;
    this.data = storageMode === 'file' ? this.#readFile() : structuredClone(fallback);
  }

  #readFile() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.fallback);
    }
  }

  /** Replace the in-memory value from a remote read. */
  hydrate(raw) {
    if (this.dirty) return;
    if (raw === null || raw === undefined || raw === '') {
      this.data = structuredClone(this.fallback);
      return;
    }
    try {
      this.data = JSON.parse(raw);
    } catch {
      this.data = structuredClone(this.fallback);
    }
  }

  save() {
    this.dirty = true;
    if (storageMode === 'file') {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 100);
    }
    return this;
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (storageMode === 'redis') {
      await redis.set(this.key, JSON.stringify(this.data));
      return;
    }
    this.#writeFile();
  }

  flushSync() {
    if (storageMode === 'redis') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.#writeFile();
    this.dirty = false;
  }

  #writeFile() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const settingsStore = new JsonStore('settings', path.join(DATA_DIR, 'settings.json'), {});
export const stateStore = new JsonStore('state', path.join(DATA_DIR, 'state.json'), {
  processed: {},
  emails: [],
  alerts: [],
  lastScanAt: null,
  lastScanResult: null,
  stats: {},
  queue: [],
});
export const tokenStore = new JsonStore('tokens', path.join(DATA_DIR, 'google-tokens.json'), {});
export const pushStore = new JsonStore('push', path.join(DATA_DIR, 'push.json'), []);
export const userStore = new JsonStore('users', path.join(DATA_DIR, 'users.json'), []);

const stores = [settingsStore, stateStore, tokenStore, pushStore, userStore];

let lastLoadAt = 0;

/** Pull the latest values from Redis. Cheap no-op in file mode. */
export async function loadStores({ force = false } = {}) {
  if (storageMode !== 'redis') return;
  if (!force && Date.now() - lastLoadAt < 400) return;
  lastLoadAt = Date.now();
  const values = await redis.mget(stores.map((s) => s.key));
  stores.forEach((store, index) => store.hydrate(values[index]));
}

/** Persist anything marked dirty. Call at the end of every mutating request. */
export async function flushStores() {
  await Promise.all(stores.map((s) => s.flush()));
}

export function getSettings() {
  const stored = settingsStore.data || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(stored.quietHours || {}) },
    vipSenders: Array.isArray(stored.vipSenders) ? stored.vipSenders : DEFAULT_SETTINGS.vipSenders,
    ignoreSenders: Array.isArray(stored.ignoreSenders) ? stored.ignoreSenders : DEFAULT_SETTINGS.ignoreSenders,
    keywords: Array.isArray(stored.keywords) ? stored.keywords : DEFAULT_SETTINGS.keywords,
  };
}

export function saveSettings(patch) {
  settingsStore.data = { ...settingsStore.data, ...patch };
  settingsStore.save();
  return getSettings();
}

export function getState() {
  if (!stateStore.data.processed) stateStore.data.processed = {};
  if (!Array.isArray(stateStore.data.emails)) stateStore.data.emails = [];
  if (!Array.isArray(stateStore.data.alerts)) stateStore.data.alerts = [];
  if (!Array.isArray(stateStore.data.queue)) stateStore.data.queue = [];
  return stateStore.data;
}

export function pruneState() {
  const state = getState();

  state.emails = state.emails.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 250);
  state.alerts = state.alerts.sort((a, b) => b.createdAt - a.createdAt).slice(0, 250);

  const ids = Object.keys(state.processed);
  if (ids.length > 3000) {
    ids.sort((a, b) => state.processed[a] - state.processed[b]);
    for (const id of ids.slice(0, ids.length - 3000)) delete state.processed[id];
  }
  stateStore.save();
}

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const store of stores) process.on('exit', () => store.flushSync());
