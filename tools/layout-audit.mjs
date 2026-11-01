/**
 * Mobile layout audit.
 *
 * Drives a real Chrome over CDP at phone size, reports elements that overflow
 * horizontally, and saves full-page screenshots. Requires the app running on
 * http://127.0.0.1:4180 (no password) and Chrome installed.
 *
 *   node tools/layout-audit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.AUDIT_URL || 'http://127.0.0.1:4180';
const OUT = path.resolve('data', 'shots');
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profileDir = path.resolve('data', 'chrome-profile');
fs.mkdirSync(profileDir, { recursive: true });

let chromeErr = '';
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
chrome.stderr.on('data', (chunk) => {
  chromeErr += chunk.toString();
});

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Chrome debugger did not come up\n${chromeErr.slice(0, 800)}`);
}

const ws = new WebSocket(await target());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (!msg.id) return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error.message));
  else entry.resolve(msg.result);
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true });

const auditExpression = `(() => {
  const vw = document.documentElement.clientWidth;
  const overflow = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
    if (r.right > vw + 1 || r.left < -1) {
      const key = el.tagName + '.' + el.className + '|' + Math.round(r.left) + '|' + Math.round(r.right);
      if (seen.has(key)) continue;
      seen.add(key);
      overflow.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        id: el.id || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        scrolls,
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  return {
    viewport: vw,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflow,
  };
})()`;

const connectedAction = `(() => {
  const c = document.querySelector('#call');
  c.hidden = false;
  c.classList.remove('ringing');
  c.classList.add('connected');
  document.querySelector('#call-status').textContent = 'Connected';
  document.querySelector('#call-actions').hidden = true;
  document.querySelector('#call-controls').hidden = false;
  const t = document.querySelector('#call-transcript');
  t.hidden = false;
  t.innerHTML = '<small>Ricky is saying</small>Hi Jagan, this is Ricky. You just got an important email from Dana Reed about the Q4 contract renewal.';
  document.querySelector('#call-timer').textContent = '00:07';
  document.body.style.overflow = 'hidden';
})()`;

const shots = [
  ['overview', '/?_=overview'],
  ['inbox', '/?_=inbox#inbox'],
  ['calls', '/?_=calls#calls'],
  ['settings', '/?_=settings#settings'],
  ['setup', '/?_=setup#setup'],
  ['call-ringing', '/?_=ring&call=test', null, 844],
  ['call-connected', '/?_=conn&call=test', connectedAction, 844],
];

for (const [name, route, action, fixedHeight] of shots) {
  await send('Page.navigate', { url: BASE + route });
  await sleep(2600);

  if (action) {
    await send('Runtime.evaluate', { expression: action });
    await sleep(1600);
  }

  const { result } = await send('Runtime.evaluate', {
    expression: auditExpression,
    returnByValue: true,
  });

  const metrics = await send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(size.width, 390),
      height: Math.min(size.height, fixedHeight || 2600),
      scale: 1,
    },
  });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));

  const data = result.value;
  console.log(`\n=== ${name} (${route}) ===`);
  console.log(`viewport ${data.viewport}px  document ${data.docScrollWidth}px  body ${data.bodyScrollWidth}px`);
  if (data.overflow.length === 0) console.log('no horizontal overflow');
  for (const item of data.overflow) {
    console.log(
      `  overflow ${item.scrolls ? '(scrollable)' : '(CLIPPED)'} <${item.tag}${item.id ? '#' + item.id : ''}> .${item.cls} left=${item.left} right=${item.right} w=${item.width} "${item.text}"`
    );
  }
}

ws.close();
chrome.kill();
console.log(`\nscreenshots: ${OUT}`);
