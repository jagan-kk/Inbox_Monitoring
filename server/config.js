import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const str = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const port = num(process.env.PORT, 4173);
const isServerless = Boolean(
  process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.CF_PAGES
);
const publicBaseUrl = str(process.env.PUBLIC_BASE_URL, isServerless ? '' : `http://127.0.0.1:${port}`).replace(/\/+$/, '');

export const env = {
  port,
  host: str(process.env.HOST, '127.0.0.1'),
  publicBaseUrl,
  isServerless,
  /** In-process polling works on a long-running host. Serverless needs a cron ping. */
  selfPoll: bool(process.env.SELF_POLL, !isServerless),
  sessionSecret: str(process.env.SESSION_SECRET),
  cronSecret: str(process.env.CRON_SECRET),

  google: {
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
    // Optional. When empty the redirect URI is derived from the incoming request.
    redirectUri: str(process.env.GOOGLE_REDIRECT_URI),
  },

  // Optional video shown on the left half of the sign-in page.
  // Defaults to /media/login.mp4 (drop your own file there).
  loginVideo: str(process.env.LOGIN_VIDEO_URL),

  // Voice generation. `auto` prefers ElevenLabs (free tier) and falls back to
  // Microsoft Edge's free neural voices when there is no key or a quota error.
  tts: {
    provider: str(process.env.TTS_PROVIDER, 'auto'), // auto | elevenlabs | edge
    elevenApiKey: str(process.env.ELEVENLABS_API_KEY),
    elevenVoiceId: str(process.env.ELEVENLABS_VOICE_ID, '21m00Tcm4TlvDq8ikWAM'),
    elevenModelId: str(process.env.ELEVENLABS_MODEL_ID, 'eleven_multilingual_v2'),
    edgeVoice: str(process.env.EDGE_TTS_VOICE, 'en-US-AriaNeural'),
    edgeRate: str(process.env.EDGE_TTS_RATE, '+0%'),
  },

  vapid: {
    publicKey: str(process.env.VAPID_PUBLIC_KEY),
    privateKey: str(process.env.VAPID_PRIVATE_KEY),
    subject: str(process.env.VAPID_SUBJECT, 'mailto:ricky@example.com'),
  },

  // Upstash Redis REST (or Vercel KV, same API). Required on serverless hosts
  // so settings, Gmail tokens and call audio survive restarts.
  redis: {
    url: str(process.env.UPSTASH_REDIS_REST_URL) || str(process.env.KV_REST_API_URL),
    token: str(process.env.UPSTASH_REDIS_REST_TOKEN) || str(process.env.KV_REST_API_TOKEN),
  },

  pollSeconds: Math.max(15, num(process.env.POLL_SECONDS, 60)),
};

export const DEFAULT_SETTINGS = {
  // Who is being called.
  ownerName: '',

  // Importance engine.
  threshold: 60,
  autoAlert: true,
  vipSenders: [],
  ignoreSenders: [],
  keywords: [
    'urgent',
    'asap',
    'action required',
    'deadline',
    'invoice',
    'payment failed',
    'security alert',
    'verify',
    'contract',
    'interview',
    'outage',
  ],

  // Pacing so the phone never gets spammed.
  pollSeconds: env.pollSeconds,
  cooldownSeconds: 300,
  maxAlertsPerHour: 6,
  lookbackMinutes: 60,

  // Quiet hours do not silence VIP senders unless you say so.
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  alertVipDuringQuietHours: true,

  // The web call.
  scriptStyle: 'brief', // subject | brief | detailed
  notifyPush: true,
  ringtone: true,
  speakOnAnswer: true,
};

export function deriveSetup() {
  return {
    google: Boolean(env.google.clientId && env.google.clientSecret),
    voice: Boolean(env.tts.elevenApiKey) || env.tts.provider !== 'elevenlabs',
    elevenLabs: Boolean(env.tts.elevenApiKey),
    edgeTts: env.tts.provider !== 'elevenlabs',
    push: true,
    storage: env.redis.url && env.redis.token ? 'redis' : 'file',
    cron: Boolean(env.cronSecret),
    selfPoll: env.selfPoll,
    publicBaseUrl: env.publicBaseUrl || null,
    publicUrlIsLocal: !env.publicBaseUrl || /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(env.publicBaseUrl),
  };
}

export const SETUP = deriveSetup();
