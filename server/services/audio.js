import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_DIR } from '../config.js';
import { redis, storageMode } from '../db.js';

const AUDIO_TTL_SECONDS = 60 * 60 * 24 * 7; // a week is plenty for a call log

const fileName = (id) => `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.mp3`;

/** Persist a generated voice note. On serverless it lives in Redis. */
export async function saveAudio(id, buffer) {
  if (storageMode === 'redis') {
    await redis.set(`ricky:audio:${id}`, buffer.toString('base64'), { ttlSeconds: AUDIO_TTL_SECONDS });
    return;
  }
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  await fs.writeFile(path.join(AUDIO_DIR, fileName(id)), buffer);
}

export async function readAudio(id) {
  if (storageMode === 'redis') {
    const value = await redis.get(`ricky:audio:${id}`);
    return value ? Buffer.from(value, 'base64') : null;
  }
  try {
    return await fs.readFile(path.join(AUDIO_DIR, fileName(id)));
  } catch {
    return null;
  }
}

export async function deleteAudio(id) {
  if (storageMode === 'redis') {
    await redis.del(`ricky:audio:${id}`);
    return;
  }
  await fs.unlink(path.join(AUDIO_DIR, fileName(id))).catch(() => {});
}

/** Best-effort cleanup of local files; Redis entries expire on their own. */
export async function removeOldAudio(maxAgeDays = 7) {
  if (storageMode === 'redis') return;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const entries = await fs.readdir(AUDIO_DIR).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.mp3')) continue;
    const full = path.join(AUDIO_DIR, entry);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => {});
  }
}
