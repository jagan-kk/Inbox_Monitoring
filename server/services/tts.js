import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { env } from '../config.js';

const ELEVEN_API = 'https://api.elevenlabs.io/v1';

/** Strip anything that should never be read out loud. */
export function cleanForSpeech(text = '') {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[*_#>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn an alert into speech that sounds human when read aloud. */
export function buildScript(email, { reasons = [], ownerName = 'there', style = 'subject' } = {}) {
  const owner = cleanForSpeech(ownerName) || 'there';
  const sender = cleanForSpeech(email.from?.name || email.from?.email || 'someone');
  const subject = cleanForSpeech(email.subject || '(no subject)').slice(0, 110);

  if (email.test) {
    return `Hi ${owner}, this is Ricky. This is a test call. If you can hear this, your voice alerts are working. That is all. Talk soon.`;
  }

  const mode = ['subject', 'brief', 'detailed'].includes(style) ? style : 'subject';
  const parts = [`Hi ${owner}, this is Ricky.`, `You just got an important email from ${sender} about ${subject}.`];

  if (mode !== 'subject') {
    const summary = cleanForSpeech(email.snippet || email.body || '').slice(0, mode === 'brief' ? 140 : 260);
    if (summary) parts.push(summary.endsWith('.') ? summary : `${summary}.`);
  }

  if (mode === 'detailed') {
    const why = reasons
      .filter((r) => r.points > 0)
      .slice(0, 2)
      .map((r) => r.label.replace(/\s*\([^)]*\)/g, '').trim());
    if (why.length) parts.push(`I flagged it because it ${why.join(' and ')}.`);
  }

  parts.push('That is all. Talk soon.');
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 900);
}

/** Which engine will actually be used for the next call. */
export function activeProvider() {
  if (env.tts.provider === 'elevenlabs') return env.tts.elevenApiKey ? 'elevenlabs' : 'edge';
  if (env.tts.provider === 'edge') return 'edge';
  return env.tts.elevenApiKey ? 'elevenlabs' : 'edge';
}

export const providerLabel = (provider) => (provider === 'elevenlabs' ? 'ElevenLabs' : 'Edge neural');

/* ------------------------------------------------------------------ engines */

async function synthesizeElevenLabs(text) {
  if (!env.tts.elevenApiKey) throw new Error('ELEVENLABS_API_KEY is not set.');

  const res = await fetch(
    `${ELEVEN_API}/text-to-speech/${encodeURIComponent(env.tts.elevenVoiceId)}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'xi-api-key': env.tts.elevenApiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: env.tts.elevenModelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('ElevenLabs returned empty audio.');
  return buffer;
}

async function synthesizeEdge(text) {
  // Microsoft Edge's Read Aloud voices: free, no API key, no account.
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 10_000, synthesisTimeoutMs: 20_000 });
  try {
    await tts.setMetadata(env.tts.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: env.tts.edgeRate });

    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge TTS timed out.')), 25_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', done);
      audioStream.on('close', done);
      audioStream.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error('Edge TTS returned empty audio.');
    return buffer;
  } finally {
    try {
      tts.close();
    } catch {}
  }
}

/**
 * Produce an MP3 for the alert.
 * Tries the configured engine, then falls back to the free one so a missing
 * key or an exhausted free quota never stops a call from ringing.
 */
export async function synthesize(text) {
  const clean = cleanForSpeech(text).slice(0, 900);
  if (!clean) throw new Error('Nothing to say.');

  const primary = activeProvider();
  const run = (provider) => (provider === 'elevenlabs' ? synthesizeElevenLabs(clean) : synthesizeEdge(clean));

  try {
    return { buffer: await run(primary), provider: primary };
  } catch (error) {
    if (primary === 'edge') throw error;
    const buffer = await synthesizeEdge(clean);
    return {
      buffer,
      provider: 'edge',
      fallbackReason: error.message,
    };
  }
}
