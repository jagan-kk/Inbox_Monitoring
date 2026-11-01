import { createApp } from '../server/app.js';
import { loadStores } from '../server/store.js';
import { initPush } from '../server/services/push.js';

const app = createApp();

// Warm the shared pieces once per cold start. Each request still loads fresh
// state through the middleware in server/app.js.
let booted = null;
function boot() {
  booted = booted || Promise.allSettled([loadStores({ force: true }), initPush()]);
  return booted;
}

export default async function handler(req, res) {
  await boot();
  return app(req, res);
}
