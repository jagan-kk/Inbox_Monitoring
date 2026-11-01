import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_DIR, env } from '../config.js';

const API = 'https://api.elevenlabs.io/v1';

function apiKey() {
  if (!env.eleven.apiKey) throw new Error('ELEVENLABS_API_KEY is not set.');
  return env.eleven.apiKey;
}

function cleanForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[*_#>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn an alert into speech that sounds human when read aloud. */
export function buildScript(email, { reasons = [], ownerName = 'there', score = 0, style = 'subject' } = {}) {
  const owner = cleanForSpeech(ownerName) || 'there';
  const sender = cleanForSpeech(email.from?.name || email.from?.email || 'someone');
  const subject = cleanForSpeech(email.subject || '(no subject)').slice(0, 110);

  if (email.test) {
    return `Hi ${owner}, this is Ricky. This is a test call. If you can hear this, your voice alerts are working. That is all. Talk soon.`;
  }

  const mode = ['subject', 'brief', 'detailed'].includes(style) ? style : 'subject';
  const parts = [
    `Hi ${owner}, this is Ricky.`,
    `You just got an important email from ${sender} about ${subject}.`,
  ];

  if (mode !== 'subject') {
    const summary = cleanForSpeech(email.snippet || email.body || '').slice(0, mode === 'brief' ? 140 : 260);
    if (summary) parts.push(summary.endsWith('.') ? summary : `${summary}.`);
  }

  if (mode === 'detailed') {
    const why = reasons.filter((r) => r.points > 0).slice(0, 2).map((r) => r.label.replace(/\s*\([^)]*\)/g, '').trim());
    if (why.length) parts.push(`I flagged it because it ${why.join(' and ')}.`);
  }

  parts.push('That is all. Talk soon.');

  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 900);
}

/** Generate an MP3 with ElevenLabs and store it under data/audio. */
export async function synthesize(text, { voiceId, modelId, id } = {}) {
  const voice = voiceId || env.eleven.voiceId;
  const model = modelId || env.eleven.modelId;
  const fileId = (id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = `${fileId}.mp3`;

  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey(),
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(path.join(AUDIO_DIR, file), buffer);

  return {
    file,
    bytes: buffer.length,
    url: `/audio/${file}`,
    publicUrl: `${env.publicBaseUrl}/audio/${file}`,
    voiceId: voice,
  };
}

/** Native ElevenLabs outbound call through an agent + imported Twilio number. */
export async function outboundCall({ toNumber, agentId, agentPhoneNumberId, variables = {} }) {
  const res = await fetch(`${API}/convai/twilio/outbound-call`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId || env.eleven.agentId,
      agent_phone_number_id: agentPhoneNumberId || env.eleven.agentPhoneNumberId,
      to_number: toNumber,
      conversation_initiation_client_data: { dynamic_variables: variables },
    }),
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`ElevenLabs outbound call failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return body;
}

export async function listVoices() {
  const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': apiKey() } });
  if (!res.ok) {
    const text = await res.text();
    let detail = '';
    try {
      detail = JSON.parse(text)?.detail?.message || '';
    } catch {}
    const hint = res.status === 401 ? ' (edit the API key and enable the Voices: Read permission)' : '';
    throw new Error(`ElevenLabs voices failed (${res.status})${hint}${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json();
  return (body.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels || {},
  }));
}

export async function getSubscription() {
  const res = await fetch(`${API}/user/subscription`, { headers: { 'xi-api-key': apiKey() } });
  if (!res.ok) return null;
  const body = await res.json();
  return {
    tier: body.tier,
    characterCount: body.character_count,
    characterLimit: body.character_limit,
    canUseProfessionalVoiceCloning: Boolean(body.can_extend_character_limit),
  };
}

export async function removeOldAudio(maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const entries = await fs.readdir(AUDIO_DIR).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith('.mp3')) continue;
    const full = path.join(AUDIO_DIR, entry);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => {});
  }
}
