/** Screenshot the split login page at desktop + mobile sizes. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.AUDIT_URL || 'http://127.0.0.1:4173';
const OUT = path.resolve('data', 'shots-login');
const PORT = 9337;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.resolve('data', 'chrome-profile-login');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome debugger did not come up');
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error.message));
  else p.resolve(m.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = id++;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');

const shots = [
  ['login-desktop-1440', 1440, 900, false],
  ['login-desktop-1024', 1024, 768, false],
  ['login-mobile-390', 390, 844, true],
  ['login-mobile-360', 360, 740, true],
  ['login-landscape-844', 844, 390, true],
];

const probe = `(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 40) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  const visual = document.querySelector('.visual');
  const video = document.getElementById('login-video');
  const panel = document.querySelector('.panel');
  const card = document.querySelector('.card');
  const rect = (el) => (el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) } : null);
  return {
    vw,
    scroll: document.documentElement.scrollWidth,
    docHeight: document.body.scrollHeight,
    visualH: visual ? Math.round(visual.getBoundingClientRect().height) : null,
    videoState: visual ? visual.className : null,
    videoTime: video ? Number(video.currentTime.toFixed(2)) : null,
    videoReady: video ? video.readyState : null,
    panelRect: rect(panel),
    cardRect: rect(card),
    bad,
  };
})()`;

for (const [name, w, h, mobile] of shots) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: BASE + '/login' });
  await sleep(2500);

  const { result } = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  const d = result.value;
  console.log(`\n=== ${name} (${w}x${h}) ===`);
  console.log(`  viewport ${d.vw}  scrollWidth ${d.scroll}  docHeight ${d.docHeight}  visual ${d.visualH}px  [${d.videoState}]  video t=${d.videoTime}s ready=${d.videoReady}`);
  console.log(`  panel ${JSON.stringify(d.panelRect)}  card ${JSON.stringify(d.cardRect)}`);
  if (!d.bad.length) console.log('  no horizontal overflow');
  for (const b of d.bad) console.log('  OVERFLOW', b);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: Math.max(h, d.docHeight), scale: 1 },
  });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

ws.close();
chrome.kill();
console.log(`\nscreenshots: ${OUT}`);
