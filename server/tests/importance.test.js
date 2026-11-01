import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEmail, isQuietNow, humaniseReasons } from '../services/importance.js';

const baseSettings = {
  threshold: 60,
  vipSenders: [],
  ignoreSenders: [],
  keywords: ['urgent', 'invoice', 'deadline'],
  ownerAddress: 'me@example.com',
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

const email = (overrides = {}) => ({
  from: { name: 'Dana Reed', email: 'dana@company.com' },
  to: 'me@example.com',
  subject: 'Contract renewal',
  snippet: 'Could you review the attached renewal?',
  body: 'Could you review the attached renewal?',
  receivedAt: Date.now(),
  labels: [],
  hasAttachment: true,
  isNewsletter: false,
  isAutomated: false,
  ...overrides,
});

test('a VIP sender clears the threshold', () => {
  const result = scoreEmail(email(), { ...baseSettings, vipSenders: ['dana@company.com'] });
  assert.equal(result.level, 'important');
  assert.ok(result.score >= 60);
  assert.ok(result.reasons.some((r) => r.label.includes('VIP')));
});

test('wildcard domains match', () => {
  const result = scoreEmail(email(), { ...baseSettings, vipSenders: ['*@company.com'] });
  assert.equal(result.isVip, true);
  assert.equal(result.level, 'important');
});

test('newsletters stay quiet', () => {
  const result = scoreEmail(
    email({
      from: { name: 'Deals', email: 'news@shop.com' },
      subject: '50% off everything',
      snippet: 'Sale ends tonight. Unsubscribe here.',
      isNewsletter: true,
      hasAttachment: false,
    }),
    baseSettings
  );
  assert.notEqual(result.level, 'important');
  assert.ok(result.score < 40);
});

test('ignored senders score zero', () => {
  const result = scoreEmail(email(), { ...baseSettings, ignoreSenders: ['dana@company.com'] });
  assert.equal(result.score, 0);
  assert.equal(result.level, 'ignored');
});

test('urgency language raises the score', () => {
  const calm = scoreEmail(email({ subject: 'Lunch on Friday?', snippet: 'No rush.' }), baseSettings);
  const urgent = scoreEmail(
    email({
      subject: 'URGENT: production outage',
      snippet: 'The deploy failed and the deadline is today. Please review immediately.',
    }),
    baseSettings
  );
  assert.ok(urgent.score > calm.score);
  assert.equal(urgent.level, 'important');
});

test('reason labels read naturally after "because it"', () => {
  const result = scoreEmail(
    email({ subject: 'Urgent: invoice overdue', snippet: 'Please review this payment immediately.' }),
    baseSettings
  );
  const phrase = humaniseReasons(result.reasons);
  assert.match(phrase, /^(says|needs|mentions|is|looks|may|comes|was|has|arrived|matches)/);
});

test('quiet hours wrap around midnight', () => {
  assert.equal(isQuietNow({ enabled: false, start: '00:00', end: '23:59' }), false);
  const now = new Date();
  const start = `${String((now.getHours() + 23) % 24).padStart(2, '0')}:00`;
  const end = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:59`;
  assert.equal(isQuietNow({ enabled: true, start, end }), true);
});
