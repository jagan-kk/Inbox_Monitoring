import crypto from 'node:crypto';
import express from 'express';
import { env } from './config.js';
import { userStore } from './store.js';

export const COOKIE = 'ricky_session';
const secret = env.sessionSecret || env.appPassword || 'ricky-default-secret-change-me';
const APP_PASSWORD = env.appPassword;

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

export function parseCookies(header = '') {
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

/** Hash a password with scrypt. Returns `salt:hash` (hex). */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  return `${salt}:${derived.toString('hex')}`;
}

/** Compare a plaintext password against a `salt:hash` string. */
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  return safeEqual(hash, derived.toString('hex'));
}

export function sessionToken(userId) {
  return crypto.createHmac('sha256', secret).update(`user:${userId}`).digest('hex');
}

export function findUserByEmail(email) {
  const users = userStore.data || [];
  return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
}

function isAuthed(req) {
  // APP_PASSWORD bypass (legacy single-password mode)
  if (APP_PASSWORD) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    const expected = crypto.createHmac('sha256', secret).update('app-password-v1').digest('hex');
    if (value && safeEqual(value, expected)) return true;
  }

  // Per-user session cookie
  const value = parseCookies(req.headers.cookie)[COOKIE];
  if (!value) return false;
  const users = userStore.data || [];
  return users.some((u) => u.sessionToken === value && u.sessionExpires && Date.now() < u.sessionExpires);
}

export const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 30,
  secure: req.secure || env.publicBaseUrl.startsWith('https'),
});

export const safeNext = (value) => {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
};

const OPEN = [
  /^\/login$/,
  /^\/logout$/,
  /^\/oauth2callback$/,
  /^\/api\/health$/,
  /^\/api\/auth\//,
  /^\/api\/cron\//,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/icons\//,
  /^\/styles\.css$/,
  /^\/app\.js$/,
  /^\/favicon/,
];

export const authRequired = Boolean(APP_PASSWORD || (userStore.data && userStore.data.length > 0));

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

/* ------------------------------------------------------------------ page --- */

function loginPage({ mode = 'login', next = '/', error = '', usersExist = false } = {}) {
  const showRegister = mode === 'register' || !usersExist;
  const title = showRegister ? 'Create your Ricky account' : 'Sign in to Ricky';
  const hint = showRegister
    ? 'Set your email and password to access your call app.'
    : 'Enter your email and password to open your call app.';
  const submitLabel = showRegister ? 'Create account' : 'Sign in';
  const toggleText = showRegister
    ? 'Already have an account? Sign in'
    : "Don't have an account? Create one";
  const toggleAction = showRegister ? 'login' : 'register';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Ricky - ${title}</title>
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
  p { margin: 0 0 20px; color: #8b9bb0; font-size: 14px; line-height: 1.5; }
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
  button.ghost {
    background: transparent; color: #8b9bb0; box-shadow: none; border: 1px solid rgba(255,255,255,.08);
  }
  button.ghost:hover { background: rgba(255,255,255,.03); }
  .error {
    margin: 0 0 16px; padding: 11px 13px; border-radius: 11px; font-size: 13px;
    color: #ffb4b4; background: rgba(255,122,122,.12); border: 1px solid rgba(255,122,122,.25);
  }
  .toggle { margin-top: 16px; font-size: 13px; color: #8b9bb0; text-align: center; }
  .toggle a { color: #7cf3a0; text-decoration: none; cursor: pointer; }
  .toggle a:hover { text-decoration: underline; }
  .or { margin: 20px 0 12px; font-size: 11px; color: #5c6b7e; text-align: center; letter-spacing: .4px; text-transform: uppercase; }
  .google-btn {
    width: 100%; margin-top: 0; padding: 12px 16px; font-size: 14px; font-weight: 600;
    border: 1px solid rgba(255,255,255,.12); border-radius: 13px; cursor: pointer; color: #e8eef6;
    background: #0a1017; display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .google-btn:hover { background: #101821; border-color: rgba(255,255,255,.2); }
  .google-btn:active { transform: translateY(1px); }
  .google-btn:disabled { opacity: .6; cursor: not-allowed; }
  .foot { margin-top: 18px; font-size: 12px; color: #5c6b7e; text-align: center; }
  @media (prefers-reduced-motion: no-preference) { .card { animation: rise .35s ease-out; } }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body>
  <form class="card" id="auth-form" method="post" action="/login">
    <div class="mark">R</div>
    <h1 id="auth-title">${title}</h1>
    <p id="auth-hint">${hint}</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}" />
    <input type="hidden" name="mode" value="${showRegister ? 'register' : 'login'}" />
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" autocomplete="${showRegister ? 'email' : 'current-email'}" placeholder="you@example.com" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="${showRegister ? 'new-password' : 'current-password'}" required />
    <button type="submit" id="auth-submit">${submitLabel}</button>
    <div class="toggle">
      <span>${toggleText}</span>
      <a href="#" id="auth-toggle">${toggleAction}</a>
    </div>
    ${env.google?.clientId ? `
    <div class="or">Or continue with</div>
    <button type="button" class="google-btn" id="google-login-btn">
      <svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;vertical-align:-1px;margin-right:8px;">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66v-2.77c-1.16-.78-1.95-1.94-2.21-3.31H12v3.73c-1.52-.27-2.85-.91-3.82-1.77v2.47c3.06 0 5.73-1.21 7.57-3.22h2.57c-2.5 2.27-5.79 3.72-9.39 3.72" fill="#34A853"/>
        <path d="M5.84 14.09c-.22.62-.35 1.3-.35 2.09s0 1.96.07 2.82H2v-2.57h3.66c.12-.86.2-1.72.2-2.63s-.07-1.77-.2-2.63H2v-2.57H5.84c.43 1.49 1.59 2.63 3.16 2.63s2.72-1.14 3.14-2.63h2.57c-.42 1.49-1.56 2.63-3.14 2.63-1.57 0-2.73-1.14-3.14-2.63h2.57c-.13.86-.2 1.77-.2 2.63s.07 1.77.2 2.63H5.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64v2.47c-1.98.85-3.43 2.07-4.21 3.74V5.38z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </button>
    ` : ''}
    <div class="foot">This device stays signed in for 30 days.</div>
  </form>
  <script>
    function onToggleClick(e) {
      e.preventDefault();
      const isRegister = modeInput.value === 'register';
      modeInput.value = isRegister ? 'login' : 'register';
      if (isRegister) {
        titleEl.textContent = 'Sign in to Ricky';
        hintEl.textContent = 'Enter your email and password to open your call app.';
        submitBtn.textContent = 'Sign in';
        toggle.innerHTML = "Don't have an account? <a href='#' id='auth-toggle'>Create one</a>";
        document.getElementById('auth-toggle').addEventListener('click', onToggleClick);
      } else {
        titleEl.textContent = 'Create your Ricky account';
        hintEl.textContent = 'Set your email and password to access your call app.';
        submitBtn.textContent = 'Create account';
        toggle.innerHTML = 'Already have an account? <a href="#" id="auth-toggle">Sign in</a>';
        document.getElementById('auth-toggle').addEventListener('click', onToggleClick);
      }
    }

    const toggle = document.getElementById('auth-toggle');
    const form = document.getElementById('auth-form');
    const modeInput = form.querySelector('input[name="mode"]');
    const titleEl = document.getElementById('auth-title');
    const hintEl = document.getElementById('auth-hint');
    const submitBtn = document.getElementById('auth-submit');

    toggle.addEventListener('click', onToggleClick);

    const googleBtn = document.getElementById('google-login-btn');
    if (googleBtn) googleBtn.addEventListener('click', googleLogin);

    async function googleLogin(event) {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/google/login-url');
        if (!res.ok) throw new Error('Google login is not available on this server.');
        const data = await res.json();
        if (data.url) location.href = data.url;
      } catch (e) {
        btn.disabled = false;
        const errDiv = document.createElement('div');
        errDiv.className = 'error';
        errDiv.textContent = e.message || 'Google login failed.';
        const card = document.querySelector('.card');
        const existing = card.querySelector('.error.google');
        if (existing) existing.remove();
        errDiv.classList.add('google');
        card.insertBefore(errDiv, card.querySelector('button[type="submit"]'));
      }
    }
  </script>
</body>
</html>`;
}

export const authRouter = express.Router();

authRouter.get('/login', async (req, res) => {
  const users = userStore.data || [];
  const usersExist = users.length > 0;

  // If auth is not required and no users exist, just go to app
  if (!APP_PASSWORD && !usersExist) return res.redirect('/');

  if (isAuthed(req)) return res.redirect(safeNext(req.query.next));

  const mode = req.query.mode || (usersExist ? 'login' : 'register');
  res.type('html').send(loginPage({
    mode,
    next: safeNext(req.query.next),
    error: String(req.query.error || ''),
    usersExist,
  }));
});

authRouter.post('/login', async (req, res) => {
  const next = safeNext(req.body?.next);
  const mode = req.body?.mode || 'login';
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  // Legacy APP_PASSWORD mode (no email)
  if (APP_PASSWORD && !email && password) {
    if (!safeEqual(password, APP_PASSWORD)) {
      return res.redirect(`/login?error=${encodeURIComponent('That password is not right.')}&next=${encodeURIComponent(next)}`);
    }
    const token = crypto.createHmac('sha256', secret).update('app-password-v1').digest('hex');
    res.cookie(COOKIE, token, cookieOptions(req));
    return res.redirect(next);
  }

  // Per-user email/password mode
  if (mode === 'register') {
    if (!email || !password) {
      return res.redirect(`/login?mode=register&error=${encodeURIComponent('Email and password are required.')}&next=${encodeURIComponent(next)}`);
    }
    if (password.length < 6) {
      return res.redirect(`/login?mode=register&error=${encodeURIComponent('Password must be at least 6 characters.')}&next=${encodeURIComponent(next)}`);
    }
    if (findUserByEmail(email)) {
      return res.redirect(`/login?mode=register&error=${encodeURIComponent('An account with this email already exists.')}&next=${encodeURIComponent(next)}`);
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomBytes(16).toString('hex');
    const user = {
      id: userId,
      email,
      passwordHash,
      createdAt: Date.now(),
    };
    const users = userStore.data || [];
    users.push(user);
    userStore.data = users;
    userStore.save();

    const token = sessionToken(userId);
    const sessionExpires = Date.now() + 1000 * 60 * 60 * 24 * 30;
    user.sessionToken = token;
    user.sessionExpires = sessionExpires;
    userStore.save();

    res.cookie(COOKIE, token, cookieOptions(req));
    return res.redirect(next);
  }

  // Login mode
  if (!email || !password) {
    return res.redirect(`/login?error=${encodeURIComponent('Email and password are required.')}&next=${encodeURIComponent(next)}`);
  }

  const user = findUserByEmail(email);
  if (!user || !user.passwordHash) {
    return res.redirect(`/login?error=${encodeURIComponent('No account found with that email.')}&next=${encodeURIComponent(next)}`);
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return res.redirect(`/login?error=${encodeURIComponent('Incorrect password.')}&next=${encodeURIComponent(next)}`);
  }

  const token = sessionToken(user.id);
  const sessionExpires = Date.now() + 1000 * 60 * 60 * 24 * 30;
  user.sessionToken = token;
  user.sessionExpires = sessionExpires;
  userStore.save();

  res.cookie(COOKIE, token, cookieOptions(req));
  res.redirect(next);
});

const logout = (req, res) => {
  // Clear session from user store if cookie present
  const value = parseCookies(req.headers.cookie)[COOKIE];
  if (value) {
    const users = userStore.data || [];
    for (const user of users) {
      if (user.sessionToken === value) {
        delete user.sessionToken;
        delete user.sessionExpires;
      }
    }
    userStore.save();
  }
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
};

authRouter.get('/logout', logout);
authRouter.post('/logout', logout);