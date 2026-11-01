const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  status: null,
  emails: [],
  calls: [],
  settings: null,
  voiceId: '',
  filter: 'all',
  view: 'overview',
  settingsDirty: false,
  voicesLoaded: false,
  scanning: false,
};

const VIEW_COPY = {
  overview: ['Overview', 'Watching your inbox and calling when it matters.'],
  inbox: ['Inbox', 'Every email Ricky scored, and why.'],
  calls: ['Calls', 'Each voice note Ricky generated and dialled.'],
  settings: ['Settings', 'Tune what is important and how Ricky reaches you.'],
  setup: ['Setup', 'Connect Gmail, ElevenLabs, and a phone line.'],
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

const providerName = (provider) =>
  ({ elevenlabs: 'ElevenLabs agent', twilio: 'Twilio + ElevenLabs', simulate: 'Simulation' }[provider] || provider || 'unknown');

async function api(path, options = {}) {
  const res = await fetch(path, {
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
  }, kind === 'error' ? 6000 : 3800);
}

let refreshTimer = null;
function scheduleRefresh(delay = 350) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAll(true), delay);
}

async function refreshAll(silent = false) {
  try {
    const [status, emails, calls] = await Promise.all([api('/api/status'), api('/api/emails'), api('/api/calls')]);
    state.status = status;
    state.settings = status.settings;
    state.emails = emails.emails || [];
    state.calls = calls.calls || [];
    render();
  } catch (error) {
    if (!silent) toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  renderStatus();
  renderStats();
  renderFeed();
  renderActivity();
  renderInbox();
  renderCalls();
  renderChecklist();
  if (!state.settingsDirty && state.settings) fillSettings(state.settings);
}

function renderStatus() {
  const status = state.status || {};
  const setup = status.setup || {};
  const provider = status.provider || 'simulate';

  const rows = [
    status.gmailConnected
      ? `<div class="side-row"><i class="dot ok"></i><span>Gmail <b>${esc(status.gmailAccount || 'connected')}</b></span></div>`
      : `<div class="side-row"><i class="dot bad"></i><span>Gmail <b>not connected</b></span></div>`,
    status.voiceConfigured
      ? `<div class="side-row"><i class="dot ok"></i><span>Voice <b>ElevenLabs</b></span></div>`
      : `<div class="side-row"><i class="dot warn"></i><span>Voice <b>add API key</b></span></div>`,
    `<div class="side-row"><i class="dot ${provider === 'simulate' ? 'warn' : 'ok'}"></i><span>${esc(providerName(provider))}</span></div>`,
    `<div class="side-row"><i class="dot ${status.lastScanResult?.error ? 'bad' : 'ok'}"></i><span>Last scan <b>${rel(status.lastScanAt)}</b></span></div>`,
  ];
  $('#side-status').innerHTML = rows.join('');

  const banner = $('#connect-banner');
  const connected = Boolean(status.gmailConnected);
  banner.classList.toggle('hidden', connected);
  if (!setup.google) {
    $('#banner-copy').textContent = 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then restart Ricky.';
  } else if (!connected) {
    $('#banner-copy').textContent = 'Connect your Google account so Ricky can watch for important mail.';
  }

  $('#nav-inbox-count').textContent = String(state.emails.filter((e) => e.level === 'important').length);
  $('#stat-provider').textContent = status.destinationNumber
    ? `${providerName(provider)} → ${status.destinationNumber}`
    : providerName(provider);
}

function renderStats() {
  const status = state.status || {};
  $('#stat-important').textContent = status.importantToday ?? 0;
  $('#stat-calls').textContent = status.callsToday ?? 0;
  $('#stat-queued').textContent = status.queued ?? 0;
  $('#stat-lastscan').textContent = rel(status.lastScanAt);
  const result = status.lastScanResult;
  $('#stat-lastscan-result').textContent = result?.error
    ? `error: ${result.error.slice(0, 60)}`
    : result
      ? `${result.newEmails} new · ${result.calls} called`
      : 'polling is idle';
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
        <div class="item-snippet">${esc(email.snippet || '')}</div>
        <div class="item-meta">
          <span class="badge ${level}">${level === 'important' ? 'Important' : level === 'watch' ? 'Watch' : 'Normal'} · ${email.score ?? 0}</span>
          ${reasons.map((r) => `<span class="reason">${esc(r.label)}</span>`).join('')}
          ${!compact || decision.action === 'called' ? `<span class="badge ${decision.action === 'called' ? 'called' : decision.action === 'failed' ? 'failed' : decision.action === 'queued' ? 'queued' : 'normal'}">${esc(decisionLabel(decision))}</span>` : ''}
        </div>
        ${compact ? '' : itemActions(email)}
      </div>
      <div class="item-side">
        ${email.decision?.action === 'called' ? '<span class="badge called">called</span>' : ''}
        <button class="icon-btn" data-action="call" data-id="${esc(email.id)}" title="Call me about this email">
          <svg viewBox="0 0 24 24"><path d="M7 4h3l2 5-3 2a12 12 0 0 0 4 4l2-3 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 5 6a2 2 0 0 1 2-2Z"/></svg>
        </button>
      </div>
    </div>`;
}

function itemActions(email) {
  const gmailUrl = email.threadId ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.threadId)}` : 'https://mail.google.com';
  return `<div class="item-actions">
    <button class="btn small ghost" data-action="call" data-id="${esc(email.id)}">Call me now</button>
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
    .slice(0, 5);

  $('#feed').innerHTML = emails.length
    ? emails.map((e) => emailItem(e, { compact: true })).join('')
    : '<div class="empty">No scored email yet. Ricky checks every minute.</div>';
}

function renderActivity() {
  const calls = state.calls.slice(0, 5);
  $('#activity').innerHTML = calls.length
    ? calls.map(callRow).join('')
    : '<div class="empty">No calls placed yet.</div>';
}

function callRow(call) {
  const cls = call.status === 'failed' ? 'failed' : call.status === 'simulated' ? 'simulated' : call.status === 'called' ? 'called' : 'calling';
  return `
    <div class="item">
      <div class="avatar ${call.provider === 'simulate' ? 'dim' : ''}">${call.audioUrl ? '♪' : '☎'}</div>
      <div class="item-main">
        <div class="item-top">
          <span class="item-from">${esc(call.subject || 'Voice alert')}</span>
          <span class="item-time">${rel(call.createdAt)}</span>
        </div>
        <div class="item-snippet">${esc(call.error || call.script || call.note || '').slice(0, 150)}</div>
        <div class="item-meta">
          <span class="badge ${cls}">${esc(call.status)}</span>
          <span class="reason">${esc(providerName(call.provider))}</span>
          ${call.to ? `<span class="reason">${esc(call.to)}</span>` : ''}
        </div>
      </div>
      <div class="item-side">
        ${call.audioUrl ? playButton(call.audioUrl) : ''}
      </div>
    </div>`;
}

function playButton(url) {
  return `<button class="icon-btn" data-action="play" data-audio="${esc(url)}" title="Play the voice note">
    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
  </button>`;
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
  const calls = state.calls;
  $('#calls-summary').textContent = calls.length ? `${calls.length} total` : '';

  $('#calls-list').innerHTML = calls.length
    ? calls
        .map((call) => {
          const cls = call.status === 'failed' ? 'failed' : call.status === 'simulated' ? 'simulated' : 'calling';
          return `
      <div class="call-row">
        <div class="c-time">${rel(call.createdAt)}<br><span style="color:var(--faint)">${clock(call.createdAt)}</span></div>
        <div class="c-subject">${esc(call.subject || 'Voice alert')}<small>${esc(call.sender || '')}${call.manual ? ' · manual' : ''}</small>
          ${call.error ? `<div class="call-error">${esc(call.error)}</div>` : ''}
        </div>
        <div class="c-provider">${esc(providerName(call.provider))}</div>
        <div><span class="badge ${cls}">${esc(call.status)}</span></div>
        <div>${call.audioUrl ? playButton(call.audioUrl) : ''}</div>
      </div>`;
        })
        .join('')
    : '<div class="empty">No calls yet. Hit "Test my voice" to try the pipeline.</div>';
}

function renderChecklist() {
  const status = state.status || {};
  const setup = status.setup || {};
  const items = [
    {
      title: 'Google OAuth client',
      detail: setup.google ? 'Client ID and secret loaded from .env' : 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
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
      title: 'ElevenLabs voice',
      detail: setup.voice ? 'API key loaded, voice notes enabled' : 'Add ELEVENLABS_API_KEY',
      ok: Boolean(setup.voice),
      pill: setup.voice ? 'ready' : 'missing',
    },
    {
      title: 'Phone delivery',
      detail:
        status.provider === 'simulate'
          ? 'Simulation mode: audio is generated but nobody is called'
          : `${providerName(status.provider)}${status.destinationNumber ? ` → ${status.destinationNumber}` : ' · add a number in Settings'}`,
      ok: status.provider !== 'simulate' && Boolean(status.destinationNumber),
      pill: status.provider === 'simulate' ? 'simulate' : status.destinationNumber ? 'ready' : 'number',
    },
    {
      title: 'Public audio URL',
      detail: setup.publicUrlIsLocal
        ? 'Twilio needs a public https URL (ngrok) to fetch the MP3'
        : setup.publicBaseUrl,
      ok: !setup.publicUrlIsLocal,
      pill: setup.publicUrlIsLocal ? 'local only' : 'public',
    },
  ];

  $('#checklist').innerHTML = items
    .map(
      (item, index) => `
      <li class="${item.ok ? 'ok' : 'bad'}">
        <span class="check">${item.ok ? '✓' : index + 1}</span>
        <div><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
        <em class="pill">${esc(item.pill)}</em>
      </li>`
    )
    .join('');

  const connectBtn = $('#btn-connect');
  connectBtn.textContent = status.gmailConnected ? 'Reconnect Gmail' : 'Connect Gmail';
  connectBtn.disabled = !setup.google;
}

/* ----------------------------------------------------------------- settings */

function fillSettings(settings) {
  const form = $('#settings-form');
  if (!form) return;

  form.ownerName.value = settings.ownerName || '';
  form.destinationNumber.value = settings.destinationNumber || '';
  form.provider.value = settings.provider || 'auto';
  form.threshold.value = settings.threshold;
  $('#threshold-out').textContent = settings.threshold;
  form.autoCall.checked = settings.autoCall !== false;
  form.vipSenders.value = (settings.vipSenders || []).join('\n');
  form.ignoreSenders.value = (settings.ignoreSenders || []).join('\n');
  form.keywords.value = (settings.keywords || []).join(', ');
  form.pollSeconds.value = settings.pollSeconds;
  form.cooldownSeconds.value = settings.cooldownSeconds;
  form.maxCallsPerHour.value = settings.maxCallsPerHour;
  form.lookbackMinutes.value = settings.lookbackMinutes;
  form.quietHoursEnabled.checked = Boolean(settings.quietHours?.enabled);
  form.quietStart.value = settings.quietHours?.start || '22:00';
  form.quietEnd.value = settings.quietHours?.end || '07:00';
  form.callVipDuringQuietHours.checked = settings.callVipDuringQuietHours !== false;
  form.previewAudio.checked = settings.previewAudio !== false;
  form.modelId.value = settings.modelId || 'eleven_multilingual_v2';
  form.scriptStyle.value = settings.scriptStyle || 'subject';

  const voiceInput = $('#voice-select');
  voiceInput.value = settings.voiceId || '';

  state.voiceId = settings.voiceId || '';
  state.settingsDirty = false;
}

function readSettings() {
  const form = $('#settings-form');
  const value = (name) => form.elements[name]?.value ?? '';
  const checked = (name) => Boolean(form.elements[name]?.checked);

  return {
    ownerName: value('ownerName'),
    destinationNumber: value('destinationNumber'),
    provider: value('provider'),
    threshold: Number(value('threshold')),
    autoCall: checked('autoCall'),
    vipSenders: value('vipSenders').split('\n').map((v) => v.trim()).filter(Boolean),
    ignoreSenders: value('ignoreSenders').split('\n').map((v) => v.trim()).filter(Boolean),
    keywords: value('keywords').split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
    pollSeconds: Number(value('pollSeconds')),
    cooldownSeconds: Number(value('cooldownSeconds')),
    maxCallsPerHour: Number(value('maxCallsPerHour')),
    lookbackMinutes: Number(value('lookbackMinutes')),
    quietHours: {
      enabled: checked('quietHoursEnabled'),
      start: value('quietStart') || '22:00',
      end: value('quietEnd') || '07:00',
    },
    callVipDuringQuietHours: checked('callVipDuringQuietHours'),
    voiceId: value('voiceId'),
    modelId: value('modelId'),
    previewAudio: checked('previewAudio'),
    scriptStyle: value('scriptStyle'),
  };
}

async function loadVoices({ silent = false } = {}) {
  try {
    const { voices } = await api('/api/voices');
    const input = $('#voice-select');
    const datalist = $('#voice-options');
    datalist.innerHTML = voices
      .map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.category ? ` · ${esc(v.category)}` : ''}</option>`)
      .join('');
    if (!input.value && voices[0]) input.value = voices[0].id;
    state.voiceId = input.value;
    state.voicesLoaded = true;
    if (!silent) toast(`Loaded ${voices.length} voices`, 'ok');
  } catch (error) {
    if (!silent) toast(`${error.message} - you can still paste a voice ID manually.`, 'error');
  }
}

/* ------------------------------------------------------------------- setup */

async function loadAgentPrompt() {
  try {
    const { prompt } = await api('/api/agent-prompt');
    $('#agent-prompt').textContent = prompt;
  } catch {
    $('#agent-prompt').textContent = 'Could not load the prompt.';
  }
}

/* -------------------------------------------------------------------- play */

const player = $('#player');
let playingButton = null;

function play(url, button) {
  if (player.src.endsWith(url) && !player.paused) {
    player.pause();
    button?.classList.remove('playing');
    return;
  }
  player.src = url;
  player.play().catch((error) => toast(error.message, 'error'));
  playingButton?.classList.remove('playing');
  playingButton = button || null;
  playingButton?.classList.add('playing');
}

player.addEventListener('ended', () => {
  playingButton?.classList.remove('playing');
  playingButton = null;
});

/* ------------------------------------------------------------------ actions */

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
  const button = $('#btn-scan');
  button.disabled = scanning;
  const label = button.querySelector('span');
  if (label) label.textContent = scanning ? 'Scanning…' : 'Scan now';
}

async function testCall() {
  const button = $('#btn-test');
  button.disabled = true;
  try {
    const { call } = await api('/api/test-call', { method: 'POST' });
    if (call.status === 'simulated') toast('Voice note generated - simulation mode, no phone call placed.', 'ok');
    else if (call.status === 'failed') toast(`Call failed: ${call.error}`, 'error');
    else toast(`Calling ${call.to || 'you'} now…`, 'ok');
    if (call.audioUrl) play(call.audioUrl, null);
    scheduleRefresh(600);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function connectGmail() {
  try {
    const { url } = await api('/api/auth/google/url');
    window.location.href = url;
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

async function callEmail(id, button) {
  button && (button.disabled = true);
  try {
    const { call } = await api(`/api/emails/${id}/call`, { method: 'POST' });
    if (call.status === 'failed') toast(`Call failed: ${call.error}`, 'error');
    else toast(call.status === 'simulated' ? 'Voice note generated (simulation).' : 'Call placed.', 'ok');
    if (call.audioUrl) play(call.audioUrl, null);
    scheduleRefresh(500);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button && (button.disabled = false);
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
    const { url } = await api('/api/voice/preview', {
      method: 'POST',
      body: { text, voiceId: $('#settings-form').elements.voiceId.value },
    });
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

/* --------------------------------------------------------------- navigation */

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));

  const [title, sub] = VIEW_COPY[view] || VIEW_COPY.overview;
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;

  if (view === 'setup') loadAgentPrompt();
  if (view === 'settings' && !state.settingsDirty && state.settings) fillSettings(state.settings);
  if (view === 'settings' && !state.voicesLoaded && state.status?.voiceConfigured) loadVoices({ silent: true });

  history.replaceState(null, '', view === 'overview' ? location.pathname : `#${view}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* --------------------------------------------------------------------- init */

function bind() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view)));
  $('#btn-scan').addEventListener('click', scanNow);
  $('#btn-test').addEventListener('click', testCall);
  $('#btn-disconnect').addEventListener('click', disconnectGmail);
  $('#btn-voices').addEventListener('click', () => loadVoices());
  $('#btn-preview').addEventListener('click', previewVoice);
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
    const link = event.target.closest('[data-view-link]');
    if (link) {
      event.preventDefault();
      switchView(link.dataset.viewLink);
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
    if (action.dataset.action === 'play') play(action.dataset.audio, action);
    if (action.dataset.action === 'connect-gmail') connectGmail();
  });

  // `?nostream=1` is handy for screenshots and printing: no live connection,
  // so the page reaches a stable load state.
  if (!location.search.includes('nostream')) connectEvents();
}

function connectEvents() {
  const connection = new EventSource('/api/events');
  const events = ['email:new', 'call:new', 'call:update', 'scan:done', 'scan:error', 'status', 'settings', 'gmail:connected'];
  for (const name of events) connection.addEventListener(name, () => scheduleRefresh());
  connection.addEventListener('scan:start', (event) => {
    setScanning(true);
    try {
      const data = JSON.parse(event.data);
      if (data.trigger !== 'timer' && data.trigger !== 'startup' && data.trigger !== 'after-connect') toast('Scanning your inbox…');
    } catch {}
  });
  connection.addEventListener('scan:done', (event) => {
    setScanning(false);
    try {
      const data = JSON.parse(event.data);
      if (data.error) toast(`Scan error: ${data.error}`, 'error');
    } catch {}
  });
  connection.addEventListener('scan:error', (event) => {
    setScanning(false);
    try {
      toast(`Scan error: ${JSON.parse(event.data).message}`, 'error');
    } catch {}
  });
}

async function init() {
  bind();

  const params = new URLSearchParams(location.search);
  if (params.get('connected')) toast('Gmail connected. Ricky is watching your inbox.', 'ok');
  if (params.get('error')) toast(params.get('error'), 'error');
  if (params.get('connected') || params.get('error')) {
    history.replaceState(null, '', location.pathname);
  }

  const hash = location.hash.replace('#', '');
  if (VIEW_COPY[hash]) switchView(hash);

  await refreshAll(true);
  loadAgentPrompt();
}

init();
