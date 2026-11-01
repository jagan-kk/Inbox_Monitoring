import crypto from 'node:crypto';
import express from 'express';
import { env } from './config.js';

const COOKIE = 'ricky_session';
const secret = env.sessionSecret || env.appPassword;
const required = Boolean(env.appPassword);

const sessionToken = () => crypto.createHmac('sha256', secret).update('ricky-session-v1').digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function isAuthed(req) {
  if (!required) return true;
  const value = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(value) && safeEqual(value, sessionToken());
}

const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 30,
  secure: req.secure || env.publicBaseUrl.startsWith('https'),
});

const safeNext = (value) => {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
};

const OPEN = [
  /^\/login$/,
  /^\/logout$/,
  /^\/api\/health$/,
  /^\/api\/cron\//,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/icons\//,
  /^\/styles\.css$/,
  /^\/app\.js$/,
  /^\/favicon/,
];

export const authRequired = required;

export function authMiddleware() {
  return (req, res, next) => {
    if (isAuthed(req)) return next();
    if (OPEN.some((pattern) => pattern.test(req.path))) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Sign in to Ricky first.', login: true });
    }
    return res.redirect(`/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
  };
}

const loginPage = ({ next = '/', error = '' } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Ricky - sign in</title>
<meta name="theme-color" content="#070a0e" />
<link rel="icon" href="/icons/favicon.svg" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; place-items: center; padding: 24px;
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    background:
      radial-gradient(900px 520px at 10% -10%, rgba(124,243,160,.12), transparent 60%),
      radial-gradient(700px 420px at 100% 0%, rgba(108,199,255,.10), transparent 55%),
      #070a0e;
    color: #e8eef6;
  }
  .card {
    width: 100%; max-width: 380px; padding: 28px 24px;
    background: linear-gradient(180deg, #101821, #0b1118);
    border: 1px solid rgba(255,255,255,.08); border-radius: 20px;
    box-shadow: 0 30px 80px rgba(0,0,0,.55);
  }
  .mark {
    width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center;
    font-weight: 800; font-size: 24px; color: #04120a;
    background: linear-gradient(140deg, #b6ffcb, #4bdd86);
    box-shadow: 0 12px 30px rgba(76,221,134,.28);
  }
  h1 { font-size: 22px; margin: 18px 0 6px; letter-spacing: -.2px; }
  p { margin: 0 0 22px; color: #8b9bb0; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 12.5px; color: #8b9bb0; margin-bottom: 8px; letter-spacing: .3px; }
  input {
    width: 100%; padding: 14px 15px; font-size: 16px; border-radius: 13px;
    border: 1px solid rgba(255,255,255,.12); background: #0a1017; color: #e8eef6;
    outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: rgba(124,243,160,.55); box-shadow: 0 0 0 4px rgba(124,243,160,.12); }
  button {
    width: 100%; margin-top: 16px; padding: 14px 16px; font-size: 15px; font-weight: 650;
    border: 0; border-radius: 13px; cursor: pointer; color: #04120a;
    background: linear-gradient(140deg, #b6ffcb, #4bdd86);
    box-shadow: 0 12px 26px rgba(76,221,134,.22);
  }
  button:active { transform: translateY(1px); }
  .error {
    margin: 0 0 16px; padding: 11px 13px; border-radius: 11px; font-size: 13px;
    color: #ffb4b4; background: rgba(255,122,122,.12); border: 1px solid rgba(255,122,122,.25);
  }
  .foot { margin-top: 18px; font-size: 12px; color: #5c6b7e; text-align: center; }
  @media (prefers-reduced-motion: no-preference) { .card { animation: rise .35s ease-out; } }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="mark">R</div>
    <h1>Ricky is private</h1>
    <p>Enter the password you set in <code>APP_PASSWORD</code> to open your call app.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}" />
    <button type="submit">Open Ricky</button>
    <div class="foot">This device stays signed in for 30 days.</div>
  </form>
</body>
</html>`;

export const authRouter = express.Router();

authRouter.get('/login', (req, res) => {
  if (!required) return res.redirect('/');
  if (isAuthed(req)) return res.redirect(safeNext(req.query.next));
  res.type('html').send(loginPage({ next: safeNext(req.query.next), error: String(req.query.error || '') }));
});

authRouter.post('/login', (req, res) => {
  const next = safeNext(req.body?.next);

  if (!required) return res.redirect(next);

  if (!safeEqual(req.body?.password || '', env.appPassword)) {
    return res.redirect(`/login?error=${encodeURIComponent('That password is not right.')}&next=${encodeURIComponent(next)}`);
  }

  res.cookie(COOKIE, sessionToken(), cookieOptions(req));
  res.redirect(next);
});

const logout = (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
};

authRouter.get('/logout', logout);
authRouter.post('/logout', logout);
