const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  status: null,
  emails: [],
  alerts: [],
  settings: null,
  filter: 'all',
  view: 'overview',
  settingsDirty: false,
  scanning: false,
  voicesLoaded: false,
  call: null,
  callStartedAt: 0,
  callTick: null,
  ringTimer: null,
  audioCtx: null,
  deferredInstall: null,
  installNeedsReload: false,
  pollTimer: null,
  ringed: new Set(),
};

const VIEW_COPY = {
  overview: ['Overview', 'Watching your inbox and calling when it matters.'],
  inbox: ['Inbox', 'Every email Ricky scored, and why.'],
  calls: ['Calls', 'Each call Ricky made, and the voice he used.'],
  settings: ['Settings', 'Tune what is important and how Ricky reaches you.'],
  setup: ['Setup', 'Gmail, calls on this phone, and this deployment.'],
};

const TTS_LABEL = { elevenlabs: 'ElevenLabs', edge: 'Edge neural' };

/* ------------------------------------------------------------------ utils --- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Collapse stray newlines/whitespace so a one-line preview does not reserve two. */
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const initials = (name = '') => {
  const clean = String(name).replace(/["']/g, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0]?.toUpperCase() || '');
};

const rel = (ts) => {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const statusLabel = (status) =>
  ({ ringing: 'ringing', answered: 'answered', declined: 'declined', missed: 'missed', failed: 'failed' })[status] || status || 'call';

const badgeClass = (status) =>
  ({ answered: 'answered', ringing: 'ringing', declined: 'declined', missed: 'missed', failed: 'failed' })[status] || 'normal';

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (res.status === 401 && data?.login) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Sign in required');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, kind === 'error' ? 6500 : 3600);
}

let refreshTimer = null;
function scheduleRefresh(delay = 300) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAll(true), delay);
}

/* ----------------------------------------------------------------- render --- */

async function refreshAll(silent = false) {
  try {
    const [status, emails, calls] = await Promise.all([
      api('/api/status'),
      api('/api/emails'),
      api('/api/alerts'),
    ]);
    state.status = status;
    state.settings = status.settings;
    state.emails = emails.emails || [];
    state.alerts = calls.alerts || [];
    render();
  } catch (error) {
    if (!silent) toast(error.message, 'error');
  }
}

function render() {
  renderStatus();
  renderStats();
  renderFeed();
  renderActivity();
  renderInbox();
  renderCalls();
  renderChecklist();
  renderFacts();
  renderPushUI();
  if (!state.settingsDirty && state.settings) fillSettings(state.settings);
}

function renderStatus() {
  const status = state.status || {};
  const setup = status.setup || {};
  const brandState = $('#brand-state');
  const conn = $('#conn');

  if (!status.gmailConnected) {
    brandState.textContent = 'connect gmail';
    conn.className = 'conn warn';
  } else if (status.lastScanResult?.error) {
    brandState.textContent = 'scan needs attention';
    conn.className = 'conn bad';
  } else {
    brandState.textContent = 'watching inbox';
    conn.className = 'conn ok';
  }

  const banner = $('#connect-banner');
  const connected = Boolean(status.gmailConnected);
  banner.classList.toggle('hidden', connected);
  if (!setup.google) {
    $('#banner-copy').textContent = 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then connect Google.';
  } else if (!connected) {
    $('#banner-copy').textContent = 'Connect Google so Ricky can watch for important mail.';
  }

  const important = state.emails.filter((e) => e.level === 'important').length;
  const count = $('#tab-inbox-count');
  count.textContent = String(important);
  count.classList.toggle('hidden', important === 0);
}

function renderStats() {
  const status = state.status || {};
  $('#stat-important').textContent = status.importantToday ?? 0;
  $('#stat-calls').textContent = status.alertsToday ?? 0;
  $('#stat-queued').textContent = status.queued ?? 0;
  $('#stat-lastscan').textContent = rel(status.lastScanAt);

  const result = status.lastScanResult;
  $('#stat-lastscan-result').textContent = result?.error
    ? `error: ${result.error.slice(0, 60)}`
    : result
      ? `${result.newEmails} new · ${result.calls} called`
      : 'polling is idle';

  $('#stat-tts').textContent = TTS_LABEL[status.ttsProvider] || 'voice ready';
}

function emailItem(email, { compact = false } = {}) {
  const level = email.level || 'normal';
  const decision = email.decision || {};
  const reasons = (email.reasons || []).filter((r) => r.points > 0).slice(0, compact ? 1 : 2);
  const avatarClass = email.isVip ? '' : level === 'important' ? 'alt' : 'dim';

  return `
    <div class="item">
      <div class="avatar ${avatarClass}">${esc(initials(email.from?.name || email.from?.email))}</div>
      <div class="item-main">
        <div class="item-top">
          <span class="item-from">${esc(email.from?.name || email.from?.email || 'Unknown sender')}</span>
          <span class="item-time">${rel(email.receivedAt)}</span>
        </div>
        <div class="item-subject">${esc(email.subject)}</div>
        ${compact ? '' : `<div class="item-snippet">${esc(squash(email.snippet || ''))}</div>`}
        <div class="item-meta">
          <span class="badge ${level}">${level === 'important' ? 'Important' : level === 'watch' ? 'Watch' : 'Normal'} · ${email.score ?? 0}</span>
          ${reasons.map((r) => `<span class="reason">${esc(r.label)}</span>`).join('')}
          ${!compact || decision.action === 'called' ? `<span class="badge ${decision.action === 'called' ? 'called' : 'normal'}">${esc(decisionLabel(decision))}</span>` : ''}
        </div>
        ${compact ? '' : itemActions(email)}
      </div>
      <div class="item-side">
        <button class="icon-btn" data-action="call" data-id="${esc(email.id)}" aria-label="Call me about this email" title="Call me">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3l2 5-3 2a12 12 0 0 0 4 4l2-3 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 5 6a2 2 0 0 1 2-2Z" /></svg>
        </button>
      </div>
    </div>`;
}

function itemActions(email) {
  const gmailUrl = email.threadId
    ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.threadId)}`
    : 'https://mail.google.com';
  return `<div class="item-actions">
    <button class="btn small ghost" data-action="call" data-id="${esc(email.id)}" type="button">Call me now</button>
    <a class="btn small ghost" href="${gmailUrl}" target="_blank" rel="noreferrer">Open in Gmail</a>
  </div>`;
}

function decisionLabel(decision = {}) {
  if (!decision.action) return 'scored';
  if (decision.action === 'called') return 'called';
  if (decision.action === 'queued') return 'held';
  if (decision.action === 'failed') return 'failed';
  return 'no call';
}

function renderFeed() {
  const emails = [...state.emails]
    .sort((a, b) => (b.level === 'important') - (a.level === 'important') || b.score - a.score)
    .slice(0, 4);

  $('#feed').innerHTML = emails.length
    ? emails.map((e) => emailItem(e, { compact: true })).join('')
    : '<div class="empty">No scored email yet. Ricky checks every minute.</div>';
}

function renderActivity() {
  const alerts = state.alerts.slice(0, 4);
  $('#activity').innerHTML = alerts.length
    ? alerts.map(callItem).join('')
    : '<div class="empty">No calls placed yet.</div>';
}

function callItem(alert) {
  const play = alert.audioBytes
    ? `<button class="icon-btn" data-action="play" data-id="${esc(alert.id)}" aria-label="Play the voice note" title="Play">
         <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
       </button>`
    : '';

  return `
    <div class="call-item">
      <div class="call-time">${rel(alert.createdAt)}<br>${clock(alert.createdAt)}</div>
      <div class="call-body">
        <div class="call-subject">${esc(alert.subject || 'Voice alert')}</div>
        <div class="call-sub">${esc(alert.sender || '')}${alert.manual ? ' · manual' : ''}${alert.test ? ' · test' : ''}</div>
        <div class="item-meta">
          <span class="badge ${badgeClass(alert.status)}">${esc(statusLabel(alert.status))}</span>
          ${alert.tts ? `<span class="reason">${esc(TTS_LABEL[alert.tts] || alert.tts)}</span>` : ''}
          ${alert.score ? `<span class="reason">score ${esc(alert.score)}</span>` : ''}
        </div>
      </div>
      <div class="item-side">${play}</div>
    </div>`;
}

function renderInbox() {
  const filter = state.filter;
  const list = state.emails.filter((email) => {
    if (filter === 'important') return email.level === 'important';
    if (filter === 'watch') return email.level === 'watch';
    if (filter === 'called') return email.decision?.action === 'called';
    return true;
  });

  $('#inbox-summary').textContent = `${list.length} of ${state.emails.length} scored emails`;
  $('#inbox-list').innerHTML = list.length
    ? list.map((email) => emailItem(email)).join('')
    : '<div class="empty">Nothing matches this filter yet.</div>';
}

function renderCalls() {
  $('#calls-summary').textContent = state.alerts.length ? `${state.alerts.length} total` : '';
  $('#calls-list').innerHTML = state.alerts.length
    ? state.alerts.map(callItem).join('')
    : '<div class="empty">No calls yet. Tap "Test the call" to try it.</div>';
}

function renderChecklist() {
  const status = state.status || {};
  const setup = status.setup || {};
  const devices = status.push?.devices || 0;
  const installed = isStandalone();

  const items = [
    {
      title: 'Google OAuth client',
      detail: setup.google ? 'Client ID and secret loaded' : 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      ok: Boolean(setup.google),
      pill: setup.google ? 'ready' : 'missing',
    },
    {
      title: 'Gmail connected',
      detail: status.gmailConnected ? `Watching ${status.gmailAccount || 'your inbox'}` : 'Authorise read-only Gmail access',
      ok: Boolean(status.gmailConnected),
      pill: status.gmailConnected ? 'live' : 'connect',
    },
    {
      title: 'Voice engine',
      detail: status.ttsProvider === 'elevenlabs' ? 'ElevenLabs, with free Edge fallback' : 'Edge neural voices (free)',
      ok: true,
      pill: TTS_LABEL[status.ttsProvider] || 'ready',
    },
    {
      title: 'Calls on this phone',
      detail: devices ? `${devices} device${devices === 1 ? '' : 's'} subscribed` : 'Turn on call notifications below',
      ok: devices > 0,
      pill: devices ? 'on' : 'off',
    },
    {
      title: 'App installed',
      detail: installed ? 'Running as a home-screen app' : 'Add to Home Screen for full-screen calls',
      ok: installed,
      pill: installed ? 'installed' : 'optional',
    },
    {
      title: 'Durable storage',
      detail:
        setup.storage === 'redis'
          ? 'Upstash Redis - survives restarts'
          : setup.selfPoll
            ? 'Local data/ folder'
            : 'Ephemeral filesystem - connect Upstash Redis',
      ok: setup.storage === 'redis' || Boolean(setup.selfPoll),
      pill: setup.storage === 'redis' ? 'redis' : 'local',
    },
    {
      title: 'Public HTTPS address',
      detail: setup.publicUrlIsLocal ? 'Required for push calls on your phone' : setup.publicBaseUrl,
      ok: !setup.publicUrlIsLocal,
      pill: setup.publicUrlIsLocal ? 'local only' : 'public',
    },
    {
      title: 'Scheduler',
      detail: setup.selfPoll ? `In-process polling every ${state.settings?.pollSeconds || 60}s` : setup.cron ? 'External cron via /api/cron/scan' : 'Add CRON_SECRET and a cron ping',
      ok: Boolean(setup.selfPoll || setup.cron),
      pill: setup.selfPoll ? 'built in' : setup.cron ? 'cron' : 'missing',
    },
  ];

  $('#checklist').innerHTML = items
    .map(
      (item, index) => `
      <li class="${item.ok ? 'ok' : 'bad'}">
        <span class="check">${item.ok ? '✓' : index + 1}</span>
        <div><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
        <em class="pill ${item.ok ? 'ok' : 'warn'}">${esc(item.pill)}</em>
      </li>`
    )
    .join('');

  const connectBtn = $('#btn-connect');
  connectBtn.textContent = status.gmailConnected ? 'Reconnect Gmail' : 'Connect Gmail';
  connectBtn.disabled = !setup.google;

  $('#voice-pill').textContent = TTS_LABEL[status.ttsProvider] || 'auto';
  $('#voice-pill').className = `pill ${setup.elevenLabs ? 'ok' : ''}`;
}

function renderFacts() {
  const status = state.status || {};
  const setup = status.setup || {};
  const facts = [
    ['Storage', setup.storage === 'redis' ? 'Upstash Redis' : 'local files'],
    ['Hosting', state.status?.server?.serverless ? 'serverless' : 'long running'],
    ['Voice', TTS_LABEL[status.ttsProvider] || 'auto'],
    ['Phones', String(status.push?.devices ?? 0)],
    ['Public URL', setup.publicBaseUrl || 'localhost only'],
    ['Scheduler', setup.selfPoll ? 'built in' : setup.cron ? 'external cron' : 'none'],
  ];

  $('#facts').innerHTML = facts
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd title="${esc(value)}">${esc(value)}</dd>`)
    .join('');
}

/* ---------------------------------------------------------------- settings --- */

function fillSettings(settings) {
  const form = $('#settings-form');
  if (!form) return;

  form.ownerName.value = settings.ownerName || '';
  form.threshold.value = settings.threshold;
  $('#threshold-out').textContent = settings.threshold;
  form.autoAlert.checked = settings.autoAlert !== false;
  form.vipSenders.value = (settings.vipSenders || []).join('\n');
  form.ignoreSenders.value = (settings.ignoreSenders || []).join('\n');
  form.keywords.value = (settings.keywords || []).join(', ');
  form.pollSeconds.value = settings.pollSeconds;
  form.cooldownSeconds.value = settings.cooldownSeconds;
  form.maxAlertsPerHour.value = settings.maxAlertsPerHour;
  form.lookbackMinutes.value = settings.lookbackMinutes;
  form.quietHoursEnabled.checked = Boolean(settings.quietHours?.enabled);
  form.quietStart.value = settings.quietHours?.start || '22:00';
  form.quietEnd.value = settings.quietHours?.end || '07:00';
  form.alertVipDuringQuietHours.checked = settings.alertVipDuringQuietHours !== false;
  form.scriptStyle.value = settings.scriptStyle || 'brief';
  form.notifyPush.checked = settings.notifyPush !== false;
  form.ringtone.checked = settings.ringtone !== false;
  form.speakOnAnswer.checked = settings.speakOnAnswer !== false;

  state.settingsDirty = false;
}

function readSettings() {
  const form = $('#settings-form');
  const value = (name) => form.elements[name]?.value ?? '';
  const checked = (name) => Boolean(form.elements[name]?.checked);

  return {
    ownerName: value('ownerName'),
    threshold: Number(value('threshold')),
    autoAlert: checked('autoAlert'),
    vipSenders: value('vipSenders').split('\n').map((v) => v.trim()).filter(Boolean),
    ignoreSenders: value('ignoreSenders').split('\n').map((v) => v.trim()).filter(Boolean),
    keywords: value('keywords').split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
    pollSeconds: Number(value('pollSeconds')),
    cooldownSeconds: Number(value('cooldownSeconds')),
    maxAlertsPerHour: Number(value('maxAlertsPerHour')),
    lookbackMinutes: Number(value('lookbackMinutes')),
    quietHours: {
      enabled: checked('quietHoursEnabled'),
      start: value('quietStart') || '22:00',
      end: value('quietEnd') || '07:00',
    },
    alertVipDuringQuietHours: checked('alertVipDuringQuietHours'),
    scriptStyle: value('scriptStyle'),
    notifyPush: checked('notifyPush'),
    ringtone: checked('ringtone'),
    speakOnAnswer: checked('speakOnAnswer'),
  };
}

/* ------------------------------------------------------------------- push --- */

const isiOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/**
 * Register the worker (retrying once or twice). A failed first attempt — for
 * example because a proxy served an HTML warning page instead of the script —
 * otherwise hides the install prompt until the next manual reload.
 */
async function registerSW(attempt = 0) {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    return registration;
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      return registerSW(attempt + 1);
    }
    console.warn('[ricky] service worker registration failed', error);
    return null;
  }
}

async function serviceWorkerReady() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration && (registration.active || registration.waiting || registration.installing));
  } catch {
    return false;
  }
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
};

async function getSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function renderPushUI() {
  const pill = $('#push-pill');
  const copy = $('#push-copy');
  const enable = $('#btn-enable-push');
  const disable = $('#btn-disable-push');
  const test = $('#btn-test-push');
  const devices = state.status?.push?.devices ?? 0;

  if (!pushSupported()) {
    pill.textContent = 'unsupported';
    pill.className = 'pill bad';
    copy.textContent = isiOS()
      ? 'On iPhone, add Ricky to your Home Screen first, then open it from there to enable calls.'
      : 'This browser cannot receive push calls. Try Chrome on Android or Safari on iOS 16.4+.';
    enable.classList.add('hidden');
    disable.classList.add('hidden');
    test.classList.add('hidden');
    return;
  }

  const permission = Notification.permission;

  if (devices > 0) {
    pill.textContent = 'on';
    pill.className = 'pill ok';
    copy.textContent = `Ricky will ring ${devices} device${devices === 1 ? '' : 's'} when something important lands.`;
    enable.classList.add('hidden');
    disable.classList.remove('hidden');
    test.classList.remove('hidden');
  } else {
    pill.textContent = permission === 'denied' ? 'blocked' : 'off';
    pill.className = `pill ${permission === 'denied' ? 'bad' : 'warn'}`;
    copy.textContent =
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then tap Enable again.'
        : isiOS() && !isStandalone()
          ? 'On iPhone: share → Add to Home Screen, then open Ricky from your Home Screen and tap Enable.'
          : 'Enable calls so Ricky can ring this phone even when the app is closed.';
    enable.classList.remove('hidden');
    disable.classList.add('hidden');
    test.classList.add('hidden');
  }
}

async function enablePush() {
  if (!pushSupported()) {
    toast('This browser cannot receive push calls.', 'error');
    return;
  }
  if (isiOS() && !isStandalone()) {
    toast('On iPhone, add Ricky to your Home Screen first, then enable calls.', 'error');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications were not allowed. Enable them in browser settings.', 'error');
      renderPushUI();
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    await api('/api/push/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
    toast('Calls are on. Ricky can ring this phone now.', 'ok');
    await refreshAll(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function disablePush() {
  try {
    const subscription = await getSubscription();
    if (subscription) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    toast('Calls are off for this device.', 'ok');
    await refreshAll(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ install --- */

let installBarTimer = null;

function updateInstallBar() {
  const bar = $('#install-bar');
  if (!bar) return;
  const show =
    state.view === 'overview' &&
    Boolean(state.deferredInstall) &&
    !localStorage.getItem('ricky-install-dismissed');
  bar.classList.toggle('hidden', !show);

  // A snackbar should get out of the way; Setup keeps the permanent entry point.
  if (show && !installBarTimer) {
    installBarTimer = setTimeout(() => {
      bar.classList.add('hidden');
      installBarTimer = null;
    }, 12000);
  }
}

async function setupInstall() {
  if (isStandalone()) {
    $('#install-card').classList.add('hidden');
    $('#install-bar').classList.add('hidden');
    return;
  }

  if (isiOS()) {
    $('#install-copy').textContent = 'On iPhone: tap Share, then "Add to Home Screen". Open Ricky from your Home Screen for full-screen calls and push.';
    $('#install-pill').textContent = 'iphone';
    $('#install-pill').className = 'pill warn';
    $('#btn-install').textContent = 'How to install';
    $('#install-bar').classList.add('hidden');
    return;
  }

  if (state.deferredInstall) {
    $('#install-copy').textContent = 'Install Ricky for a full-screen call experience and faster launches.';
    $('#install-pill').textContent = 'ready';
    $('#install-pill').className = 'pill ok';
    $('#btn-install').textContent = 'Add to home screen';
  } else {
    // No install prompt. Name the actual blocker instead of guessing.
    const secure = window.isSecureContext;
    const worker = await serviceWorkerReady();

    if (!secure) {
      $('#install-copy').textContent =
        'Install needs a secure address. Ricky only installs from an https:// URL — connect through a tunnel or deploy first.';
      $('#install-pill').textContent = 'needs https';
      $('#install-pill').className = 'pill bad';
      $('#btn-install').textContent = 'Why?';
    } else if (!worker) {
      $('#install-copy').textContent =
        'One more step: reload this page so the app worker can start, then use the browser menu → "Install app".';
      $('#install-pill').textContent = 'reload';
      $('#install-pill').className = 'pill warn';
      $('#btn-install').textContent = 'Reload now';
      state.installNeedsReload = true;
    } else {
      $('#install-copy').textContent =
        'This browser has not offered the install prompt yet. Use the menu → "Install app". If it only offers "Create shortcut", reload once and try again.';
      $('#install-pill').textContent = 'menu';
      $('#install-pill').className = 'pill warn';
      $('#btn-install').textContent = 'How to install';
      state.installNeedsReload = false;
    }
  }

  if (!localStorage.getItem('ricky-install-dismissed') && state.deferredInstall) {
    updateInstallBar();
  }
}

async function installApp() {
  if (state.deferredInstall) {
    state.deferredInstall.prompt();
    const choice = await state.deferredInstall.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') {
      $('#install-bar').classList.add('hidden');
      toast('Installing Ricky…', 'ok');
    }
    state.deferredInstall = null;
    return;
  }

  if (isiOS()) {
    toast('Tap Share, then "Add to Home Screen".', 'ok');
    return;
  }

  if (!window.isSecureContext) {
    toast('Ricky can only be installed from an https:// address. This page is not secure.', 'error');
    return;
  }

  if (state.installNeedsReload) {
    toast('Reloading so the app worker can start…', 'ok');
    setTimeout(() => location.reload(), 600);
    return;
  }

  toast('Open the browser menu (⋮) and choose "Install app". If it says "Create shortcut", reload first.', 'ok');
}

/* --------------------------------------------------------------------- call --- */

const player = $('#player');
const callEl = $('#call');

function startRinging() {
  if (state.settings?.ringtone === false) return;
  stopRinging();

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audioCtx = state.audioCtx || new Ctx();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const ping = (freq, at, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.13, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + duration + 0.05);
    };

    const pattern = () => {
      const t = ctx.currentTime + 0.02;
      ping(880, t, 0.32);
      ping(1120, t + 0.4, 0.32);
    };

    pattern();
    state.ringTimer = setInterval(pattern, 2400);
  } catch {
    // Audio is a nice-to-have; the notification already rang.
  }
}

function stopRinging() {
  if (state.ringTimer) clearInterval(state.ringTimer);
  state.ringTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

function renderCall(alert) {
  callEl.hidden = false;
  callEl.classList.add('ringing');
  callEl.classList.remove('connected');
  document.body.style.overflow = 'hidden';

  $('#call-sender').textContent = alert.test ? 'Test call' : alert.sender || 'Someone important';
  $('#call-subject').textContent = alert.test ? 'Your voice alerts are working.' : alert.subject || 'Something landed in your inbox.';
  $('#call-avatar').textContent = alert.test ? 'R' : initials(alert.sender);
  $('#call-status').textContent = 'Incoming alert';
  $('#call-timer').textContent = '';
  $('#call-transcript').hidden = true;
  $('#call-transcript').innerHTML = '';
  $('#call-actions').hidden = false;
  $('#call-controls').hidden = true;

  const badges = [];
  if (alert.score) badges.push(`<span class="badge ${alert.score >= (state.settings?.threshold || 60) ? 'important' : 'watch'}">score ${esc(alert.score)}</span>`);
  if (alert.reason) badges.push(`<span class="reason">${esc(alert.reason)}</span>`);
  if (alert.tts) badges.push(`<span class="reason">${esc(TTS_LABEL[alert.tts] || alert.tts)} voice</span>`);
  $('#call-badges').innerHTML = badges.join('');
}

function openCall(alert, { autoAnswer = false } = {}) {
  if (!alert) return;
  if (state.call && state.call.id === alert.id) return;

  state.call = alert;
  state.ringed.add(alert.id);
  renderCall(alert);
  startRinging();
  if (navigator.vibrate) navigator.vibrate([400, 180, 400, 180, 900]);

  if (alert.id && alert.id !== 'test') {
    api(`/api/alerts/${alert.id}/ack`, { method: 'POST', body: { action: 'seen' } }).catch(() => {});
  }

  if (autoAnswer) setTimeout(() => answerCall(), 400);
}

function showTranscript(text) {
  if (!text) return;
  const el = $('#call-transcript');
  el.hidden = false;
  el.innerHTML = `<small>Ricky is saying</small>${esc(text)}`;
}

function startCallTimer() {
  state.callStartedAt = Date.now();
  clearInterval(state.callTick);
  const tick = () => {
    const seconds = Math.floor((Date.now() - state.callStartedAt) / 1000);
    $('#call-timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  tick();
  state.callTick = setInterval(tick, 1000);
}

async function answerCall() {
  const alert = state.call;
  if (!alert) return;

  stopRinging();
  callEl.classList.remove('ringing');
  callEl.classList.add('connected');
  $('#call-status').textContent = 'Connected';
  $('#call-actions').hidden = true;
  $('#call-controls').hidden = false;
  startCallTimer();
  showTranscript(alert.script);

  if (alert.id && alert.id !== 'test') {
    api(`/api/alerts/${alert.id}/ack`, { method: 'POST', body: { action: 'answered' } }).catch(() => {});
  }

  const speakFallback = () => {
    if (alert.script) speak(alert.script);
    else finishCall();
  };

  if (alert.id && alert.id !== 'test') {
    // The voice note is usually ready before you pick up, but a very fast
    // answer can beat the server. Retry once, then use the phone's voice.
    const start = async (attempt = 0) => {
      player.onended = () => finishCall();
      player.onerror = async () => {
        player.onerror = null;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          start(1);
        } else {
          speakFallback();
        }
      };
      player.src = `/api/audio/${alert.id}?t=${Date.now()}&try=${attempt}`;
      try {
        await player.play();
      } catch {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          start(1);
        } else {
          speakFallback();
        }
      }
    };
    await start(0);
  } else {
    speakFallback();
  }
}

function speak(text) {
  if (!('speechSynthesis' in window)) {
    setTimeout(finishCall, 4000);
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => finishCall();
    utterance.onerror = () => finishCall();
    window.speechSynthesis.speak(utterance);
  } catch {
    setTimeout(finishCall, 4000);
  }
}

function finishCall() {
  stopRinging();
  clearInterval(state.callTick);
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  try {
    player.onended = null;
    player.onerror = null;
    player.pause();
  } catch {}

  $('#call-status').textContent = 'Call finished';
  $('#call-timer').textContent = '';
  setTimeout(closeCall, 800);
}

function declineCall() {
  const alert = state.call;
  if (alert?.id && alert.id !== 'test') {
    api(`/api/alerts/${alert.id}/ack`, { method: 'POST', body: { action: 'declined' } }).catch(() => {});
  }
  closeCall();
}

function closeCall() {
  stopRinging();
  clearInterval(state.callTick);
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  try {
    player.pause();
  } catch {}
  callEl.hidden = true;
  document.body.style.overflow = '';
  state.call = null;
  if (location.search.includes('call=')) history.replaceState(null, '', location.pathname + location.hash);
  refreshAll(true);
}

/* ------------------------------------------------------------------ actions --- */

async function scanNow() {
  if (state.scanning) return;
  setScanning(true);
  try {
    const result = await api('/api/scan', { method: 'POST' });
    if (result.connected === false) throw new Error('Gmail is not connected yet.');
    toast(`Scanned ${result.found} unread · ${result.newEmails} new · ${result.calls} called`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setScanning(false);
    refreshAll(true);
  }
}

function setScanning(scanning) {
  state.scanning = scanning;
  const buttons = [$('#btn-scan'), $('#btn-scan-hero')];
  for (const button of buttons) {
    if (!button) continue;
    button.disabled = scanning;
  }
}

async function testCall(button) {
  if (button) button.disabled = true;
  try {
    const { alert } = await api('/api/alerts/test', { method: 'POST' });
    if (alert?.push?.devices === 0) {
      toast('Test call ready. Enable calls on this phone to make it ring.', 'error');
    } else {
      toast('Incoming call sent to this phone.', 'ok');
    }
    if (alert) openCall(alert);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function callEmail(id, button) {
  if (button) button.disabled = true;
  try {
    const { alert } = await api(`/api/emails/${encodeURIComponent(id)}/call`, { method: 'POST' });
    if (alert) {
      toast(alert.status === 'failed' ? `Call failed: ${alert.error}` : 'Calling you now.', alert.status === 'failed' ? 'error' : 'ok');
      openCall(alert);
    }
    scheduleRefresh(600);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function playAudio(id, button) {
  if (player.src.includes(`/api/audio/${id}`) && !player.paused) {
    player.pause();
    button?.classList.remove('playing');
    return;
  }
  try {
    player.src = `/api/audio/${id}`;
    await player.play();
    $$('.icon-btn.playing').forEach((el) => el.classList.remove('playing'));
    button?.classList.add('playing');
    player.onended = () => {
      button?.classList.remove('playing');
      player.onended = null;
    };
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function connectGmail() {
  try {
    const { url } = await api('/api/auth/google/url');
    location.href = url;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function disconnectGmail() {
  if (!confirm('Disconnect Gmail? Ricky will stop watching your inbox.')) return;
  try {
    await api('/api/gmail/disconnect', { method: 'POST' });
    toast('Gmail disconnected', 'ok');
    refreshAll(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const button = event.submitter || $('#settings-form button[type="submit"]');
  button.disabled = true;
  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body: readSettings() });
    state.settings = settings;
    state.settingsDirty = false;
    fillSettings(settings);
    $('#save-hint').textContent = `Saved at ${clock(Date.now())}.`;
    toast('Settings saved', 'ok');
    refreshAll(true);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function previewVoice() {
  const button = $('#btn-preview');
  button.disabled = true;
  try {
    const text = $('#preview-text').value.trim();
    const { url } = await api('/api/voice/preview', { method: 'POST', body: { text } });
    const audio = $('#preview-audio');
    audio.hidden = false;
    audio.src = url;
    audio.play().catch(() => {});
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------- navigation --- */

function switchView(view, { updateHash = true } = {}) {
  state.view = view;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.dataset.view === view));

  const [title, sub] = VIEW_COPY[view] || VIEW_COPY.overview;
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;

  if (updateHash) history.replaceState(null, '', view === 'overview' ? location.pathname : `#${view}`);
  updateInstallBar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------- events --- */

function connectEvents() {
  if (!('EventSource' in window)) return;
  if (state.status?.server?.serverless) return;

  try {
    const source = new EventSource('/api/events');
    const refreshEvents = ['email:new', 'alert:new', 'alert:update', 'scan:done', 'status', 'settings', 'gmail:connected'];
    for (const name of refreshEvents) source.addEventListener(name, () => scheduleRefresh(150));

    source.addEventListener('alert:new', (event) => {
      try {
        const alert = JSON.parse(event.data);
        if (!state.call && document.visibilityState === 'visible') openCall(alert);
      } catch {}
    });

    source.addEventListener('scan:start', () => setScanning(true));
    source.addEventListener('scan:done', () => setScanning(false));
    source.addEventListener('scan:error', () => setScanning(false));

    source.addEventListener('error', () => {
      // EventSource reconnects on its own; polling keeps the UI fresh meanwhile.
    });
  } catch {}
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshAll(true);
  }, 20_000);
}

function checkPendingCall() {
  if (state.call || document.visibilityState !== 'visible') return;
  const recent = state.alerts.find(
    (alert) => alert.status === 'ringing' && !state.ringed.has(alert.id) && Date.now() - alert.createdAt < 5 * 60_000
  );
  if (recent) openCall(recent);
}

/* --------------------------------------------------------------------- init --- */

function bind() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#btn-scan').addEventListener('click', scanNow);
  $('#btn-scan-hero').addEventListener('click', scanNow);
  $('#btn-test').addEventListener('click', (event) => testCall(event.currentTarget));
  $('#btn-test-2').addEventListener('click', (event) => testCall(event.currentTarget));
  $('#btn-disconnect').addEventListener('click', disconnectGmail);
  $('#btn-preview').addEventListener('click', previewVoice);
  $('#btn-enable-push').addEventListener('click', enablePush);
  $('#btn-disable-push').addEventListener('click', disablePush);
  $('#btn-test-push').addEventListener('click', (event) => testCall(event.currentTarget));
  $('#btn-install').addEventListener('click', installApp);
  $('#btn-install-bar').addEventListener('click', installApp);
  $('#btn-install-dismiss').addEventListener('click', () => {
    $('#install-bar').classList.add('hidden');
    localStorage.setItem('ricky-install-dismissed', '1');
  });

  $('#settings-form').addEventListener('submit', saveSettings);
  $('#settings-form').addEventListener('input', (event) => {
    state.settingsDirty = true;
    if (event.target.name === 'threshold') $('#threshold-out').textContent = event.target.value;
  });

  $('#inbox-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('#inbox-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderInbox();
  });

  document.addEventListener('click', (event) => {
    const viewLink = event.target.closest('[data-view-link]');
    if (viewLink) {
      event.preventDefault();
      switchView(viewLink.dataset.viewLink);
      return;
    }

    const copyTarget = event.target.closest('[data-copy]');
    if (copyTarget) {
      const text = $(copyTarget.dataset.copy)?.textContent || '';
      navigator.clipboard
        .writeText(text)
        .then(() => toast('Copied to clipboard', 'ok'))
        .catch(() => toast('Copy failed', 'error'));
      return;
    }

    const action = event.target.closest('[data-action]');
    if (!action) return;

    if (action.dataset.action === 'call') callEmail(action.dataset.id, action);
    if (action.dataset.action === 'play') playAudio(action.dataset.id, action);
    if (action.dataset.action === 'connect-gmail') connectGmail();
  });

  callEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-call-action]');
    if (!button) return;
    const action = button.dataset.callAction;
    if (action === 'answer') answerCall();
    if (action === 'decline') declineCall();
    if (action === 'end') closeCall();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !callEl.hidden) declineCall();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAll(true).then(checkPendingCall);
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    setupInstall();
  });

  window.addEventListener('appinstalled', () => {
    $('#install-bar').classList.add('hidden');
    $('#install-card').classList.add('hidden');
    toast('Ricky installed. Open it from your home screen.', 'ok');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-call' && event.data.alertId) {
        api(`/api/alerts/${event.data.alertId}`)
          .then((alert) => openCall(alert, { autoAnswer: Boolean(event.data.answer) }))
          .catch(() => {});
      }
    });
  }
}

async function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  if (params.get('connected')) toast('Gmail connected. Ricky is watching your inbox.', 'ok');
  if (params.get('error')) toast(params.get('error'), 'error');
  if (params.get('connected') || params.get('error')) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const callId = params.get('call');
  if (!callId) return;

  if (callId === 'test') {
    openCall(
      {
        id: 'test',
        sender: 'Ricky',
        subject: 'Your voice alerts are working.',
        script: 'Hi, this is Ricky. This is a test call. If you can hear this, your voice alerts are working. That is all. Talk soon.',
        test: true,
        status: 'ringing',
        score: 100,
      },
      { autoAnswer: params.get('answer') === '1' }
    );
    return;
  }

  try {
    const alert = await api(`/api/alerts/${encodeURIComponent(callId)}`);
    openCall(alert, { autoAnswer: params.get('answer') === '1' });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function init() {
  bind();

  const hash = location.hash.replace('#', '');
  if (VIEW_COPY[hash]) switchView(hash, { updateHash: false });

  if ('serviceWorker' in navigator) {
    await registerSW();
  }

  await refreshAll(true);
  await setupInstall();
  await handleLaunchParams();
  checkPendingCall();

  connectEvents();
  startPolling();
}

init();
