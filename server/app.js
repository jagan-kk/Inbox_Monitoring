import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { ROOT, env } from './config.js';
import { api, baseUrl } from './api.js';
import { subscribe, broadcast } from './services/events.js';
import { storageMode } from './db.js';
import { flushStores, getState, loadStores, stateStore, userStore } from './store.js';
import { authMiddleware, authRouter, COOKIE, sessionToken, cookieOptions, safeNext, findUserByEmail } from './auth.js';
import { buildStatus, scan } from './services/pipeline.js';
import { connectedEmail, handleCallback } from './services/gmail.js';

const redirectUri = (req) => env.google.redirectUri || `${baseUrl(req)}/oauth2callback`;

export function createApp() {
  const app = express();
  const publicDir = path.join(ROOT, 'public');

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Serverless: every request starts from a fresh process, so state is read
  // from Redis before the handler runs and flushed explicitly after writes.
  app.use((req, res, next) => {
    if (storageMode !== 'redis') return next();
    const needsState = req.path.startsWith('/api') || req.path === '/' || req.path.endsWith('.html');
    if (!needsState) return next();
    loadStores()
      .catch((error) => console.error('[store]', error.message))
      .finally(() => next());
  });

  app.use(authRouter);
  app.use(authMiddleware());

  // --- Live events (SSE). Falls back to polling on serverless. --------------
  app.get('/api/events', (req, res) => {
    if (env.isServerless) {
      res.status(204).end();
      return;
    }
    subscribe(req, res);
  });

  app.use('/api', api);

  // --- Google OAuth callback ----------------------------------------------
  app.get('/oauth2callback', async (req, res) => {
    const { code, error, state, next } = req.query;
    if (error) return res.redirect(`/?error=${encodeURIComponent(String(error))}`);
    if (!code) return res.redirect('/?error=Missing+authorization+code');

    const isLogin = String(state || '').startsWith('login:');

    try {
      const tokens = await handleCallback(String(code), redirectUri(req));

      if (isLogin) {
        // Google login: find or create user account, then set session cookie.
        let user = findUserByEmail(tokens.email);
        if (!user) {
          const userId = crypto.randomBytes(16).toString('hex');
          user = {
            id: userId,
            email: tokens.email,
            passwordHash: null,
            googleAuth: true,
            createdAt: Date.now(),
          };
          const users = userStore.data || [];
          users.push(user);
          userStore.data = users;
          userStore.save();
        }

        const token = sessionToken(user.id);
        const sessionExpires = Date.now() + 1000 * 60 * 60 * 24 * 30;
        user.sessionToken = token;
        user.sessionExpires = sessionExpires;
        userStore.save();

        res.cookie(COOKIE, token, cookieOptions(req));
        return res.redirect(safeNext(next || '/'));
      }

      // Existing flow: connect Gmail for email monitoring.
      getState().gmailAccount = tokens.email || connectedEmail();
      stateStore.save();
      broadcast('gmail:connected', { email: getState().gmailAccount });
      broadcast('status', buildStatus());
      await flushStores();
      scan({ trigger: 'after-connect' }).catch((e) => console.error('[scan]', e.message));
      res.redirect('/?connected=1');
    } catch (err) {
      console.error('[oauth]', err.message);
      res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
  });

  // --- Static app ----------------------------------------------------------
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(publicDir, 'manifest.webmanifest'));
  });

  app.get('/sw.js', (req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(publicDir, 'sw.js'));
  });

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      maxAge: env.isServerless ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // Client-side routes fall back to the app shell.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('[http]', err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  });

  return app;
}
