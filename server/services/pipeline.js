import crypto from 'node:crypto';
import { flushStores, getSettings, getState, pruneState, stateStore } from '../store.js';
import { broadcast } from './events.js';
import { scoreEmail, isQuietNow, humaniseReasons } from './importance.js';
import { connectedEmail, fetchRecentMessages, isConnected } from './gmail.js';
import { activeProvider, buildScript, providerLabel, synthesize } from './tts.js';
import { saveAudio } from './audio.js';
import { sendPush } from './push.js';

let scanning = false;
let queueRunning = false;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const lastAlertAt = (state) => state.alerts.reduce((max, alert) => Math.max(max, alert.createdAt || 0), 0);

/** Pacing rules. Manual calls skip quiet hours, cooldown and the hourly cap. */
export function alertGate(settings, state, { isVip = false, manual = false } = {}) {
  if (!manual && isQuietNow(settings.quietHours) && !(isVip && settings.alertVipDuringQuietHours)) {
    return { ok: false, reason: 'Quiet hours - the call is held until later.' };
  }

  if (!manual) {
    const now = Date.now();
    const last = lastAlertAt(state);
    const cooldown = (Number(settings.cooldownSeconds) || 0) * 1000;
    if (last && now - last < cooldown) {
      const wait = Math.ceil((cooldown - (now - last)) / 1000);
      return { ok: false, reason: `Cooling down between calls (${wait}s left).` };
    }

    const lastHour = state.alerts.filter((alert) => now - alert.createdAt < 3_600_000);
    if (lastHour.length >= (Number(settings.maxAlertsPerHour) || 6)) {
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
  if (!state.queue.some((item) => item.emailId === email.id)) {
    state.queue.push({ emailId: email.id, queuedAt: Date.now(), reason });
  }
  setDecision(email, 'queued', reason);
  stateStore.save();
}

function dequeue(emailId) {
  const state = getState();
  state.queue = state.queue.filter((item) => item.emailId !== emailId);
}

/**
 * Create the voice note, store it, then "call" the app with a web push.
 * The alert exists even if push or TTS fails, so the UI can explain what happened.
 */
export async function deliver(email, { manual = false } = {}) {
  const settings = getSettings();
  const state = getState();
  const id = crypto.randomUUID();
  const reasons = email.reasons || [];

  const script = buildScript(email, {
    reasons,
    ownerName: settings.ownerName,
    style: settings.scriptStyle,
  });

  const alert = {
    id,
    emailId: email.id,
    subject: email.subject || 'Voice alert',
    sender: email.from?.name || email.from?.email || 'Unknown sender',
    senderEmail: email.from?.email || '',
    threadId: email.threadId || null,
    status: 'ringing',
    script,
    score: email.score ?? null,
    reason: humaniseReasons(reasons),
    isVip: Boolean(email.isVip),
    manual,
    test: Boolean(email.test),
    createdAt: Date.now(),
    answeredAt: null,
    seenAt: null,
    audioBytes: 0,
    tts: null,
    ttsError: null,
    push: null,
    note: null,
    error: null,
  };

  state.alerts.unshift(alert);
  setDecision(email, 'calling', manual ? 'Manual call' : 'Triggered automatically');
  stateStore.save();
  broadcast('alert:new', alert);
  broadcast('emails:changed', {});

  if (settings.speakOnAnswer !== false) {
    try {
      const audio = await synthesize(script);
      await saveAudio(id, audio.buffer);
      alert.audioBytes = audio.buffer.length;
      alert.tts = audio.provider;
      if (audio.fallbackReason) {
        alert.note = `${providerLabel(audio.provider)} fallback used: ${audio.fallbackReason.slice(0, 140)}`;
      }
    } catch (error) {
      alert.ttsError = error.message;
      broadcast('log', { level: 'error', message: `Voice generation failed: ${error.message}` });
    }
  }

  if (settings.notifyPush !== false) {
    try {
      alert.push = await sendPush({
        title: 'Ricky is calling',
        body: `${alert.sender} — ${alert.subject}`.slice(0, 180),
        alertId: id,
        url: `/?call=${id}`,
        tag: `ricky-${id}`,
        requireInteraction: true,
        renotify: true,
        timestamp: alert.createdAt,
        vibrate: [400, 200, 400, 200, 900],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' },
        ],
      });

      if (!alert.push.sent) {
        alert.note = alert.push.devices
          ? 'Push could not reach your phone - open the app to answer.'
          : 'No phone subscribed yet. Open Setup and enable call notifications.';
      }
    } catch (error) {
      alert.push = { sent: 0, failed: 1, devices: 0, error: error.message };
      alert.note = 'Push is not configured yet. Open Setup to enable calls.';
    }
  }

  setDecision(email, 'called', 'Rang your phone');
  stateStore.save();
  broadcast('alert:update', alert);
  pruneState();
  await flushStores();
  return alert;
}

/** Decide whether an important email should ring the phone right now. */
export async function handleEmail(email, { manual = false } = {}) {
  const settings = getSettings();
  const state = getState();

  if (!manual) {
    if (email.level !== 'important') {
      setDecision(email, 'skipped', `Score ${email.score} is below the ${settings.threshold} threshold.`);
      stateStore.save();
      return { skipped: true, reason: 'below_threshold' };
    }
    if (settings.autoAlert === false) {
      setDecision(email, 'skipped', 'Auto-call is turned off.');
      stateStore.save();
      return { skipped: true, reason: 'auto_alert_off' };
    }
  }

  const gate = alertGate(settings, state, { isVip: email.isVip, manual });
  if (!gate.ok) {
    enqueue(email, gate.reason);
    broadcast('emails:changed', {});
    return { queued: true, reason: gate.reason };
  }

  dequeue(email.id);
  return deliver(email, { manual });
}

export async function callEmailNow(emailId) {
  const state = getState();
  const email = state.emails.find((e) => e.id === emailId);
  if (!email) throw new Error('That email is not in the list anymore.');
  return handleEmail(email, { manual: true });
}

export async function sendTestAlert() {
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

  return deliver(email, { manual: true });
}

/**
 * Re-run the scoring engine over stored emails. Called at startup and after a
 * settings change so older records reflect rule improvements (for example the
 * security-alert fix) without waiting for the mail to arrive again.
 */
export function rescoreStoredEmails() {
  const settings = getSettings();
  const state = getState();
  const byId = new Map();
  let changed = 0;

  for (const email of state.emails) {
    const { score, level, reasons, isVip } = scoreEmail(email, settings);
    if (email.score !== score || email.level !== level) changed += 1;
    email.score = score;
    email.level = level;
    email.reasons = reasons;
    email.isVip = isVip;
    byId.set(email.id, email);
  }

  // Keep the call log consistent with the emails it was about.
  for (const alert of state.alerts) {
    const email = byId.get(alert.emailId);
    if (email && alert.score !== email.score) {
      alert.score = email.score;
      changed += 1;
    }
  }

  if (changed) stateStore.save();
  return changed;
}

/**
 * A call that nobody answered stops counting as pending after a few minutes.
 * Otherwise it would show as "ringing" forever and could re-open on reload.
 */
export async function expireStaleAlerts(maxAgeMs = 5 * 60_000) {
  const state = getState();
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;

  for (const alert of state.alerts) {
    if (alert.status === 'ringing' && alert.createdAt < cutoff) {
      alert.status = 'missed';
      alert.seenAt = alert.seenAt || null;
      changed = true;
    }
  }

  if (changed) {
    stateStore.save();
    await flushStores();
  }
  return changed;
}

export async function ackAlert(id, action = 'seen') {
  const alert = getState().alerts.find((a) => a.id === id);
  if (!alert) throw new Error('That call is no longer in the log.');

  if (action === 'answered') {
    alert.status = 'answered';
    alert.answeredAt = Date.now();
  } else if (action === 'declined') {
    alert.status = 'declined';
    alert.answeredAt = Date.now();
  } else {
    alert.seenAt = alert.seenAt || Date.now();
  }

  stateStore.save();
  broadcast('alert:update', alert);
  await flushStores();
  return alert;
}

export async function scan({ trigger = 'timer' } = {}) {
  if (scanning) return { busy: true };

  const connected = isConnected();
  if (!connected) {
    const state = getState();
    state.lastScanAt = Date.now();
    state.lastScanResult = { trigger, found: 0, newEmails: 0, calls: 0, at: state.lastScanAt, error: 'Gmail is not connected.' };
    stateStore.save();
    await flushStores();
    return { connected: false, ...state.lastScanResult };
  }

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
      const record = { ...message, score, level, reasons, isVip, seenAt: Date.now(), decision: null };
      state.emails.unshift(record);

      broadcast('email:new', record);
      processed += 1;

      // On the first scan, only call about genuinely new mail so the phone does
      // not ring for everything already sitting unread in the inbox.
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
    await flushStores();
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
    await flushStores();
    throw error;
  } finally {
    scanning = false;
  }
}

/** Retry calls held for quiet hours, cooldown, or the hourly cap. */
export async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    const state = getState();
    const settings = getSettings();

    const maxAge = 6 * 3_600_000;
    state.queue = state.queue.filter((item) => Date.now() - item.queuedAt < maxAge);

    for (const item of [...state.queue]) {
      const email = state.emails.find((e) => e.id === item.emailId);
      if (!email || email.decision?.action === 'called') {
        dequeue(item.emailId);
        continue;
      }

      const gate = alertGate(settings, state, { isVip: email.isVip });
      if (!gate.ok) break;

      dequeue(email.id);
      await deliver(email);
    }

    stateStore.save();
    await flushStores();
  } finally {
    queueRunning = false;
  }
}

export function buildStatus() {
  const settings = getSettings();
  const state = getState();
  const today = startOfToday();
  const provider = activeProvider();

  return {
    gmailConnected: isConnected(),
    gmailAccount: connectedEmail() || state.gmailAccount || null,
    lastScanAt: state.lastScanAt || null,
    lastScanResult: state.lastScanResult || null,
    queued: state.queue.length,
    importantToday: state.emails.filter((e) => e.seenAt >= today && e.level === 'important').length,
    alertsToday: state.alerts.filter((a) => a.createdAt >= today).length,
    answeredToday: state.alerts.filter((a) => a.createdAt >= today && a.status === 'answered').length,
    missedToday: state.alerts.filter((a) => a.createdAt >= today && a.status === 'missed').length,
    monitored: state.emails.length,
    pending: state.alerts.filter((a) => a.status === 'ringing').length,
    ttsProvider: provider,
    ttsLabel: providerLabel(provider),
    threshold: settings.threshold,
  };
}
