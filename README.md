# Ricky

A private voice-alert app. Ricky watches your Gmail, scores every new email, and **calls your phone** with a short, natural voice note when something actually matters.

```
Gmail (read-only)  ->  importance score  ->  ElevenLabs voice note  ->  phone call
```

- Dashboard on `http://127.0.0.1:4173` (local only by default)
- Voice notes generated with the ElevenLabs text-to-speech API
- Calls delivered either by a private ElevenLabs **agent** (native Twilio import) or by Twilio playing the generated MP3
- Runs in **simulation mode** without phone credentials, so you can hear every alert before wiring up a line
- Zero build step: Node + Express, plain HTML/CSS/JS

---

## 1. Quick start

```powershell
cd C:\Users\USER\Documents\Ricky
copy .env.example .env
npm install
npm start
```

Open <http://127.0.0.1:4173>. Without any keys the app starts in simulation mode: the dashboard works, but voice generation needs an ElevenLabs key.

Test suite:

```powershell
npm test
```

---

## 2. Connect Gmail (5 minutes)

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library → Gmail API → Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Add your own Google account under **Test users**
   - Scopes: `https://www.googleapis.com/auth/gmail.readonly` and `.../auth/userinfo.email`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://127.0.0.1:4173/oauth2callback`
5. Copy the client ID and secret into `.env`:

```env
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:4173/oauth2callback
```

6. Restart `npm start`, then click **Connect Gmail** in the banner (or **Setup → Connect Gmail**).

Ricky only requests **read-only** Gmail access. It never marks mail read, deletes, or sends anything.

---

## 3. Add the voice (ElevenLabs)

1. Create an API key at <https://elevenlabs.io/app/settings/api-keys>.
2. Pick a voice in the voice library (or clone your own) and copy its **voice ID**.
3. Put them in `.env`:

```env
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

4. Restart, open **Settings → Voice**, hit **Refresh voices**, and use **Preview voice**.

Every alert is deliberately short — sender and subject, nothing more:

> Hi Sam, this is Ricky. You just got an important email from Dana Reed about Q4 contract renewal. That is all. Talk soon.

If you want more context, **Settings → What the voice says** offers two longer styles: a one-line preview, or the preview plus why it was flagged. The email body is still read locally to score importance — it just isn't spoken aloud.

---

## 4. Make the phone ring

Pick **one** of the two paths.

### Option A - private ElevenLabs agent (recommended)

ElevenLabs agents can place real outbound calls through a Twilio number you import into ElevenLabs.

1. In ElevenLabs → **Agents**, create a private agent.
2. Open **Setup → Private voice agent** in Ricky and copy the ready-made prompt into the agent's system prompt. It uses these dynamic variables:
   `email_sender`, `email_subject`, `email_summary`, `email_reason`, `email_score`, `owner_name`.
3. In the agent's **Phone** tab, import your Twilio number and copy the **agent ID** and **phone number ID**.
4. Fill in `.env`:

```env
ELEVENLABS_AGENT_ID=agent_...
ELEVENLABS_AGENT_PHONE_NUMBER_ID=phnum_...
```

Ricky then calls `destinationNumber` with `POST /v1/convai/twilio/outbound-call`, passing the email details as conversation dynamic variables.

### Option B - Twilio plays Ricky's MP3

1. Buy/verify a number in Twilio and copy the Account SID + Auth Token.
2. Twilio must be able to download the generated MP3, so expose Ricky over HTTPS:

```powershell
ngrok http 4173
```

3. `.env`:

```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15550100
PUBLIC_BASE_URL=https://your-tunnel.ngrok.app
```

4. In **Settings**, set your phone number in E.164 form (`+15550102030`) and choose **Twilio + generated MP3**.

When Ricky calls, Twilio requests `/twiml/:callId`, which returns `<Play>` pointing at the ElevenLabs audio.

---

## 5. How "important" is decided

Scoring is local and explainable - no email content is sent to an LLM.

| Signal | Points |
| --- | --- |
| VIP sender (email, `@domain`, `*@domain`, or name) | +45 |
| Urgency language ("urgent", "action required", "deadline", ...) | +11 to +45 |
| Your custom keywords | +10 to +24 |
| Addressed directly to you | +10 |
| Attachment | +6 |
| Gmail `IMPORTANT` label / starred | +8 |
| Arrived in the last 30 minutes | +5 |
| Newsletter / `List-Unsubscribe` | -35 |
| No-reply / automated sender | -10 |
| Sender on your ignore list | score forced to 0 |

Anything at or above the **threshold** (default 60) triggers a call, subject to pacing:

- **Cooldown** between calls (default 5 min)
- **Max calls per hour** (default 6)
- **Quiet hours** - calls are held and retried later; VIPs can still ring through
- **Auto-call** can be switched off entirely

Every score, every point, and every skipped call is visible in the Inbox tab with its reason.

---

## 6. Project layout

```
Ricky/
  server/
    index.js              express app, OAuth callback, TwiML, SSE
    api.js                JSON API
    config.js             env + default settings
    store.js              atomic JSON persistence (data/)
    services/
      gmail.js            OAuth + Gmail REST + MIME parsing
      importance.js       scoring, reasons, quiet hours
      elevenlabs.js       TTS, outbound agent calls, voices
      telephony.js        provider selection, Twilio calls
      pipeline.js         scan -> score -> call -> queue
      poller.js           timers
      events.js           server-sent events
    tests/
  public/                 dashboard (no build step)
  data/                   settings, tokens, state, audio (gitignored)
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | connection + stats + settings |
| POST | `/api/scan` | scan now |
| GET | `/api/emails` | scored emails |
| POST | `/api/emails/:id/call` | call about one email |
| GET | `/api/calls` | call log |
| POST | `/api/test-call` | end-to-end test |
| GET/PUT | `/api/settings` | read/update settings |
| POST | `/api/voice/preview` | generate a sample MP3 |
| GET | `/api/voices` | ElevenLabs voices |
| GET | `/api/auth/google/url` | OAuth URL |
| POST | `/api/gmail/disconnect` | forget tokens |
| GET | `/api/events` | SSE stream |
| GET | `/twiml/:callId` | TwiML for Twilio |
| GET | `/audio/*.mp3` | generated voice notes |

---

## 7. Security notes

- The server binds to `127.0.0.1` by default. Change `HOST` only if you understand the exposure; there is no login screen.
- Google refresh tokens and settings live in `data/` and are gitignored.
- Twilio can only fetch audio while your tunnel is running. Use a reserved ngrok domain for a stable URL.
- Generated MP3s are deleted after 7 days.
- Keep `data/` and `.env` out of version control (already in `.gitignore`).

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Gmail is not connected" | Check `.env`, restart, then reconnect. Redirect URI must match exactly. |
| `redirect_uri_mismatch` | Add `http://127.0.0.1:4173/oauth2callback` to the OAuth client. |
| `ElevenLabs TTS failed (401)` | Bad/expired API key, or the key lacks text-to-speech permission. |
| Test call says "simulation" | Provider is `simulate` or no phone number is set. |
| Twilio call connects but is silent | `PUBLIC_BASE_URL` is not public HTTPS, so Twilio cannot fetch the MP3. |
| No calls even for important mail | Check the cooldown / hourly limit / quiet hours chips in the Inbox list. |
| First scan called nothing | By design: on the first scan Ricky ignores unread mail older than 10 minutes. |

---

Built for one inbox, one phone, and no noise.
