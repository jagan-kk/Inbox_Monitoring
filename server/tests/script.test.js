import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScript } from '../services/elevenlabs.js';

const email = {
  from: { name: 'Dana Reed', email: 'dana@company.com' },
  subject: 'Q4 contract renewal',
  snippet: 'Dana needs your signature on the renewed agreement before Friday. The document is attached to the portal.',
  body: 'Dana needs your signature on the renewed agreement before Friday. The document is attached to the portal.',
};

const reasons = [
  { label: 'needs your action', points: 16 },
  { label: 'mentions a deadline', points: 16 },
];

test('subject style reads the sender and subject only', () => {
  const script = buildScript(email, { reasons, ownerName: 'Sam', style: 'subject' });
  assert.match(script, /Dana Reed/);
  assert.match(script, /Q4 contract renewal/);
  assert.doesNotMatch(script, /signature/);
  assert.ok(script.length < 200, `script too long: ${script.length} chars`);
});

test('subject style is the default', () => {
  assert.equal(buildScript(email, { ownerName: 'Sam' }), buildScript(email, { ownerName: 'Sam', style: 'subject' }));
});

test('brief style adds one line of preview but no reason', () => {
  const script = buildScript(email, { reasons, ownerName: 'Sam', style: 'brief' });
  assert.match(script, /signature/);
  assert.doesNotMatch(script, /flagged it because/);
});

test('detailed style adds preview and reason', () => {
  const script = buildScript(email, { reasons, ownerName: 'Sam', style: 'detailed' });
  assert.match(script, /signature/);
  assert.match(script, /flagged it because it needs your action and mentions a deadline/);
});

test('test alerts use a fixed confirmation line', () => {
  const script = buildScript({ ...email, test: true }, { ownerName: 'Sam' });
  assert.match(script, /This is a test call/);
  assert.doesNotMatch(script, /Q4 contract renewal/);
});

test('URLs and email addresses never reach the voice', () => {
  const script = buildScript(
    {
      ...email,
      subject: 'Invoice https://pay.example.com/abc',
      snippet: 'Reply to billing@example.com now.',
    },
    { ownerName: 'Sam', style: 'detailed' }
  );
  assert.doesNotMatch(script, /https?:\/\//);
  assert.doesNotMatch(script, /billing@example\.com/);
});
