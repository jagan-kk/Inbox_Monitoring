import { createApp } from './app.js';
import { env } from './config.js';
import { flushStores, loadStores } from './store.js';
import { initPush } from './services/push.js';
import { startPoller, stopPoller } from './services/poller.js';
import { removeOldAudio } from './services/audio.js';
import { rescoreStoredEmails, scan } from './services/pipeline.js';

await loadStores({ force: true });
await initPush().catch((error) => console.error('[push]', error.message));

const rescored = rescoreStoredEmails();
if (rescored) {
  console.log(`[score] updated ${rescored} stored email${rescored === 1 ? '' : 's'} with the current rules.`);
  await flushStores();
}

const app = createApp();

const server = app.listen(env.port, env.host, async () => {
  const seconds = env.selfPoll ? startPoller() : null;

  console.log(`\n  Ricky is listening on http://${env.host}:${env.port}`);
  console.log(`  Gmail:    ${env.google.clientId ? 'configured' : 'not configured'}`);
  console.log(`  Voice:    ${env.tts.elevenApiKey ? 'ElevenLabs (Edge fallback)' : 'Edge neural (free)'}`);
  console.log(`  Storage:  ${env.redis.url ? 'Upstash Redis' : 'local data/ folder'}`);
  console.log(`  Push:     ${env.vapid.publicKey ? 'VAPID from env' : 'auto-generated keys'}`);
  console.log(`  Access:   OPEN - register and sign in to use`);
  console.log(
    seconds
      ? `  Scanning every ${seconds}s\n`
      : `  In-process polling off - call ${env.publicBaseUrl || `http://${env.host}:${env.port}`}/api/cron/scan?key=...\n`
  );

  removeOldAudio(7).catch(() => {});
  setTimeout(() => scan({ trigger: 'startup' }).catch(() => {}), 2500);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${env.port} is already in use. Set PORT to something else.`);
    process.exit(1);
  }
  throw error;
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[ricky] shutting down');
  stopPoller();
  await flushStores().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => console.error('[uncaught]', error));
process.on('unhandledRejection', (error) => console.error('[unhandled]', error));
