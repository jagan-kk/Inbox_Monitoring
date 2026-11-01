/* Ricky service worker — receives the "incoming call" push and opens the app. */

const VERSION = 'ricky-v3';
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic: calls, alerts and audio must always be fresh.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth2callback')) return;

  // Navigations: network first so a new deploy shows up, cache as offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('/', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached || Response.error()))
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});

/* --------------------------------------------------------------- push call --- */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Ricky is calling', body: event.data ? event.data.text() : 'Something important landed.' };
  }

  const alertId = payload.alertId || payload.callId || null;
  const title = payload.title || 'Ricky is calling';
  const body = payload.body || 'You have an important email.';

  const target = alertId ? `/?call=${encodeURIComponent(alertId)}` : payload.url || '/';

  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    image: undefined,
    tag: payload.tag || (alertId ? `ricky-${alertId}` : 'ricky-call'),
    renotify: payload.renotify !== false,
    requireInteraction: payload.requireInteraction !== false,
    silent: false,
    timestamp: payload.timestamp || Date.now(),
    vibrate: payload.vibrate || [400, 200, 400, 200, 900],
    data: { url: target, alertId, receivedAt: Date.now() },
    actions: [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' },
    ],
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);

      // If the app is already open and visible, ask it to ring in-page too.
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.visibilityState === 'visible') {
          client.postMessage({ type: 'open-call', alertId });
        }
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  const data = event.notification.data || {};
  const alertId = data.alertId;
  const target = data.url || '/';

  event.notification.close();

  const ack = async (status) => {
    if (!alertId || alertId === 'test') return;
    try {
      await fetch(`/api/alerts/${encodeURIComponent(alertId)}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: status }),
      });
    } catch {
      // Offline is fine; the app will reconcile on next open.
    }
  };

  if (action === 'decline') {
    event.waitUntil(ack('declined'));
    return;
  }

  const withAnswer = action === 'answer';
  const url = withAnswer ? `${target}${target.includes('?') ? '&' : '?'}answer=1` : target;

  event.waitUntil(
    (async () => {
      if (withAnswer) await ack('seen');
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      for (const client of clientList) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'open-call', alertId, answer: withAnswer });
          return;
        }
      }

      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});

self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  if (!data.alertId || data.alertId === 'test') return;
  event.waitUntil(
    fetch(`/api/alerts/${encodeURIComponent(data.alertId)}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'seen' }),
    }).catch(() => undefined)
  );
});

/* ------------------------------------------------------------- push events --- */

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldEndpoint = event.oldSubscription?.endpoint;
        const subscription = await self.registration.pushManager.subscribe(
          event.oldSubscription?.options || { userVisibleOnly: true }
        );
        if (oldEndpoint) {
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: oldEndpoint }),
          }).catch(() => undefined);
        }
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
      } catch {
        // The app re-subscribes next time it is opened.
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});
