import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_SETTINGS } from './config.js';

/** Tiny atomic JSON store. Good enough for a single-user private app. */
export class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.data = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.fallback);
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 100);
    return this;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const settingsStore = new JsonStore(path.join(DATA_DIR, 'settings.json'), {});
export const stateStore = new JsonStore(path.join(DATA_DIR, 'state.json'), {
  processed: {},
  emails: [],
  calls: [],
  lastScanAt: null,
  lastScanResult: null,
  stats: {},
});
export const tokenStore = new JsonStore(path.join(DATA_DIR, 'google-tokens.json'), {});

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
  if (!Array.isArray(stateStore.data.calls)) stateStore.data.calls = [];
  return stateStore.data;
}

export function pruneState() {
  const state = getState();

  state.emails = state.emails
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 250);
  state.calls = state.calls
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 250);

  const ids = Object.keys(state.processed);
  if (ids.length > 3000) {
    ids.sort((a, b) => state.processed[a] - state.processed[b]);
    for (const id of ids.slice(0, ids.length - 3000)) delete state.processed[id];
  }
  stateStore.save();
}

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const store of [settingsStore, stateStore, tokenStore]) {
  process.on('exit', () => store.flush());
}
