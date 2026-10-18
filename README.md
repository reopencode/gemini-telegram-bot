# Gemini Telegram Bot + Mini App

Personal Telegram bot and Mini App that proxies chat to your **signed-in Gemini web session** at [gemini.google.com](https://gemini.google.com/app) (cookie-based unofficial client — **not** Google AI Studio / Gemini API).

## What you get

| Path | Role |
|------|------|
| Telegram text chat | Send a message → reply from Gemini web |
| Mini App (`/app`) | Dark Gemini-like chat UI over WebSocket/HTTP |
| `gemini_bridge.py` | Python sidecar using [`gemini_webapi`](https://github.com/HanaokaYuzu/Gemini-API) |
| `scripts/extract_cookies.py` | Pull `__Secure-1PSID` (+ friends) from box cookie seed / profile |

## Requirements

- Node.js 18+
- Python 3.10+ (venv included under `.venv/`)
- `TELEGRAM_BOT_TOKEN` in the environment or `.env`
- Usable Google session cookies (see below)
- For Mini App: a public **HTTPS** URL (Telegram requirement)



## Authorization

Only allowlisted Telegram users can use the bot and Mini App.

- **Permanent admins:** `PERMANENT_ADMINS` (comma-separated usernames). Always allowed, and `/deny` cannot remove them.
- Persist file: `ALLOWLIST_PATH` (default `data/allowlist.json`; local only — copy `data/allowlist.example.json`; do not commit the real file)
- Env (optional seed / override extras):
  - `ALLOWED_USERNAMES=someone,other` (comma-separated)
  - `ALLOWED_USER_IDS=123,456` (numeric ids)

### Admin commands (permanent admins only)

| Command | Action |
|---------|--------|
| `/allowed` | List allowlist |
| `/allow <@username\|user_id>` | Add user (or reply to their message with `/allow`) |
| `/deny <@username\|user_id>` | Remove user (not admin; reply works too) |

Mini App: the admin sheet can allow/deny by `@username` or numeric user id. All Mini App Gemini APIs require validated `initData` HMAC (Bot API 8+ `signature` field is handled).

## Env vars

`npm start`, `npm run start:bridge`, and the watchdog read `.env` in the project root (copy `.env.example`). A variable already set in the process environment wins over `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token (never commit / never log) |
| `PERMANENT_ADMINS` | yes, for admin commands | Comma-separated Telegram usernames that cannot be removed |
| `WEBAPP_URL` | for Mini App | HTTPS origin serving `public/` (e.g. localtunnel URL) |
| `PORT` | no | HTTP server port (default `8787`) |
| `HOST` | no | HTTP bind address (default `0.0.0.0`) |
| `GEMINI_BRIDGE_URL` | no | Bridge base URL (default `http://127.0.0.1:8765`). Also the uvicorn bind when this process starts the bridge |
| `GEMINI_BRIDGE_HOST` | no | Override the host in `GEMINI_BRIDGE_URL` |
| `GEMINI_BRIDGE_PORT` | no | Override the port in `GEMINI_BRIDGE_URL` |
| `GEMINI_COOKIES_PATH` | no | Cookie JSON path (default `./.cookies.json`) |
| `GEMINI_PREFS_PATH` | no | Per-chat model/tool prefs (default `data/prefs.json`) |
| `GEMINI_COOKIES_JSON` | no | Alternate source path for `extract-cookies` |
| `GEMINI_COOKIE_SEED` | no | Plaintext cookie seed (default `/home/box/sand-data/chrome-cookie-seed.json`) |
| `CHROME_COOKIE_DBS` | no | `os.pathsep`-separated Chromium `Cookies` DBs to try decrypting |
| `ALLOWLIST_PATH` | no | Allowlist JSON (default `data/allowlist.json`) |
| `HISTORY_PATH` | no | Archived chat history JSON (default `data/history.json`; local only — gitignored) |
| `HISTORY_MAX_CHATS` | no | Archived chats kept per user; oldest are dropped (default `50`) |
| `HISTORY_MAX_MESSAGE_CHARS` | no | Max stored characters per message (default `20000`) |
| `HISTORY_TITLE_CHARS` | no | Max characters of a past chat's title (default `40`) |
| `HISTORY_LIST_LIMIT` | no | Past chats shown in the bot's History list (default `20`) |
| `HISTORY_PAGE_CHARS` | no | Transcript characters per bot page (default `3600`, capped at `3800` for Telegram's 4096 limit) |
| `PYTHON` | no | Python used to launch the bridge (default `.venv/bin/python`) |
| `EXEC_NODE` | no | Node binary for live cookie export (default `/exec-daemon/node`, else the current Node) |
| `GEMINI_WEBAPI_CACHE` | no | Cache dir cleared on cookie refresh (default `/tmp/gemini_webapi`) |
| `TUNNEL_HOST` | no | Host cloudflared forwards to (default `127.0.0.1`; port is `PORT`) |
| `SKIP_BRIDGE` | no | Set `1` if you start the Python bridge yourself |

## Setup

```bash
cd /workspace/gemini-telegram-bot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
cp .env.example .env      # then set TELEGRAM_BOT_TOKEN (and WEBAPP_URL when you have one)
npm run extract-cookies   # writes .cookies.json (mode 600)
```

### Cookies

**Important:** `chrome-cookie-seed.json` deliberately omits rotating cookies (`__Secure-1PSIDTS`, etc.).
For AVAILABLE (signed-in) gemini_webapi sessions, refresh from the live Chrome jar:

```bash
npm run export-live-cookies   # or: npm run extract-cookies (tries live export first)
# requires Gemini open/signed-in in a box Chrome fork; uses platform cdp-cookies jar read
```

### Cookies (sources)

Preferred on this box: plaintext export at `GEMINI_COOKIE_SEED` (default `/home/box/sand-data/chrome-cookie-seed.json`, used automatically).

Minimum cookie: `__Secure-1PSID` from `.google.com`. `__Secure-1PSIDTS` is optional but improves session stability.

Chromium `Cookies` SQLite on this box is encrypted; the Linux `peanuts` key does **not** decrypt it. Do **not** attach CDP/xdotool to the live desktop Chrome. Options:

1. Refresh `chrome-cookie-seed.json` / re-run `npm run extract-cookies`
2. Manually paste DevTools cookie values into `.cookies.json`
3. **Playwright bridge (documented):** launch a *dedicated* persistent context with a **copy** of the profile (not the live Fork-3 session), drive `https://gemini.google.com/app`, or dump cookies via that instance’s CDP and write `.cookies.json`

Example Playwright sketch (dedicated profile only):

```js
// scripts/playwright_gemini.mjs (outline — not required for MVP)
import { chromium } from 'playwright';
const context = await chromium.launchPersistentContext('./chrome-profile-gemini', {
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--password-store=basic'],
});
const page = await context.newPage();
await page.goto('https://gemini.google.com/app');
// …type prompt, read answer, or context.cookies() → .cookies.json
```

## Run

```bash
# Terminal A — HTTPS tunnel for Mini App (Telegram requires HTTPS)
# cloudflared quick tunnel (localtunnel often hangs on this box):
/tmp/cloudflared tunnel --url "http://127.0.0.1:${PORT:-8787}" --no-autoupdate
# → note the https://….trycloudflare.com URL

# Terminal B — full stack (bridge + HTTP + Telegram polling)
export TELEGRAM_BOT_TOKEN  # already set on the box
export WEBAPP_URL='https://YOUR-SUBDOMAIN.trycloudflare.com'
npm start
```

See also `RUN.md` for the live tunnel URL used during bootstrap.

In Telegram: `/start`, `/app`, or just type a message. `/new` resets the Gemini chat session. `/status` checks the bridge.

## Architecture

```
Telegram user ──► grammy bot ──► Node /api or bridge ──► gemini_webapi ──► gemini.google.com
Mini App UI   ──► WS /api/chat ─┘                         (session cookies)
```



## Models, tools, files

### Models
- Mini App: **Model** chip opens a bottom sheet of `list_models()` results.
- Telegram: `/model` inline keyboard. Choice is persisted per chat in `data/prefs.json` (local only; not committed).

### Tools
| Tool | Status |
|------|--------|
| Thinking (`extended_thinking`) | Supported via gemini_webapi flag, with a Low / Medium / High level (see below) |
| Deep Research (`deep_research`) | Supported via gemini_webapi flag (needs signed-in account) |
| Google Search / Code / Canvas | **Stub UI only** — library has no separate toggles |

### Thinking level

When **Thinking** is on you can pick **Low / Medium / High** (default **Medium**), stored per chat in `data/prefs.json` as `thinking_level`.

- Telegram: the `/tools` picker shows a level row under Thinking, or use `/thinking`. Active chips and `/status` show e.g. `Thinking · Medium`.
- Mini App: **Tools** sheet shows a Low / Medium / High control under Thinking; the chip shows the level.
- `gemini_webapi` only has an on/off `extended_thinking` flag, so the level is best-effort prompt steering on top of it: Low asks for brief reasoning, Medium is the plain flag (no extra prompt), High asks for step-by-step reasoning with a double-check. Create Image / Video / Music steering takes priority over the level prefix. With Thinking off, the level is kept but ignored.

Telegram: `/tools` (full picker). **Sticky chips**: active tools appear as inline buttons under the “Active tools” status message and under bot replies; tap `×` to turn one off. Prefs stay on until deselected. Mini App: **Tools** sheet + chip row above the composer.


### Create Image / Video / Music

Toggle in Mini App **Tools** or Telegram `/tools`:

| Tool | How it works |
|------|----------------|
| **Create Image** | Prompt is steered to `GENERATE an image…`. gemini_webapi returns `GeneratedImage`; file saved under `public/media/` and sent via Telegram `sendPhoto` / shown in Mini App. |
| **Create Video** | Prompt is steered toward a short video. The mp4 is deleted and is not sent to Telegram or shown in the Mini App. The reply is exactly `Your video is ready!`. If Gemini returns text and no video, that text is shown as usual. |
| **Create Music** | Steers toward audio; uses `GeneratedMedia` / `mp3_url` when Gemini returns music. |

There is **no separate official toggle API** in gemini_webapi — this mirrors Android “Create …” by prompt steering + parsing returned media.


### Pictures & files
- Telegram: send a photo or document (optional caption).
- Mini App: **+** attach, multi-file, drag/drop → `POST /api/chat_upload` → bridge `files=` upload.
- Text-like files (`.txt`, `.md`, `.py`, …) are also inlined into the prompt as a fallback when the session is not fully authenticated.
- Image upload requires Gemini account status **AVAILABLE** (fresh signed-in cookies). Guest/unauth sessions can still do text chat (often Flash-Lite only).

## Limitations / warnings

- **Unofficial**: reverse‑engineered web client; breaks when Google changes endpoints.
- **ToS**: may violate Google / Gemini web terms; personal experimentation only.
- **Fragility**: cookies expire; re-extract when `/status` or replies fail.
- **No CDP on live desktop**: keep automation off the interactive agent Chrome (Fork-3).
- **Mini App HTTPS**: plain `http://` on the box is not enough for Telegram WebApps.
- **Quota / abuse**: uses your consumer Gemini account quotas.

## Project layout

```
gemini-telegram-bot/
  src/env.js            # loads .env and resolves host/port/path settings
  src/index.js          # starts bridge + server + bot
  src/bot.js            # Telegram (grammy)
  src/server.js         # Express + WebSocket Mini App API
  src/geminiClient.js   # HTTP client → Python bridge
  src/history.js        # archived (read-only) chat transcripts
  gemini_bridge.py      # FastAPI + gemini_webapi
  envfile.py            # .env loader for Python (does not override existing vars)
  scripts/extract_cookies.py
  public/               # Mini App UI
  .cookies.json         # secrets — gitignored
  requirements.txt
  package.json
```
