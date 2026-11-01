import { Router } from 'express';
import { SETUP, env } from './config.js';
import { getSettings, getState, saveSettings } from './store.js';
import { buildStatus, callEmailNow, drainQueue, scan, sendTestCall } from './services/pipeline.js';
import { restartPoller } from './services/poller.js';
import { buildAuthUrl, connectedEmail, disconnect, isConnected } from './services/gmail.js';
import { getSubscription, listVoices, synthesize } from './services/elevenlabs.js';
import { resolveProvider } from './services/telephony.js';
import { broadcast } from './services/events.js';

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

const normaliseNumber = (value) => {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith('+')) {
    if (digits.length === 10) digits = `+1${digits}`;
    else digits = `+${digits}`;
  }
  return digits;
};

const timeOk = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback);

export function publicSettings() {
  const settings = getSettings();
  return { ...settings, provider: settings.provider || 'auto' };
}

api.get('/status', (req, res) => {
  res.json({
    ...buildStatus(),
    gmailAccount: connectedEmail(),
    gmailConfigured: SETUP.googleConfigured,
    voiceConfigured: SETUP.voiceConfigured,
    setup: {
      google: SETUP.googleConfigured,
      googleConnected: isConnected(),
      voice: SETUP.voiceConfigured,
      elevenAgent: SETUP.elevenAgentConfigured,
      twilio: SETUP.twilioConfigured,
      publicUrlIsLocal: SETUP.publicUrlIsLocal,
      publicBaseUrl: env.publicBaseUrl,
    },
    settings: publicSettings(),
  });
});

api.post('/scan', async (req, res) => {
  try {
    const result = await scan({ trigger: 'manual' });
    res.json(result);
  } catch (error) {
    fail(res, error, 500);
  }
});

api.get('/emails', (req, res) => {
  const state = getState();
  const limit = clampNumber(req.query.limit, 1, 250, 100);
  res.json({
    emails: state.emails.slice(0, limit),
    queue: (state.queue || []).length,
  });
});

api.get('/emails/:id', (req, res) => {
  const email = getState().emails.find((e) => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(email);
});

api.post('/emails/:id/call', async (req, res) => {
  try {
    const call = await callEmailNow(req.params.id);
    res.json({ call });
  } catch (error) {
    fail(res, error);
  }
});

api.get('/calls', (req, res) => {
  res.json({ calls: getState().calls });
});

api.post('/test-call', async (req, res) => {
  try {
    const call = await sendTestCall();
    res.json({ call });
  } catch (error) {
    fail(res, error);
  }
});

api.get('/settings', (req, res) => res.json(publicSettings()));

api.put('/settings', (req, res) => {
  const current = getSettings();
  const body = req.body || {};

  const next = {
    ownerName: String(body.ownerName ?? current.ownerName).slice(0, 60).trim(),
    destinationNumber: normaliseNumber(body.destinationNumber ?? current.destinationNumber),
    provider: ['auto', 'elevenlabs', 'twilio', 'simulate'].includes(body.provider) ? body.provider : current.provider,
    threshold: Math.round(clampNumber(body.threshold, 10, 95, current.threshold)),
    autoCall: body.autoCall !== undefined ? Boolean(body.autoCall) : current.autoCall,
    vipSenders: body.vipSenders !== undefined ? toArray(body.vipSenders) : current.vipSenders,
    ignoreSenders: body.ignoreSenders !== undefined ? toArray(body.ignoreSenders) : current.ignoreSenders,
    keywords: body.keywords !== undefined ? toArray(body.keywords) : current.keywords,
    pollSeconds: Math.round(clampNumber(body.pollSeconds, 15, 3600, current.pollSeconds)),
    cooldownSeconds: Math.round(clampNumber(body.cooldownSeconds, 0, 86_400, current.cooldownSeconds)),
    maxCallsPerHour: Math.round(clampNumber(body.maxCallsPerHour, 1, 50, current.maxCallsPerHour)),
    lookbackMinutes: Math.round(clampNumber(body.lookbackMinutes, 5, 1440, current.lookbackMinutes)),
    quietHours: {
      enabled: Boolean(body.quietHours?.enabled ?? current.quietHours.enabled),
      start: timeOk(body.quietHours?.start, current.quietHours.start),
      end: timeOk(body.quietHours?.end, current.quietHours.end),
    },
    callVipDuringQuietHours: Boolean(body.callVipDuringQuietHours ?? current.callVipDuringQuietHours),
    voiceId: String(body.voiceId ?? current.voiceId).trim(),
    modelId: String(body.modelId ?? current.modelId).trim(),
    previewAudio: body.previewAudio !== undefined ? Boolean(body.previewAudio) : current.previewAudio,
    scriptStyle: ['subject', 'brief', 'detailed'].includes(body.scriptStyle) ? body.scriptStyle : current.scriptStyle,
  };

  saveSettings(next);
  if (next.pollSeconds !== current.pollSeconds) restartPoller();

  broadcast('settings', next);
  broadcast('status', buildStatus());
  res.json({ settings: next, restart: next.pollSeconds !== current.pollSeconds });
});

api.post('/voice/preview', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 600).trim();
  if (!text) return res.status(400).json({ error: 'Say something first.' });
  try {
    const audio = await synthesize(text, {
      voiceId: req.body?.voiceId || getSettings().voiceId,
      modelId: getSettings().modelId,
      id: `preview-${Date.now()}`,
    });
    res.json({ url: audio.url, bytes: audio.bytes });
  } catch (error) {
    fail(res, error, 502);
  }
});

api.get('/voices', async (req, res) => {
  try {
    res.json({ voices: await listVoices() });
  } catch (error) {
    fail(res, error, 502);
  }
});

api.get('/usage', async (req, res) => {
  try {
    res.json({ usage: await getSubscription() });
  } catch (error) {
    res.json({ usage: null, error: error.message });
  }
});

api.get('/agent-prompt', (req, res) => {
  const settings = getSettings();
  const owner = settings.ownerName || 'there';
  const style = settings.scriptStyle || 'subject';

  const opening =
    style === 'subject'
      ? `"Hi ${owner}, this is Ricky. You just got an important email from {{email_sender}} about {{email_subject}}. That's all - talk soon."`
      : style === 'brief'
        ? `"Hi ${owner}, this is Ricky. You just got an important email from {{email_sender}} about {{email_subject}}. {{email_summary}} That's all - talk soon."`
        : `"Hi ${owner}, this is Ricky. You just got an important email from {{email_sender}} about {{email_subject}}. {{email_summary}} I flagged it because it {{email_reason}}. That's all - talk soon."`;

  const prompt = `You are Ricky, a private voice assistant for ${owner}.

At the start of every call you receive these dynamic variables:
- {{email_sender}} - who sent the email
- {{email_subject}} - the subject line
- {{email_summary}} - an optional one-line preview of the email
- {{email_reason}} - why it was flagged as important

Your job is a short alert, not a reading of the email. Open with exactly this structure, in a calm, clear, unhurried voice:

${opening}

After that:
- If the person says "repeat" or "again", repeat the same lines once.
- If they ask what it was about, answer in one sentence using only the subject and summary.
- If they say "stop" or "that's all", say "Got it - talk soon." and end the call.
- Never read the email body verbatim. Never invent details that are not in the variables. Never read URLs or tracking links out loud.
- Keep every reply under 25 spoken words.
- You are not a general assistant on this call. If asked anything unrelated, say you will follow up by text and end politely.`;

  res.json({ prompt, variables: ['email_sender', 'email_subject', 'email_summary', 'email_reason', 'email_score', 'owner_name'] });
});

api.post('/gmail/disconnect', (req, res) => {
  disconnect();
  broadcast('status', buildStatus());
  res.json({ ok: true });
});

api.get('/auth/google/url', (req, res) => {
  try {
    res.json({ url: buildAuthUrl() });
  } catch (error) {
    fail(res, error);
  }
});

api.post('/queue/drain', async (req, res) => {
  try {
    await drainQueue();
    res.json({ ok: true, queued: (getState().queue || []).length });
  } catch (error) {
    fail(res, error, 500);
  }
});

api.get('/events', (req, res) => {
  // Handled in index.js, kept here so the route list is discoverable.
  res.status(404).json({ error: 'Use /api/events on the server root.' });
});

api.get('/health', (req, res) => {
  const settings = getSettings();
  res.json({
    ok: true,
    gmail: isConnected(),
    provider: resolveProvider(settings),
    time: new Date().toISOString(),
  });
});
