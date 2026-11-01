/** One-off geometry probe: dumps child boxes of inbox rows. */
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.resolve('data', 'chrome-profile-probe');

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
  throw new Error('no debugger');
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'http://127.0.0.1:4180/?_=probe#inbox' });
await sleep(3000);

const expr = `(() => {
  const rows = [...document.querySelectorAll('#inbox-list .item')].slice(0, 3);
  return rows.map((row) => {
    const main = row.querySelector('.item-main');
    return {
      subject: row.querySelector('.item-subject')?.textContent?.slice(0, 30),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      children: [...main.children].map((c) => ({
        cls: c.className,
        top: Math.round(c.getBoundingClientRect().top),
        h: Math.round(c.getBoundingClientRect().height),
        marginTop: getComputedStyle(c).marginTop,
      })),
    };
  });
})()`;

const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(JSON.stringify(result.value, null, 2));

ws.close();
chrome.kill();
