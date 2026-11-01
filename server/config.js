import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const str = (value, fallback = '') =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const port = num(process.env.PORT, 4173);
const publicBaseUrl = str(process.env.PUBLIC_BASE_URL, `http://127.0.0.1:${port}`).replace(/\/+$/, '');

export const env = {
  port,
  host: str(process.env.HOST, '127.0.0.1'),
  publicBaseUrl,
  google: {
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
    redirectUri: str(process.env.GOOGLE_REDIRECT_URI, `${publicBaseUrl}/oauth2callback`),
  },
  eleven: {
    apiKey: str(process.env.ELEVENLABS_API_KEY),
    voiceId: str(process.env.ELEVENLABS_VOICE_ID, '21m00Tcm4TlvDq8ikWAM'),
    modelId: str(process.env.ELEVENLABS_MODEL_ID, 'eleven_multilingual_v2'),
    agentId: str(process.env.ELEVENLABS_AGENT_ID),
    agentPhoneNumberId: str(process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID),
  },
  twilio: {
    accountSid: str(process.env.TWILIO_ACCOUNT_SID),
    authToken: str(process.env.TWILIO_AUTH_TOKEN),
    fromNumber: str(process.env.TWILIO_FROM_NUMBER),
  },
  pollSeconds: Math.max(15, num(process.env.POLL_SECONDS, 60)),
};

export const DEFAULT_SETTINGS = {
  // Who gets called, and how.
  destinationNumber: '',
  provider: 'auto', // auto | elevenlabs | twilio | simulate
  ownerName: '',

  // Importance engine.
  threshold: 60,
  autoCall: true,
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

  // Pacing so you never get spammed by calls.
  pollSeconds: env.pollSeconds,
  cooldownSeconds: 300,
  maxCallsPerHour: 6,
  lookbackMinutes: 60,

  // Quiet hours do not silence VIP senders unless you say so.
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  callVipDuringQuietHours: true,

  // Voice.
  voiceId: env.eleven.voiceId,
  modelId: env.eleven.modelId,
  previewAudio: true,
  // subject = sender + subject only (default), brief = + one line of preview,
  // detailed = + preview and why it was flagged.
  scriptStyle: 'subject',
};

export const SETUP = {
  googleConfigured: Boolean(env.google.clientId && env.google.clientSecret),
  voiceConfigured: Boolean(env.eleven.apiKey),
  elevenAgentConfigured: Boolean(env.eleven.agentId && env.eleven.agentPhoneNumberId),
  twilioConfigured: Boolean(env.twilio.accountSid && env.twilio.authToken && env.twilio.fromNumber),
  publicUrlIsLocal: /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(env.publicBaseUrl),
};
