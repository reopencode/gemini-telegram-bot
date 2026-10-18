# Runtime notes

## Live (after cookie refresh)

- Bot: Telegram long-polling (keep the bot username out of the repo)
- Bridge account: **AVAILABLE** (authenticated)
- HTTPS: see `/tmp/gemini-bot-tunnel.url` (or `.webapp_url`)
- Photo upload verified via `/api/chat_upload` → `SAW_IMG`

## Auto-restart watchdog

Keeps **cloudflared** (`PORT`, default 8787) + **`npm start`** (node bot + uvicorn bridge) alive, syncs `WEBAPP_URL` when the quick-tunnel URL changes, and on bridge `UNAUTHENTICATED` best-effort refreshes cookies via `scripts/export_live_cookies.mjs` then restarts the bot. The watchdog loads `.env` the same way as `npm start` (existing environment variables win).

Every few minutes (`DEEP_HEALTH_EVERY_S`, default 180) it also calls `GET /health/deep` (curl timeout `DEEP_HEALTH_CURL_TIMEOUT`, default 20s). That probe is one quota RPC with a short timeout (`GEMINI_DEEP_HEALTH_TIMEOUT`, default 15s). Two consecutive failures or timeouts (`DEEP_FAILS_BEFORE_RESTART`, default 2) restart node and uvicorn: SIGTERM, then SIGKILL after `STOP_GRACE_S` (default 4s) if a process is still alive, then the usual start path brings both back. Restarts are limited to one per `STALE_RESTART_COOLDOWN_S` (default 300s). A deep-check result of `UNAUTHENTICATED` is not a failure; cookie refresh handles expired cookies. Before each start, leftover `uvicorn gemini_bridge` processes for this tree are killed so a bridge that ignored SIGTERM cannot keep port `GEMINI_BRIDGE_PORT`.

Logs: `/tmp/gemini-bot-watchdog.log`  
Bot logs: `/tmp/gemini-telegram-bot.log`  
Tunnel log: `/tmp/cloudflared-out.log`  
Tunnel URL state: `/tmp/gemini-bot-tunnel.url` (+ `.webapp_url`)

### Start

```bash
cd /workspace/gemini-telegram-bot
# TELEGRAM_BOT_TOKEN must already be in the environment (do not commit it)
nohup npm run watch >> /tmp/gemini-bot-watchdog.log 2>&1 &
# or directly:
# nohup bash scripts/supervise-watchdog.sh >> /tmp/gemini-bot-watchdog.log 2>&1 &
```

`npm run watchdog` runs a single flock-guarded loop (exits if another instance holds `/tmp/gemini-bot-watchdog.lock`).  
`npm run watch` wraps that loop in a supervise restart shell.

### Stop

```bash
# stop supervise + watchdog (does not kill bot/tunnel unless you want that)
kill "$(cat /tmp/gemini-bot-supervise.pid 2>/dev/null)" 2>/dev/null
kill "$(cat /tmp/gemini-bot-watchdog.pid 2>/dev/null)" 2>/dev/null
# optional — stop bot + tunnel too:
pkill -f '/workspace/gemini-telegram-bot.*watchdog' 2>/dev/null
# bot (node src/index.js in this project) + its uvicorn child:
#   kill the pid from: pgrep -af 'node src/index.js'
# tunnel:
#   pkill -f "cloudflared tunnel --url http://127.0.0.1:${PORT:-8787}"
```

### Status

```bash
curl -sS "${GEMINI_BRIDGE_URL:-http://127.0.0.1:8765}/health"
curl -sS -m "${DEEP_HEALTH_CURL_TIMEOUT:-20}" "${GEMINI_BRIDGE_URL:-http://127.0.0.1:8765}/health/deep"
pgrep -af 'cloudflared tunnel --url|node src/index.js|watchdog|supervise-watchdog'
cat /tmp/gemini-bot-tunnel.url
tail -40 /tmp/gemini-bot-watchdog.log
```

## Refresh cookies (when auth drifts to guest)

```bash
cd /workspace/gemini-telegram-bot
# Prefer while gemini.google.com/app is open & signed-in on a box Chrome fork:
npm run extract-cookies          # tries live CDP jar export first
# or:
npm run export-live-cookies      # /exec-daemon/node scripts/export_live_cookies.mjs
# then restart (or let the watchdog restart after detecting UNAUTHENTICATED):
export WEBAPP_URL="$(cat /tmp/gemini-bot-tunnel.url)"
npm start
```

Note: `chrome-cookie-seed.json` omits rotating `__Secure-1PSIDTS` by design → guest/UNAUTHENTICATED if used alone.
