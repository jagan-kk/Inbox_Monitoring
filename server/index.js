import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { AUDIO_DIR, ROOT, env } from './config.js';
import { getState, stateStore, tokenStore } from './store.js';
import { api } from './api.js';
import { subscribe, broadcast } from './services/events.js';
import { connectedEmail, handleCallback, isConnected } from './services/gmail.js';
import { buildStatus, scan } from './services/pipeline.js';
import { startPoller } from './services/poller.js';
import { removeOldAudio } from './services/elevenlabs.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

const xmlEscape = (value = '') =>
  String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// --- Live events ------------------------------------------------------------
app.get('/api/events', (req, res) => subscribe(req, res));

// --- TwiML for outbound Twilio calls ---------------------------------------
app.get('/twiml/:callId', (req, res) => {
  const call = getState().calls.find((c) => c.id === req.params.callId);
  res.type('application/xml');

  if (!call) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>This alert is no longer available.</Say></Response>`);
  }

  if (call.status === 'failed' && !call.audioUrl) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>There was a problem with this alert. Check the Ricky dashboard.</Say></Response>`);
  }

  const audio = call.audioUrl ? `${env.publicBaseUrl}${call.audioUrl}` : null;
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
  if (audio) {
    parts.push(`<Play>${xmlEscape(audio)}</Play>`);
    parts.push('<Pause length="1"/>');
    parts.push('<Say voice="Polly.Matthew">Goodbye.</Say>');
  } else {
    // Fall back to plain text if the MP3 was not generated.
    parts.push(`<Say voice="Polly.Matthew">${xmlEscape(call.script || 'You have an important email.')}</Say>`);
  }
  parts.push('</Response>');
  res.send(parts.join(''));
});

// --- Google OAuth -----------------------------------------------------------
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(String(error))}`);
  if (!code) return res.redirect('/?error=Missing+authorization+code');

  try {
    const tokens = await handleCallback(String(code));
    getState().gmailAccount = tokens.email || connectedEmail();
    stateStore.save();
    broadcast('gmail:connected', { email: getState().gmailAccount });
    broadcast('status', buildStatus());
    // A first look right after connecting makes the dashboard feel alive.
    scan({ trigger: 'after-connect' }).catch((e) => console.error('[scan]', e.message));
    res.redirect('/?connected=1');
  } catch (err) {
    console.error('[oauth]', err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// --- API --------------------------------------------------------------------
app.use('/api', api);

// --- Static assets ----------------------------------------------------------
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h', fallthrough: false }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/audio')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

// --- Boot -------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, '.env'))) {
  console.warn('[ricky] No .env file found - copy .env.example to .env (the app will run in simulation mode).');
}

const server = app.listen(env.port, env.host, async () => {
  const seconds = startPoller();
  console.log(`\n  Ricky is listening on http://${env.host}:${env.port}`);
  console.log(`  Gmail: ${isConnected() ? `connected (${connectedEmail() || 'unknown account'})` : 'not connected'}`);
  console.log(`  Scanning every ${seconds}s\n`);

  await removeOldAudio(7);
  setTimeout(() => scan({ trigger: 'startup' }).catch(() => {}), 2500);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${env.port} is already in use. Set PORT to something else in .env.`);
    process.exit(1);
  }
  throw error;
});

function shutdown() {
  console.log('\n[ricky] shutting down');
  for (const store of [stateStore, tokenStore]) store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => console.error('[uncaught]', error));
process.on('unhandledRejection', (error) => console.error('[unhandled]', error));
