import fs from 'node:fs';

const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

const ids = [...new Set([...app.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))];
const missingIds = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));

console.log('referenced ids:', ids.length);
console.log('missing ids:', missingIds.length ? missingIds : 'none');

const views = ['overview', 'inbox', 'calls', 'settings', 'setup'];
console.log('views present:', views.filter((v) => html.includes(`data-view="${v}"`)).length, '/', views.length);

const names = [...new Set([...html.matchAll(/name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]))].sort();
console.log('form fields:', names.join(', '));

const expected = [
  'ownerName', 'autoAlert', 'threshold', 'vipSenders', 'ignoreSenders', 'keywords',
  'scriptStyle', 'notifyPush', 'ringtone', 'speakOnAnswer',
  'pollSeconds', 'cooldownSeconds', 'maxAlertsPerHour', 'lookbackMinutes',
  'quietHoursEnabled', 'quietStart', 'quietEnd', 'alertVipDuringQuietHours',
];
console.log('missing form fields:', expected.filter((n) => !names.includes(n)));

const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(assets)];
for (const asset of uniq) {
  const file = asset.replace(/^\//, '').split('?')[0];
  const local = COMMON_PREFIX(file);
  console.log('asset', asset, fs.existsSync(local) ? 'exists' : 'MISSING');
}

function COMMON_PREFIX(file) {
  if (file === '' || file.endsWith('/')) return 'public/index.html';
  return 'public/' + file;
}
