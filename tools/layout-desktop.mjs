/** Desktop layout audit: verify no horizontal overflow at 1024x768 and 1440x900. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.AUDIT_URL || 'http://127.0.0.1:4180';
const OUT = path.resolve('data', 'shots-desktop');
const PORT = 9335;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.resolve('data', 'chrome-profile-desktop');
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

const auditExpression = `(() => {
  const vw = document.documentElement.clientWidth;
  const overflow = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
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

const shots = [
  ['overview-1024', '/', 1024, 768],
  ['inbox-1024', '/#inbox', 1024, 768],
  ['settings-1024', '/#settings', 1024, 768],
  ['overview-1440', '/', 1440, 900],
  ['calls-1440', '/#calls', 1440, 900],
];

for (const [name, route, w, h] of shots) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + route });
  await sleep(2200);

  const { result } = await send('Runtime.evaluate', { expression: auditExpression, returnByValue: true });
  const data = result.value;

  console.log(`\n=== ${name} (${w}x${h}) ===`);
  console.log(`viewport ${data.viewport}px  document ${data.docScrollWidth}px  body ${data.bodyScrollWidth}px`);
  if (data.overflow.length === 0) console.log('no horizontal overflow');
  for (const item of data.overflow) {
    console.log(`  overflow <${item.tag}${item.id ? '#' + item.id : ''}> .${item.cls} left=${item.left} right=${item.right} w=${item.width} "${item.text}"`);
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.min(data.docScrollWidth, w), height: Math.min(data.bodyScrollWidth, 2000), scale: 1 },
  });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

ws.close();
chrome.kill();
console.log(`\nscreenshots: ${OUT}`);
