# Ricky

A private app that watches your Gmail and **calls your phone** — a real incoming-call screen, not a notification — whenever something important arrives. Ricky speaks a short, natural voice note when you answer.

```
Gmail (read-only)  ->  importance score  ->  voice note (MP3)
                   ->  Web Push "incoming call"  ->  your phone rings
                   ->  you answer  ->  Ricky talks
```

No Twilio, no phone numbers, no per-call charges.

- **Installable PWA** — add it to your home screen and it behaves like a native app.
- **WhatsApp-style call screen** — full-screen ring, Answer / Decline, call timer, transcript.
- **Free voice** — ElevenLabs free tier when available, with automatic fallback to Microsoft Edge neural voices (free, no account).
- **Free push** — standards-based Web Push with VAPID keys; no third-party messaging service.
- **Zero build step** — Node + Express and plain HTML/CSS/JS.

---

## 1. Run it locally

```powershell
cd C:\Users\USER\Documents\Ricky
npm install
Copy-Item .env.example .env    # if you do not already have one
npm start
```

Open <http://127.0.0.1:4173>.

Then, in the app:

1. **Setup → Connect Gmail** and approve read-only access.
2. **Setup → Enable calls** to subscribe this browser to push.
3. **Home → Test the call** to hear the whole flow.

> Tip: run `npm run vapid` once and paste the keys into `.env` if you want push
> subscriptions to survive a restart.

### Testing push on your phone without deploying

Push needs a public https origin. [ngrok](https://ngrok.com) is already installed:

```powershell
npm start
ngrok http 4173
```

Set `PUBLIC_BASE_URL` in `.env` to the `https://…ngrok-free.app` URL, restart,
then open that URL on your phone and enable calls. Remember to unset it when you
are done, and set `APP_PASSWORD` before sharing a tunnel URL.

---

## 2. How the call works

1. A scheduler calls `POST /api/scan` (or `/api/cron/scan?key=…`).
2. Every unread email from the look-back window is scored (VIP senders,
   keywords, deadlines, direct-to-you, attachments, newsletters and automated
   mail push the score down).
3. Above the threshold — and outside quiet hours, cooldown, and the hourly cap —
   Ricky builds a script, renders it to MP3, and stores it against the alert id.
4. A Web Push message with an **Answer** / **Decline** action is sent to every
   subscribed device. `public/sw.js` shows it as a persistent, vibrating
   notification.
5. Tapping **Answer** opens the app at `/?call=<id>&answer=1`, which opens the
   call screen and starts playback. Tapping **Decline** acknowledges the alert
   without opening anything.
6. Audio is served from `/api/audio/:id` with HTTP Range support so iOS can
   stream it. If audio is missing, the app falls back to the phone's built-in
   voice.

Calls held for quiet hours or pacing go into a queue and are retried later.

---

## 3. Deploy (free)

Both options below are free. Pick one.

### Option A — Render (easiest, long-running)

Render's free web service sleeps after ~15 minutes of inactivity, so the
in-process poller cannot be trusted. Combine it with a free cron ping.

1. Push this repository to GitHub.
2. Render → **New → Web Service** → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Add environment variables:
   `PUBLIC_BASE_URL`, `APP_PASSWORD`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `ELEVENLABS_API_KEY`, `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `SELF_POLL=0`.
4. Add a free cron (Render Cron Job, GitHub Actions, or
   [cron-job.org](https://cron-job.org)) hitting:

   ```
   https://your-app.onrender.com/api/cron/scan?key=YOUR_CRON_SECRET
   ```

   every 5–10 minutes. Render's free disk is ephemeral, so also connect
   Upstash Redis (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) to
   keep tokens, settings and call history across restarts.

`render.yaml` in the repo defines the service for Blueprint deploys.

### Option B — Vercel (serverless)

Vercel's filesystem is read-only, so **Upstash Redis (or Vercel KV) is
required**. Vercel Hobby cron runs only once per day, so use an external cron.

1. Import the repo into Vercel. The entry point is `api/index.js`.
2. Add the environment variables from `.env.example`, including
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `CRON_SECRET`, and
   `SELF_POLL=0`.
3. Point a free cron at `https://your-app.vercel.app/api/cron/scan?key=…`.
4. `vercel.json` rewrites every path to the API entry so the PWA and the JSON
   endpoints share one origin.

### Option C — Docker anywhere

```powershell
docker build -t ricky .
docker run -p 4173:4173 --env-file .env ricky
```

The container runs the normal long-lived server, so `SELF_POLL=1` works.

---

## 4. Google OAuth setup

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials
   → OAuth client ID → Web application**.
2. Enable the **Gmail API** for the project.
3. Add an authorised redirect URI:

   ```
   https://your-app.example.com/oauth2callback
   ```

   For local development also add `http://127.0.0.1:4173/oauth2callback`.
4. Copy the client ID and secret into `.env`.
5. In the app, **Setup → Connect Gmail**.

Scopes requested: `gmail.readonly` and `userinfo.email`. Ricky never sends,
deletes or modifies mail.

---

## 5. Configuration that matters

Everything is editable from **Settings** in the app.

| Setting | What it does |
| --- | --- |
| Call threshold | Score an email must reach to ring you (VIP senders always clear it). |
| VIP senders | Emails, `@domain`, `*@domain`, or names that always ring. |
| Never call about | Senders that are ignored entirely. |
| Extra keywords | Added to the built-in urgency list. |
| What Ricky says | Sender + subject, subject + one line, or subject + line + reason. |
| Quiet hours | Holds calls, retries later. VIPs can still ring if you want. |
| Gap between calls | Cooldown so two emails do not produce two back-to-back rings. |
| Max calls per hour | Hard cap on how often your phone can ring. |
| Look back | How far back each scan looks for unread mail. |

Server-side environment variables are documented in [`.env.example`](.env.example).

---

## 6. API

All routes are same-origin and protected by `APP_PASSWORD` when set.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness, storage mode, voice engine |
| GET | `/api/status` | Connection state, counters, setup checklist |
| POST | `/api/scan` | Scan the inbox now |
| ALL | `/api/cron/scan?key=…` | Scheduler hook (requires `CRON_SECRET`) |
| GET | `/api/emails` | Scored email list |
| POST | `/api/emails/:id/call` | Force a call about one email |
| GET | `/api/alerts` | Call log |
| GET | `/api/alerts/:id` | One call (used by the ring screen) |
| POST | `/api/alerts/:id/ack` | `seen` / `answered` / `declined` |
| POST | `/api/alerts/test` | Place a test call |
| GET | `/api/audio/:id` | The generated MP3 (Range supported) |
| POST | `/api/voice/preview` | Render arbitrary text with the current voice |
| GET | `/api/push/key` | VAPID public key |
| POST | `/api/push/subscribe` | Store a device subscription |
| POST | `/api/push/unsubscribe` | Remove a device |
| GET | `/api/auth/google/url` | Begin Google OAuth |
| GET | `/oauth2callback` | OAuth redirect target |
| GET | `/api/events` | Server-sent events (long-running hosts only) |

---

## 7. Project layout

```
server/
  config.js              env parsing, defaults, setup detection
  db.js                  Upstash Redis REST client (optional)
  store.js               JSON store: local files or Redis
  app.js                 Express assembly, OAuth callback, static app
  api.js                 JSON API
  auth.js                optional APP_PASSWORD gate
  index.js               long-running entry point
  services/
    gmail.js             OAuth + message fetching/parsing
    importance.js        scoring engine, quiet hours
    tts.js               script building, ElevenLabs + Edge synthesis
    audio.js             audio persistence (disk or Redis)
    push.js              VAPID keys, subscriptions, fan-out
    pipeline.js          deliver / scan / queue / status
    poller.js            in-process scheduler
    events.js            SSE broadcaster
public/
  index.html             the app shell
  styles.css             mobile-first UI + call screen
  app.js                 client logic and call state machine
  sw.js                  service worker: push -> ring, offline cache
  manifest.webmanifest   PWA metadata
  icons/                 generated app icons
api/index.js             Vercel serverless entry
tools/                   icon generator, VAPID generator, TTS smoke test
legacy-dashboard/        the original desktop dashboard (not served)
```

---

## 8. Tests

```powershell
npm test
```

Covers the importance engine, quiet hours, pacing gates, and script generation
(including the guarantee that URLs and email addresses never get spoken).

---

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| No ring on the phone | Enable calls in **Setup**. Check the browser's notification permission. On iPhone, install to the Home Screen first — Safari only allows push for installed PWAs (iOS 16.4+). |
| Notification arrives but no sound | Check Do Not Disturb and the browser's notification sound settings. Some Android skins mute web push unless the site is allowed to bypass DND. |
| "No phone subscribed yet" | Open **Setup → Enable calls** on the phone that should ring. |
| Calls stop after a restart | Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in the environment; otherwise keys are generated per fresh disk. |
| Settings vanish after a deploy | You are on Vercel or a host with an ephemeral disk. Connect Upstash Redis. |
| Gmail disconnects | Reconnect from Setup. Google can revoke refresh tokens when the OAuth consent screen is in "Testing" — publish it or add yourself as a test user. |
| Voice is missing | Check the call log note. ElevenLabs quota errors fall back to Edge voices automatically. |
| Calls never happen on Render free | Free services sleep. Add the external cron ping described above. |

---

## 10. Privacy

- One user: you. There is no multi-tenant account system.
- Ricky stores only what it needs: OAuth tokens, your settings, a capped list of
  scored emails (250), a capped call log (250), and call audio for 7 days.
- Nothing is sent to a third party except: the voice text to your chosen TTS
  engine, and the push payload to your browser's push service (which is
  end-to-end encrypted to the device).
- Set `APP_PASSWORD` and serve over https before making the app reachable from
  the internet.
