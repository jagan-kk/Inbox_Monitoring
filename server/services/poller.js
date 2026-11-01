import { getSettings } from '../store.js';
import { drainQueue, scan } from './pipeline.js';

let scanTimer = null;
let queueTimer = null;

export function startPoller() {
  stopPoller();
  const seconds = Math.max(15, Number(getSettings().pollSeconds) || 60);

  scanTimer = setInterval(async () => {
    try {
      await scan({ trigger: 'timer' });
    } catch (error) {
      console.error('[scan]', error.message);
    }
  }, seconds * 1000);

  // Held calls become eligible on their own schedule, not just on new mail.
  queueTimer = setInterval(() => {
    drainQueue().catch((error) => console.error('[queue]', error.message));
  }, 60_000);

  return seconds;
}

export function stopPoller() {
  if (scanTimer) clearInterval(scanTimer);
  if (queueTimer) clearInterval(queueTimer);
  scanTimer = null;
  queueTimer = null;
}

export function restartPoller() {
  return startPoller();
}
