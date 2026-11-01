import assert from 'node:assert/strict';
import test from 'node:test';
import { alertGate } from '../services/pipeline.js';

const baseSettings = {
  cooldownSeconds: 300,
  maxAlertsPerHour: 6,
  // Always inside quiet hours, whatever time the suite runs at.
  quietHours: { enabled: true, start: '00:00', end: '23:59' },
  alertVipDuringQuietHours: true,
};

const stateWith = (alerts) => ({ alerts });

test('quiet hours hold a normal call', () => {
  const gate = alertGate(baseSettings, stateWith([]), { isVip: false });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /quiet hours/i);
});

test('VIP senders still ring during quiet hours when allowed', () => {
  const gate = alertGate(baseSettings, stateWith([]), { isVip: true });
  assert.equal(gate.ok, true);
});

test('VIP senders are held when that preference is off', () => {
  const gate = alertGate({ ...baseSettings, alertVipDuringQuietHours: false }, stateWith([]), { isVip: true });
  assert.equal(gate.ok, false);
});

test('a manual call skips quiet hours, cooldown and the hourly cap', () => {
  const now = Date.now();
  const busy = stateWith([1, 2, 3, 4, 5, 6].map((n) => ({ createdAt: now - n * 1000 })));
  assert.equal(alertGate(baseSettings, busy, { manual: true }).ok, true);
});

test('cooldown blocks a second automatic call', () => {
  const settings = { ...baseSettings, quietHours: { enabled: false } };
  const gate = alertGate(settings, stateWith([{ createdAt: Date.now() - 5_000 }]), {});
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /cooling down/i);
});

test('the hourly cap blocks runaway calling', () => {
  const settings = { ...baseSettings, quietHours: { enabled: false }, cooldownSeconds: 0 };
  const now = Date.now();
  const alerts = Array.from({ length: 6 }, (_, index) => ({ createdAt: now - index * 1000 }));
  const gate = alertGate(settings, stateWith(alerts), {});
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /limit/i);
});

test('one quiet call per cooldown window is allowed', () => {
  const settings = { ...baseSettings, quietHours: { enabled: false }, cooldownSeconds: 300 };
  const gate = alertGate(settings, stateWith([{ createdAt: Date.now() - 10 * 60_000 }]), {});
  assert.equal(gate.ok, true);
});
