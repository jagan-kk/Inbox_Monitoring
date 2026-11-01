import crypto from 'node:crypto';
import { Router } from 'express';
import { SETUP, deriveSetup, env } from './config.js';
import { flushStores, getSettings, getState, saveSettings } from './store.js';
import { ackAlert, buildStatus, callEmailNow, drainQueue, expireStaleAlerts, rescoreStoredEmails, scan, sendTestAlert } from './services/pipeline.js';
import { restartPoller } from './services/poller.js';
import { buildAuthUrl, connectedEmail, disconnect, isConnected } from './services/gmail.js';
import { activeProvider, providerLabel, synthesize } from './services/tts.js';
import { readAudio, saveAudio } from './services/audio.js';
import { addSubscription, publicKey, pushStatus, removeSubscription, sendPush } from './services/push.js';
import { broadcast } from './services/events.js';
import { storageMode } from './db.js';

export const api = Router();

const fail = (res, error, status = 400) => res.status(status).json({ error: error.message || String(error) });

const toArray = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
};

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const timeOk = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback);

const boolOr = (value, fallback) => (value === undefined ? fallback : Boolean(value));

/** Absolute origin for this deployment (works behind Render/Vercel proxies). */
export function baseUrl(req) {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  return `${req.protocol}://${req.get('host')}`;
}

const redirectUri = (req) => env.google.redirectUri || `${baseUrl(req)}/oauth2callback`;

export function publicSettings() {
  const settings = getSettings();
  return { ...settings };
}

/* ---------------------------------------------------------------- status --- */

api.get('/status', async (req, res) => {
  await expireStaleAlerts().catch(() => {});
  res.json({
    ...buildStatus(),
    gmailAccount: connectedEmail(),
    setup: { ...deriveSetup(), google: SETUP.google },
    push: pushStatus(),
    settings: publicSettings(),
    server: {
      storage: storageMode,
      serverless: env.isServerless,
      selfPoll: env.selfPoll,
      publicBaseUrl: baseUrl(req),
    },
  });
});

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    gmail: isConnected(),
    tts: activeProvider(),
    push: pushStatus().devices,
    storage: storageMode,
    time: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------- scanning --- */

api.post('/scan', async (req, res) => {
  try {
    const result = await scan({ trigger: 'manual' });
    res.json(result);
  } catch (error) {
    fail(res, error, 500);
  }
});

/** Scheduler hook for GitHub Actions / cron-job.org. */
api.all('/cron/scan', async (req, res) => {
  if (!env.cronSecret) {
    return res.status(403).json({ error: 'Set CRON_SECRET to enable scheduled scans.' });
  }
  const provided = String(req.query.key || req.get('x-cron-key') || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(env.cronSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Bad cron key.' });
  }

  try {
    const result = await scan({ trigger: 'cron' });
    res.json({ ok: true, ...result });
  } catch (error) {
    fail(res, error, 500);
  }
});

api.post('/queue/drain', async (req, res) => {
  try {
    await drainQueue();
    res.json({ ok: true, queued: getState().queue.length });
  } catch (error) {
    fail(res, error, 500);
  }
});

/* --------------------------------------------------------------- emails --- */

api.get('/emails', (req, res) => {
  const state = getState();
  const limit = clampNumber(req.query.limit, 1, 250, 100);
  res.json({ emails: state.emails.slice(0, limit), queue: state.queue.length });
});

api.get('/emails/:id', (req, res) => {
  const email = getState().emails.find((e) => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(email);
});

api.post('/emails/:id/call', async (req, res) => {
  try {
    const alert = await callEmailNow(req.params.id);
    res.json({ call: alert, alert });
  } catch (error) {
    fail(res, error);
  }
});

/* --------------------------------------------------------------- alerts --- */

api.get('/alerts', async (req, res) => {
  await expireStaleAlerts().catch(() => {});
  const state = getState();
  const limit = clampNumber(req.query.limit, 1, 250, 100);
  res.json({ alerts: state.alerts.slice(0, limit), pending: state.alerts.filter((a) => a.status === 'ringing').length });
});

api.get('/alerts/:id', (req, res) => {
  const alert = getState().alerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'That call is no longer in the log.' });
  res.json(alert);
});

api.post('/alerts/:id/ack', async (req, res) => {
  try {
    const alert = await ackAlert(req.params.id, String(req.body?.action || 'seen'));
    res.json({ alert });
  } catch (error) {
    fail(res, error);
  }
});

api.post('/alerts/test', async (req, res) => {
  try {
    const alert = await sendTestAlert();
    res.json({ alert, call: alert });
  } catch (error) {
    fail(res, error);
  }
});

// Backwards-compatible names.
api.get('/calls', (req, res) => res.json({ calls: getState().alerts, alerts: getState().alerts }));
api.post('/test-call', async (req, res) => {
  try {
    const alert = await sendTestAlert();
    res.json({ call: alert, alert });
  } catch (error) {
    fail(res, error);
  }
});

/* ---------------------------------------------------------------- audio --- */

api.get('/audio/:id', async (req, res) => {
  const buffer = await readAudio(req.params.id);
  if (!buffer) return res.status(404).json({ error: 'Audio is not available any more.' });

  res.set('Content-Type', 'audio/mpeg');
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, max-age=3600');

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : buffer.length - 1;
      if (start >= buffer.length) {
        res.status(416).set('Content-Range', `bytes */${buffer.length}`).end();
        return;
      }
      const slice = buffer.subarray(start, Math.min(end, buffer.length - 1) + 1);
      res
        .status(206)
        .set('Content-Range', `bytes ${start}-${start + slice.length - 1}/${buffer.length}`)
        .set('Content-Length', String(slice.length))
        .end(slice);
      return;
    }
  }

  res.set('Content-Length', String(buffer.length)).end(buffer);
});

api.post('/voice/preview', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 600).trim();
  if (!text) return res.status(400).json({ error: 'Say something first.' });

  try {
    const audio = await synthesize(text);
    const id = `preview-${Date.now()}`;
    await saveAudio(id, audio.buffer);
    res.json({ url: `/api/audio/${id}`, bytes: audio.buffer.length, tts: audio.provider });
  } catch (error) {
    fail(res, error, 502);
  }
});

/* ----------------------------------------------------------- push (calls) --- */

api.get('/push/status', async (req, res) => {
  res.json({ ...pushStatus(), key: await publicKey() });
});

api.get('/push/key', async (req, res) => {
  res.json({ key: await publicKey() });
});

api.post('/push/subscribe', async (req, res) => {
  try {
    const subscription = req.body?.subscription || req.body;
    const devices = await addSubscription({
      ...subscription,
      userAgent: subscription?.userAgent || req.get('user-agent'),
    });
    broadcast('status', buildStatus());
    res.json({ ok: true, devices });
  } catch (error) {
    fail(res, error);
  }
});

api.post('/push/unsubscribe', async (req, res) => {
  try {
    const devices = await removeSubscription(String(req.body?.endpoint || ''));
    res.json({ ok: true, devices });
  } catch (error) {
    fail(res, error);
  }
});

api.post('/push/test', async (req, res) => {
  try {
    const result = await sendPush({
      title: 'Ricky is calling',
      body: 'This is a test call. Your phone will ring like this when something important lands.',
      alertId: 'test',
      url: '/?call=test',
      tag: 'ricky-test',
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 900],
      actions: [
        { action: 'answer', title: 'Answer' },
        { action: 'decline', title: 'Decline' },
      ],
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    fail(res, error);
  }
});

/* -------------------------------------------------------------- settings --- */

api.get('/settings', (req, res) => res.json(publicSettings()));

api.put('/settings', async (req, res) => {
  const current = getSettings();
  const body = req.body || {};

  const next = {
    ownerName: String(body.ownerName ?? current.ownerName).slice(0, 60).trim(),
    threshold: Math.round(clampNumber(body.threshold, 10, 95, current.threshold)),
    autoAlert: boolOr(body.autoAlert ?? body.autoCall, current.autoAlert),
    vipSenders: body.vipSenders !== undefined ? toArray(body.vipSenders) : current.vipSenders,
    ignoreSenders: body.ignoreSenders !== undefined ? toArray(body.ignoreSenders) : current.ignoreSenders,
    keywords: body.keywords !== undefined ? toArray(body.keywords) : current.keywords,
    pollSeconds: Math.round(clampNumber(body.pollSeconds, 15, 3600, current.pollSeconds)),
    cooldownSeconds: Math.round(clampNumber(body.cooldownSeconds, 0, 86_400, current.cooldownSeconds)),
    maxAlertsPerHour: Math.round(
      clampNumber(body.maxAlertsPerHour ?? body.maxCallsPerHour, 1, 50, current.maxAlertsPerHour)
    ),
    lookbackMinutes: Math.round(clampNumber(body.lookbackMinutes, 5, 1440, current.lookbackMinutes)),
    quietHours: {
      enabled: Boolean(body.quietHours?.enabled ?? current.quietHours.enabled),
      start: timeOk(body.quietHours?.start, current.quietHours.start),
      end: timeOk(body.quietHours?.end, current.quietHours.end),
    },
    alertVipDuringQuietHours: boolOr(
      body.alertVipDuringQuietHours ?? body.callVipDuringQuietHours,
      current.alertVipDuringQuietHours
    ),
    scriptStyle: ['subject', 'brief', 'detailed'].includes(body.scriptStyle) ? body.scriptStyle : current.scriptStyle,
    notifyPush: boolOr(body.notifyPush, current.notifyPush),
    ringtone: boolOr(body.ringtone, current.ringtone),
    speakOnAnswer: boolOr(body.speakOnAnswer, current.speakOnAnswer),
  };

  saveSettings(next);
  rescoreStoredEmails();
  const restart = next.pollSeconds !== current.pollSeconds;
  if (restart && env.selfPoll) restartPoller();

  broadcast('settings', next);
  broadcast('status', buildStatus());
  await flushStores();
  res.json({ settings: next, restart });
});

/* ----------------------------------------------------------------- auth --- */

api.get('/auth/google/url', (req, res) => {
  try {
    res.json({ url: buildAuthUrl(crypto.randomUUID(), redirectUri(req)) });
  } catch (error) {
    fail(res, error);
  }
});

api.post('/gmail/disconnect', async (req, res) => {
  disconnect();
  broadcast('status', buildStatus());
  await flushStores();
  res.json({ ok: true });
});

api.get('/events', (req, res) => {
  // The live stream is mounted at /api/events in app.js.
  res.status(404).json({ error: 'Use /api/events on the server root.' });
});
