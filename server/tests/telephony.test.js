import assert from 'node:assert/strict';
import test from 'node:test';

// Configure before importing the modules that snapshot env at load time.
process.env.TWILIO_ACCOUNT_SID = 'ACtestaccount';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.TWILIO_FROM_NUMBER = '+15550000001';
process.env.ELEVENLABS_API_KEY = 'sk_test';
process.env.ELEVENLABS_AGENT_ID = 'agent_123';
process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID = 'phnum_456';
process.env.PUBLIC_BASE_URL = 'https://ricky.example.com';

const { placeCall } = await import('../services/telephony.js');

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('twilio path posts a call with the TwiML url and basic auth', async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), options });
    return jsonResponse({ sid: 'CA123', status: 'queued' }, 201);
  };

  const result = await placeCall({
    provider: 'twilio',
    toNumber: '+15550000002',
    callId: 'call-1',
    settings: {},
  });

  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /Accounts\/ACtestaccount\/Calls\.json$/);
  assert.equal(seen[0].options.method, 'POST');
  assert.match(seen[0].options.headers.authorization, /^Basic /);
  assert.match(seen[0].options.body.toString(), /Url=https%3A%2F%2Fricky\.example\.com%2Ftwiml%2Fcall-1/);
  assert.match(seen[0].options.body.toString(), /To=%2B15550000002/);
  assert.equal(result.externalId, 'CA123');
});

test('elevenlabs path sends agent ids and dynamic variables', async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), options });
    return jsonResponse({ success: true, conversation_id: 'conv_9' });
  };

  const result = await placeCall({
    provider: 'elevenlabs',
    toNumber: '+15550000002',
    callId: 'call-2',
    settings: { ownerName: 'Sam' },
    variables: { email_subject: 'Invoice overdue', email_sender: 'dana@company.com' },
  });

  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v1\/convai\/twilio\/outbound-call$/);
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.agent_id, 'agent_123');
  assert.equal(body.agent_phone_number_id, 'phnum_456');
  assert.equal(body.to_number, '+15550000002');
  assert.equal(body.conversation_initiation_client_data.dynamic_variables.owner_name, 'Sam');
  assert.equal(body.conversation_initiation_client_data.dynamic_variables.email_subject, 'Invoice overdue');
  assert.equal(result.externalId, 'conv_9');
});

test('simulate path never touches the network', async () => {
  globalThis.fetch = async () => {
    throw new Error('network should not be used');
  };
  const result = await placeCall({ provider: 'simulate', toNumber: '', callId: 'call-3', settings: {} });
  assert.equal(result.status, 'simulated');
});

test('missing destination number is rejected before dialling', async () => {
  await assert.rejects(() => placeCall({ provider: 'twilio', toNumber: '', callId: 'call-4', settings: {} }), /destination phone number/i);
});

test('surface provider errors with context', async () => {
  globalThis.fetch = async () => jsonResponse({ message: 'Bad number' }, 400);
  await assert.rejects(
    () => placeCall({ provider: 'twilio', toNumber: '+15550000002', callId: 'call-5', settings: {} }),
    /Twilio call failed \(400\): Bad number/
  );
});
