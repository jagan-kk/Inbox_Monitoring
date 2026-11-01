/**
 * Transparent, offline importance scoring.
 * Every point is explainable, which is what the dashboard shows you.
 */

const URGENT_PATTERNS = [
  [/urgent|asap|immediately|right away|time[- ]sensitive|emergency/i, 'says it is time-sensitive', 18],
  [/action required|response required|needs? your (input|approval|attention)|please (review|sign|confirm)|signature required/i, 'needs your action', 16],
  [/deadline|due (today|tomorrow|by)|final notice|last chance|overdue|expires? (today|soon)/i, 'mentions a deadline', 16],
  [/payment failed|invoice|past due|wire transfer|refund|billing issue|failed charge/i, 'is about money or billing', 15],
  [/security alert|unauthorized|suspicious (login|activity)|password|verify your|two[- ]factor|breach/i, 'looks like a security alert', 16],
  [/offer letter|contract|interview|termination|resignation|legal notice/i, 'may affect your work or contract', 15],
  [/production|outage|server down|incident|build failed|deploy failed/i, 'looks like an operational alert', 14],
  [/admission|tuition|scholarship|exam|transcript|enrollment/i, 'is about school or enrollment', 11],
];

const LOW_PRIORITY_PATTERNS = [
  [/newsletter|webinar|unsubscribe|promotion|sale ends|% off|coupon/i, 'looks promotional'],
  [/no-?reply|do-?not-?reply|notification|automated message/i, 'comes from an automated sender'],
];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const normaliseAddress = (value = '') => value.trim().toLowerCase();

function senderMatches(sender, rule) {
  const entry = normaliseAddress(rule).replace(/^@/, '*@');
  if (!entry) return false;
  const email = normaliseAddress(sender.email);
  const name = normaliseAddress(sender.name);

  if (entry.startsWith('*@')) return email.endsWith(entry.slice(1));
  if (entry.startsWith('@')) return email.endsWith(entry);
  if (entry.includes('@')) return email === entry;
  return name.includes(entry) || email.split('@')[0].includes(entry);
}

export function scoreEmail(email, settings) {
  let score = 12;
  const reasons = [];
  const add = (points, label) => {
    score += points;
    reasons.push({ label, points });
  };

  const subjectAndBody = `${email.subject}\n${email.body || email.snippet}`;

  const ignored = (settings.ignoreSenders || []).find((rule) => senderMatches(email.from, rule));
  if (ignored) return { score: 0, level: 'ignored', reasons: [{ label: `sender ignored (${ignored})`, points: -100 }], isVip: false };

  const vipRule = (settings.vipSenders || []).find((rule) => senderMatches(email.from, rule));
  const isVip = Boolean(vipRule);
  if (isVip) add(45, `comes from a VIP sender (${vipRule})`);

  let matched = 0;
  for (const [pattern, label, points] of URGENT_PATTERNS) {
    if (pattern.test(subjectAndBody)) {
      add(points, label);
      matched += points;
    }
    if (matched >= 45) break;
  }

  const customHits = (settings.keywords || [])
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => subjectAndBody.toLowerCase().includes(word.toLowerCase()));

  if (customHits.length) {
    add(clamp(customHits.length * 10, 10, 24), `matches your keywords: ${customHits.slice(0, 3).join(', ')}`);
  }

  if (email.to && settings.ownerAddress && email.to.toLowerCase().includes(settings.ownerAddress.toLowerCase())) {
    add(10, 'is addressed directly to you');
  } else if (!email.isNewsletter) {
    add(6, 'was sent directly to you');
  }

  if (email.hasAttachment) add(6, 'has an attachment');
  if ((email.labels || []).includes('IMPORTANT') || (email.labels || []).includes('CATEGORY_PERSONAL')) {
    add(8, 'is marked important by Gmail');
  }
  if ((email.labels || []).includes('STARRED')) add(8, 'was starred by you');
  if (email.isNewsletter) {
    add(-35, 'looks like a newsletter');
  } else if (LOW_PRIORITY_PATTERNS.some(([pattern]) => pattern.test(`${email.subject}\n${email.snippet}`))) {
    add(-16, 'looks automated or promotional');
  }
  if (email.isAutomated && !isVip) add(-10, 'automated no-reply sender');
  if (/[!]{2,}|\b[A-Z]{6,}\b/.test(email.subject)) add(4, 'has a shouty subject line');
  if (Date.now() - email.receivedAt < 30 * 60_000) add(5, 'arrived in the last 30 minutes');

  score = clamp(Math.round(score), 0, 100);
  const threshold = Number(settings.threshold) || 60;
  const level = score >= threshold ? 'important' : score >= threshold - 20 ? 'watch' : 'normal';

  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, level, reasons, isVip };
}

const spoken = (label = '') => label.replace(/\s*\([^)]*\)/g, '').trim();

export function humaniseReasons(reasons = []) {
  const positives = reasons.filter((r) => r.points > 0).slice(0, 2).map((r) => spoken(r.label));
  if (!positives.length) return 'it matched your alert rules';
  return positives.join(' and ');
}

export function isQuietNow(quietHours) {
  if (!quietHours?.enabled) return false;
  const [sh, sm] = String(quietHours.start || '22:00').split(':').map(Number);
  const [eh, em] = String(quietHours.end || '07:00').split(':').map(Number);
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + (sm || 0);
  const end = eh * 60 + (em || 0);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
