import { env } from '../config.js';

export function resolveProvider(settings) {
  if (settings.provider && settings.provider !== 'auto') return settings.provider;
  if (env.eleven.apiKey && env.eleven.agentId && env.eleven.agentPhoneNumberId) return 'elevenlabs';
  if (env.twilio.accountSid && env.twilio.authToken && env.twilio.fromNumber) return 'twilio';
  return 'simulate';
}

export function providerLabel(provider) {
  return {
    elevenlabs: 'ElevenLabs agent',
    twilio: 'Twilio + ElevenLabs voice',
    simulate: 'Simulated (no call placed)',
  }[provider] || provider;
}

/**
 * Place the call. `twilio` plays the MP3 we generated through ElevenLabs;
 * `elevenlabs` hands the message variables to a conversational agent.
 */
export async function placeCall({ provider, toNumber, audioUrl, twimlUrl, variables = {}, callId, settings }) {
  if (provider === 'simulate') {
    return { ok: true, status: 'simulated', externalId: null, note: 'Simulation mode - audio generated but nobody was called.' };
  }

  if (!toNumber) {
    throw new Error('No destination phone number is set. Add one in Settings.');
  }

  if (provider === 'elevenlabs') {
    if (!env.eleven.apiKey) throw new Error('ELEVENLABS_API_KEY is missing.');
    if (!env.eleven.agentId || !env.eleven.agentPhoneNumberId) {
      throw new Error('ELEVENLABS_AGENT_ID and ELEVENLABS_AGENT_PHONE_NUMBER_ID are required for agent calls.');
    }

    const { outboundCall } = await import('./elevenlabs.js');
    const response = await outboundCall({
      toNumber,
      variables: {
        ...variables,
        owner_name: settings.ownerName || 'there',
      },
    });

    return {
      ok: true,
      status: 'calling',
      externalId: response?.conversation_id || response?.callSid || response?.call_sid || null,
      raw: response,
    };
  }

  if (provider === 'twilio') {
    const { accountSid, authToken, fromNumber } = env.twilio;
    if (!accountSid || !authToken || !fromNumber) {
      throw new Error('Twilio credentials are incomplete (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).');
    }

    if (env.twilio.fromNumber === toNumber) {
      throw new Error('The destination number is the same as the Twilio caller ID.');
    }

    const body = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Url: twimlUrl || `${env.publicBaseUrl}/twiml/${callId}`,
      MachineDetection: 'Enable',
      Timeout: '30',
    });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!res.ok) {
      throw new Error(`Twilio call failed (${res.status}): ${payload?.message || text.slice(0, 300)}`);
    }

    return { ok: true, status: payload.status || 'queued', externalId: payload.sid || null };
  }

  throw new Error(`Unknown provider: ${provider}`);
}
