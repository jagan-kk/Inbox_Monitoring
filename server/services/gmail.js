import { env } from '../config.js';
import { tokenStore } from '../store.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function isConfigured() {
  return Boolean(env.google.clientId && env.google.clientSecret);
}

export function isConnected() {
  return Boolean(tokenStore.data?.refresh_token);
}

export function connectedEmail() {
  return tokenStore.data?.email || null;
}

export function buildAuthUrl(state = crypto.randomUUID()) {
  if (!isConfigured()) throw new Error('Google OAuth client is not configured.');
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', env.google.clientId);
  url.searchParams.set('redirect_uri', env.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function handleCallback(code) {
  const body = new URLSearchParams({
    code,
    client_id: env.google.clientId,
    client_secret: env.google.clientSecret,
    redirect_uri: env.google.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);

  const token = await res.json();
  tokenStore.data = {
    ...tokenStore.data,
    access_token: token.access_token,
    refresh_token: token.refresh_token || tokenStore.data.refresh_token,
    expiry_date: Date.now() + (token.expires_in || 3600) * 1000,
    scope: token.scope,
    token_type: token.token_type,
  };

  if (!tokenStore.data.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and try again.');
  }

  if (!tokenStore.data.email) {
    tokenStore.data.email = await fetchAccountEmail(token.access_token).catch(() => null);
  }

  tokenStore.save();
  return tokenStore.data;
}

async function fetchAccountEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Could not read Google profile.');
  const profile = await res.json();
  return profile.email || null;
}

export async function getAccessToken() {
  const tokens = tokenStore.data || {};
  if (!tokens.refresh_token) throw new Error('Gmail is not connected. Open Setup and connect Google.');

  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date - 60_000 > Date.now()) {
    return tokens.access_token;
  }

  const body = new URLSearchParams({
    client_id: env.google.clientId,
    client_secret: env.google.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${await res.text()}`);
  }

  const token = await res.json();
  tokenStore.data = {
    ...tokens,
    access_token: token.access_token,
    expiry_date: Date.now() + (token.expires_in || 3600) * 1000,
  };
  tokenStore.save();
  return tokenStore.data.access_token;
}

async function gmailGet(path) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) tokenStore.data.access_token = null;
    throw new Error(`Gmail API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function getProfile() {
  return gmailGet('/profile');
}

export async function listMessages(query, maxResults = 20) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await gmailGet(`/messages?${params}`);
  return (data.messages || []).map((m) => m.id);
}

export async function getMessage(id) {
  const params = new URLSearchParams({ format: 'full' });
  return gmailGet(`/messages/${id}?${params}`);
}

const decodeBase64Url = (data) => Buffer.from(data, 'base64url').toString('utf8');

function decodeHeader(value = '') {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf8');
      }
      const bytes = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'binary').toString('utf8');
    } catch {
      return match;
    }
  });
}

export function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectBodies(part, out) {
  if (!part) return;
  const mime = part.mimeType || '';
  const data = part.body?.data;
  if (data && mime === 'text/plain') out.text += decodeBase64Url(data) + '\n';
  if (data && mime === 'text/html') out.html += decodeBase64Url(data) + '\n';
  for (const child of part.parts || []) collectBodies(child, out);
}

function parseFrom(raw) {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: decodeHeader(match[1].trim()), email: match[2].trim().toLowerCase() };
  return { name: '', email: raw.trim().toLowerCase() };
}

export function normalizeMessage(raw) {
  const headers = {};
  for (const header of raw.payload?.headers || []) {
    headers[header.name.toLowerCase()] = header.value;
  }

  const bodies = { text: '', html: '' };
  collectBodies(raw.payload, bodies);

  const text = bodies.text.trim()
    ? bodies.text
    : bodies.html
      ? stripHtml(bodies.html)
      : raw.snippet || '';

  const from = parseFrom(headers.from || '');
  const subject = decodeHeader(headers.subject || '(no subject)');
  const listUnsubscribe = Boolean(headers['list-unsubscribe']);
  const date = headers.date ? Date.parse(headers.date) : NaN;

  return {
    id: raw.id,
    threadId: raw.threadId,
    from,
    to: headers.to || '',
    subject,
    snippet: (raw.snippet || '').replace(/\s+/g, ' ').trim(),
    body: text.replace(/\r/g, '').slice(0, 6000),
    receivedAt: Number.isFinite(date) ? date : Number(raw.internalDate) || Date.now(),
    labels: raw.labelIds || [],
    hasAttachment: Boolean(raw.payload?.parts?.some((p) => p.filename)),
    isNewsletter: listUnsubscribe || (raw.labelIds || []).includes('CATEGORY_PROMOTIONS'),
    isAutomated: /no-?reply|do-?not-?reply|notifications?@|mailer-daemon/i.test(headers.from || ''),
  };
}

export async function fetchRecentMessages({ lookbackMinutes = 60, maxResults = 20 } = {}) {
  const after = Math.floor((Date.now() - lookbackMinutes * 60_000) / 1000);
  const query = `is:unread after:${after} -in:spam -in:trash`;
  const ids = await listMessages(query, maxResults);
  const messages = [];
  for (const id of ids) {
    try {
      messages.push(normalizeMessage(await getMessage(id)));
    } catch (error) {
      console.error(`[gmail] could not load message ${id}:`, error.message);
    }
  }
  return messages;
}

export function disconnect() {
  tokenStore.data = {};
  tokenStore.save();
}
