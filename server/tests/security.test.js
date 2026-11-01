import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEmail } from '../services/importance.js';

const settings = {
  threshold: 60,
  vipSenders: [],
  ignoreSenders: [],
  keywords: ['urgent', 'asap', 'action required', 'deadline', 'invoice', 'security alert'],
  ownerAddress: '',
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

const securityEmail = (overrides = {}) => ({
  from: { name: 'Google', email: 'no-reply@accounts.google.com' },
  to: 'jagan@gmail.com',
  subject: 'Security alert',
  snippet: 'We noticed a new sign-in to your Google Account on a Windows device.',
  body: 'We noticed a new sign-in to your Google Account on a Windows device. If this was you, no action is needed.',
  receivedAt: Date.now(),
  labels: [],
  hasAttachment: false,
  isNewsletter: false,
  isAutomated: true,
  ...overrides,
});

test('a security alert from a no-reply provider clears the call threshold', () => {
  const result = scoreEmail(securityEmail(), settings);
  assert.equal(result.level, 'important');
  assert.ok(result.score >= 60, `expected >= 60, got ${result.score}`);
  assert.ok(result.reasons.some((r) => r.label.includes('security alert')));
});

test('the automated-sender penalty no longer applies to security notices', () => {
  const reasons = scoreEmail(securityEmail(), settings).reasons.map((r) => r.label);
  assert.ok(!reasons.some((label) => label.includes('no-reply')));
  assert.ok(!reasons.some((label) => label.includes('automated or promotional')));
});

test('an account-recovery notice also rings', () => {
  const result = scoreEmail(
    securityEmail({
      subject: 'Your Google Account was recovered successfully',
      snippet: 'Your account was recovered. Review recent activity.',
    }),
    settings
  );
  assert.ok(result.score >= 60, `expected >= 60, got ${result.score}`);
});

test('security scoring works even without a keyword match or Gmail labels', () => {
  const result = scoreEmail(
    securityEmail({
      subject: 'Unusual activity',
      snippet: 'We blocked a sign-in attempt from an unknown device.',
      labels: [],
    }),
    { ...settings, keywords: [] }
  );
  assert.ok(result.score >= 60, `expected >= 60, got ${result.score}`);
});

test('an older security notice still clears the threshold', () => {
  const result = scoreEmail(securityEmail({ receivedAt: Date.now() - 50 * 60_000 }), settings);
  assert.ok(result.score >= 60, `expected >= 60, got ${result.score}`);
});

test('promotions and newsletters still stay quiet', () => {
  const promo = scoreEmail(
    securityEmail({
      from: { name: 'Shop', email: 'deals@shop.example' },
      subject: 'Weekend sale - 30% off everything',
      snippet: 'Unsubscribe at any time.',
      body: 'Huge savings this weekend only. Unsubscribe at any time.',
      isNewsletter: true,
      isAutomated: true,
    }),
    settings
  );
  assert.equal(promo.level, 'normal');
});
