import crypto from 'node:crypto';
import { getSettings, getState, pruneState, stateStore } from '../store.js';
import { broadcast } from './events.js';
import { scoreEmail, isQuietNow, humaniseReasons } from './importance.js';
import { connectedEmail, fetchRecentMessages, isConnected } from './gmail.js';
import { buildScript, synthesize } from './elevenlabs.js';
import { placeCall, resolveProvider, providerLabel } from './telephony.js';

let scanning = false;
let queueRunning = false;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function lastCallAt(state) {
  return state.calls.reduce((max, call) => Math.max(max, call.createdAt || 0), 0);
}

export function callGate(settings, state, { provider, isVip = false, manual = false } = {}) {
  if (provider !== 'simulate' && !settings.destinationNumber) {
    return { ok: false, reason: 'No destination phone number is set.' };
  }

  if (!manual && isQuietNow(settings.quietHours)) {
    if (!(isVip && settings.callVipDuringQuietHours)) {
      return { ok: false, reason: 'Quiet hours - the call is held until later.' };
    }
  }

  if (!manual) {
    const now = Date.now();
    const last = lastCallAt(state);
    if (last && now - last < (Number(settings.cooldownSeconds) || 0) * 1000) {
      const wait = Math.ceil(((Number(settings.cooldownSeconds) || 0) * 1000 - (now - last)) / 1000);
      return { ok: false, reason: `Cooling down between calls (${wait}s left).` };
    }

    const lastHour = state.calls.filter((c) => now - c.createdAt < 3_600_000);
    if (lastHour.length >= (Number(settings.maxCallsPerHour) || 6)) {
      return { ok: false, reason: 'Hourly call limit reached.' };
    }
  }

  return { ok: true };
}

function setDecision(email, action, reason) {
  email.decision = { action, reason, at: Date.now() };
}

function enqueue(email, reason) {
  const state = getState();
  if (!Array.isArray(state.queue)) state.queue = [];
  if (!state.queue.some((item) => item.emailId === email.id)) {
    state.queue.push({ emailId: email.id, queuedAt: Date.now(), reason });
  }
  setDecision(email, 'queued', reason);
  stateStore.save();
}

function dequeue(emailId) {
  const state = getState();
  if (!Array.isArray(state.queue)) return;
  state.queue = state.queue.filter((item) => item.emailId !== emailId);
}

/** Generate the voice note, then dial (or simulate). */
export async function deliver(email, provider, { manual = false } = {}) {
  const settings = getSettings();
  const state = getState();
  const callId = crypto.randomUUID();

  const reasons = email.reasons || [];
  const script = buildScript(email, { reasons, ownerName: settings.ownerName, score: email.score, style: settings.scriptStyle });
  const call = {
    id: callId,
    emailId: email.id,
    subject: email.subject,
    sender: email.from?.name || email.from?.email || 'unknown',
    senderEmail: email.from?.email || '',
    to: settings.destinationNumber || null,
    provider,
    providerLabel: providerLabel(provider),
    status: 'preparing',
    script,
    audioUrl: null,
    externalId: null,
    error: null,
    manual,
    createdAt: Date.now(),
  };

  state.calls.unshift(call);
  setDecision(email, 'calling', manual ? 'Manual call' : 'Triggered automatically');
  stateStore.save();
  broadcast('call:new', call);

  try {
    let audio = null;
    if (settings.previewAudio !== false) {
      audio = await synthesize(script, {
        voiceId: settings.voiceId,
        modelId: settings.modelId,
        id: callId,
      });
      call.audioUrl = audio.url;
      call.audioBytes = audio.bytes;
      stateStore.save();
      broadcast('call:update', call);
    }

    const result = await placeCall({
      provider,
      toNumber: settings.destinationNumber,
      audioUrl: audio?.publicUrl,
      callId,
      settings,
      variables: {
        email_sender: `${email.from?.name || ''} ${email.from?.email || ''}`.trim(),
        email_subject: email.subject,
        email_summary: (email.snippet || email.body || '').slice(0, 400),
        email_reason: humaniseReasons(reasons),
        email_score: String(email.score ?? ''),
        call_reason: manual ? 'manual request' : 'important email',
      },
    });

    call.status = result.status;
    call.externalId = result.externalId || null;
    call.note = result.note || null;
    setDecision(email, 'called', `Called via ${providerLabel(provider)}`);
  } catch (error) {
    call.status = 'failed';
    call.error = error.message;
    setDecision(email, 'failed', error.message);
    broadcast('log', { level: 'error', message: `Call failed: ${error.message}` });
  }

  stateStore.save();
  broadcast('call:update', call);
  broadcast('emails:changed', {});
  pruneState();
  return call;
}

/** Decide whether an important email should ring your phone right now. */
export async function handleEmail(email, { manual = false } = {}) {
  const settings = getSettings();
  const state = getState();
  const provider = resolveProvider(settings);

  if (!manual) {
    if (email.level !== 'important') {
      setDecision(email, 'skipped', `Score ${email.score} is below the ${settings.threshold} threshold.`);
      stateStore.save();
      return { skipped: true, reason: 'below_threshold' };
    }
    if (settings.autoCall === false) {
      setDecision(email, 'skipped', 'Auto-call is turned off.');
      stateStore.save();
      return { skipped: true, reason: 'auto_call_off' };
    }
  }

  const gate = callGate(settings, state, { provider, isVip: email.isVip, manual });
  if (!gate.ok) {
    enqueue(email, gate.reason);
    broadcast('emails:changed', {});
    return { queued: true, reason: gate.reason };
  }

  dequeue(email.id);
  return deliver(email, provider, { manual });
}

export async function callEmailNow(emailId) {
  const state = getState();
  const email = state.emails.find((e) => e.id === emailId);
  if (!email) throw new Error('That email is not in the list anymore.');
  return handleEmail(email, { manual: true });
}

export async function sendTestCall() {
  const email = {
    id: `test-${Date.now()}`,
    from: { name: 'Ricky', email: 'ricky@localhost' },
    subject: 'Test call from Ricky',
    snippet: 'If you can hear this, your voice alerts are working and I am ready to watch your inbox.',
    body: '',
    receivedAt: Date.now(),
    labels: [],
    score: 100,
    level: 'important',
    isVip: true,
    reasons: [{ label: 'is a test call', points: 100 }],
    test: true,
  };

  const settings = getSettings();
  const state = getState();
  const provider = resolveProvider(settings);
  const gate = callGate(settings, state, { provider, isVip: true, manual: true });
  if (!gate.ok) throw new Error(gate.reason);
  return deliver(email, provider, { manual: true });
}

export async function scan({ trigger = 'timer' } = {}) {
  if (scanning) return { busy: true };
  if (!isConnected()) return { connected: false };

  scanning = true;
  const settings = getSettings();
  const state = getState();
  const firstRun = !state.lastScanAt;

  try {
    broadcast('scan:start', { trigger });
    const messages = await fetchRecentMessages({
      lookbackMinutes: Math.max(30, Number(settings.lookbackMinutes) || 60),
      maxResults: 20,
    });

    const fresh = messages.filter((m) => !state.processed[m.id]);
    let processed = 0;
    let called = 0;

    for (const message of fresh.slice(0, 20)) {
      state.processed[message.id] = Date.now();

      const { score, level, reasons, isVip } = scoreEmail(message, settings);
      const record = {
        ...message,
        score,
        level,
        reasons,
        isVip,
        seenAt: Date.now(),
        decision: null,
      };
      state.emails.unshift(record);

      broadcast('email:new', record);
      processed += 1;

      // On the very first scan, only call about genuinely new mail so the app
      // does not ring you about everything already sitting in the inbox.
      const tooOldForFirstRun = firstRun && Date.now() - record.receivedAt > 10 * 60_000;

      if (record.level === 'important' && !tooOldForFirstRun) {
        const result = await handleEmail(record);
        if (result && !result.skipped && !result.queued) called += 1;
      } else if (tooOldForFirstRun) {
        setDecision(record, 'skipped', 'Baseline scan - existing unread mail was not called about.');
      }
    }

    state.lastScanAt = Date.now();
    state.lastScanResult = {
      trigger,
      found: messages.length,
      newEmails: processed,
      calls: called,
      at: state.lastScanAt,
      error: null,
    };
    stateStore.save();
    pruneState();

    await drainQueue();

    broadcast('scan:done', state.lastScanResult);
    broadcast('status', buildStatus());
    return state.lastScanResult;
  } catch (error) {
    state.lastScanAt = Date.now();
    state.lastScanResult = {
      trigger,
      found: 0,
      newEmails: 0,
      calls: 0,
      at: state.lastScanAt,
      error: error.message,
    };
    stateStore.save();
    broadcast('scan:error', { message: error.message });
    broadcast('status', buildStatus());
    throw error;
  } finally {
    scanning = false;
  }
}

/** Retry calls that were held for quiet hours, cooldown, or the hourly cap. */
export async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    const state = getState();
    const settings = getSettings();
    if (!Array.isArray(state.queue)) state.queue = [];

    const maxAge = 6 * 3_600_000;
    state.queue = state.queue.filter((item) => Date.now() - item.queuedAt < maxAge);

    for (const item of [...state.queue]) {
      const email = state.emails.find((e) => e.id === item.emailId);
      if (!email || email.decision?.action === 'called') {
        dequeue(item.emailId);
        continue;
      }

      const provider = resolveProvider(settings);
      const gate = callGate(settings, state, { provider, isVip: email.isVip });
      if (!gate.ok) break;

      dequeue(email.id);
      await deliver(email, provider);
    }

    stateStore.save();
  } finally {
    queueRunning = false;
  }
}

export function buildStatus() {
  const settings = getSettings();
  const state = getState();
  const today = startOfToday();
  const provider = resolveProvider(settings);

  return {
    gmailConnected: isConnected(),
    gmailAccount: connectedEmail() || state.gmailAccount || null,
    provider,
    providerLabel: providerLabel(provider),
    destinationNumber: settings.destinationNumber || null,
    lastScanAt: state.lastScanAt || null,
    lastScanResult: state.lastScanResult || null,
    queued: Array.isArray(state.queue) ? state.queue.length : 0,
    importantToday: state.emails.filter((e) => e.seenAt >= today && e.level === 'important').length,
    callsToday: state.calls.filter((c) => c.createdAt >= today && c.status !== 'blocked').length,
    monitored: state.emails.length,
  };
}
