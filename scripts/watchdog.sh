#!/usr/bin/env bash
# Durable auto-restart watcher for gemini-telegram-bot.
# Keeps cloudflared (→$PORT) + npm start (node+uvicorn) alive, refreshes
# Gemini cookies on UNAUTHENTICATED (best-effort), and syncs WEBAPP_URL.
# Does not print secrets. Single-instance via flock.
# Loads project-root .env without overriding variables already in the environment.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load_dotenv() {
  local file="$ROOT/.env"
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
    esac
    case "$line" in
      export\ *) line="${line#export }" ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    case "$key" in
      *[!A-Za-z0-9_]*) continue ;;
    esac
    if [ -n "${!key+x}" ]; then
      continue
    fi
    if [ "${#val}" -ge 2 ]; then
      local first="${val:0:1}" last="${val: -1}"
      if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then
        val="${val:1}"
        val="${val%?}"
      fi
    fi
    export "$key=$val"
  done < "$file"
}

load_dotenv

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
TUNNEL_HOST="${TUNNEL_HOST:-127.0.0.1}"
TUNNEL_URL="http://${TUNNEL_HOST}:${PORT}"

_bridge_url="${GEMINI_BRIDGE_URL:-http://127.0.0.1:8765}"
_bridge_url="${_bridge_url%/}"
case "$_bridge_url" in
  *://*) ;;
  *) _bridge_url="http://${_bridge_url}" ;;
esac
_bridge_scheme="${_bridge_url%%://*}"
_bridge_rest="${_bridge_url#*://}"
_bridge_hostport="${_bridge_rest%%/*}"
_bridge_host="${_bridge_hostport%%:*}"
_bridge_port="${_bridge_hostport##*:}"
case "$_bridge_hostport" in
  *:*) ;;
  *)
    if [ "$_bridge_scheme" = "https" ]; then
      _bridge_port="443"
    else
      _bridge_port="8765"
    fi
    ;;
esac
GEMINI_BRIDGE_HOST="${GEMINI_BRIDGE_HOST:-${_bridge_host:-127.0.0.1}}"
GEMINI_BRIDGE_PORT="${GEMINI_BRIDGE_PORT:-${_bridge_port:-8765}}"
GEMINI_BRIDGE_URL="${_bridge_scheme}://${GEMINI_BRIDGE_HOST}:${GEMINI_BRIDGE_PORT}"
EXEC_NODE="${EXEC_NODE:-/exec-daemon/node}"
if [ ! -x "$EXEC_NODE" ]; then
  EXEC_NODE="$(command -v node || echo node)"
fi
export PORT HOST TUNNEL_HOST TUNNEL_URL GEMINI_BRIDGE_HOST GEMINI_BRIDGE_PORT GEMINI_BRIDGE_URL EXEC_NODE

LOG="${WATCHDOG_LOG:-/tmp/gemini-bot-watchdog.log}"
BOT_LOG="${BOT_LOG:-/tmp/gemini-telegram-bot.log}"
CF_BIN="${CF_BIN:-/tmp/cloudflared}"
CF_LOG="${CF_LOG:-/tmp/cloudflared-out.log}"
STATE_URL="${STATE_URL:-/tmp/gemini-bot-tunnel.url}"
WEBAPP_FILE="${WEBAPP_FILE:-$ROOT/.webapp_url}"
LOCK="${WATCHDOG_LOCK:-/tmp/gemini-bot-watchdog.lock}"
PIDFILE="${WATCHDOG_PIDFILE:-/tmp/gemini-bot-watchdog.pid}"
INTERVAL="${WATCHDOG_INTERVAL:-30}"
COOKIE_COOLDOWN_S="${COOKIE_COOLDOWN_S:-300}"
CF_URL_RE='https://[a-z0-9-]+\.trycloudflare\.com'
LAST_COOKIE_AT=0
LAST_BOT_WEBAPP=""
LOOP_N=0
HEARTBEAT_EVERY="${HEARTBEAT_EVERY:-2}"  # log every N intervals when healthy

log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  # Append to LOG; if stdout is already redirected to LOG (nohup), skip duplicate
  if [ -n "${WATCHDOG_LOG_DUP:-}" ]; then
    printf '%s [watchdog] %s\n' "$ts" "$*" | tee -a "$LOG"
  else
    printf '%s [watchdog] %s\n' "$ts" "$*" >>"$LOG"
  fi
}

# --- process helpers -------------------------------------------------------

bot_pids() {
  local pid cwd
  for pid in $(pgrep -f '[n]ode src/index\.js' 2>/dev/null || true); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ "$cwd" = "$ROOT" ]; then
      echo "$pid"
    fi
  done
}

tunnel_pids() {
  local pat
  pat="$(printf '%s' "$TUNNEL_URL" | sed 's/\./\\./g')"
  pgrep -f "[c]loudflared tunnel --url ${pat}" 2>/dev/null || true
}

is_port_up() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -qE ":${port}\\s"
  else
    curl -sS -m 1 -o /dev/null "http://127.0.0.1:${port}/" 2>/dev/null
  fi
}

# --- cloudflared -----------------------------------------------------------

ensure_cloudflared_bin() {
  if [ -x "$CF_BIN" ]; then
    return 0
  fi
  if [ -x "$ROOT/bin/cloudflared" ]; then
    log "copying cloudflared from $ROOT/bin/cloudflared → $CF_BIN"
    cp -f "$ROOT/bin/cloudflared" "$CF_BIN"
    chmod +x "$CF_BIN"
    return 0
  fi
  local arch url tmp
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
    aarch64|arm64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
    *) log "ERROR: unsupported arch $arch for cloudflared download"; return 1 ;;
  esac
  tmp="$(mktemp)"
  log "downloading cloudflared from GitHub releases ($arch)"
  if curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
    chmod +x "$tmp"
    mv -f "$tmp" "$CF_BIN"
    log "cloudflared installed at $CF_BIN"
  else
    rm -f "$tmp"
    log "ERROR: cloudflared download failed"
    return 1
  fi
}

read_tunnel_url() {
  local url=""
  if [ -f "$CF_LOG" ]; then
    url="$(grep -Eo "$CF_URL_RE" "$CF_LOG" 2>/dev/null | tail -1 || true)"
  fi
  if [ -z "$url" ] && [ -f "$STATE_URL" ]; then
    url="$(tr -d '[:space:]' < "$STATE_URL" || true)"
  fi
  if [ -z "$url" ] && [ -f "$WEBAPP_FILE" ]; then
    url="$(sed -n 's/^WEBAPP_URL=//p' "$WEBAPP_FILE" | head -1 | tr -d '[:space:]')"
  fi
  printf '%s' "$url"
}

write_tunnel_url() {
  local url="$1"
  [ -n "$url" ] || return 1
  printf '%s\n' "$url" > "$STATE_URL"
  printf 'WEBAPP_URL=%s\n' "$url" > "$WEBAPP_FILE"
  chmod 644 "$STATE_URL" "$WEBAPP_FILE" 2>/dev/null || true
}

wait_for_tunnel_url() {
  local i url=""
  for i in $(seq 1 40); do
    url="$(grep -Eo "$CF_URL_RE" "$CF_LOG" 2>/dev/null | tail -1 || true)"
    if [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

ensure_tunnel() {
  ensure_cloudflared_bin || return 1
  local pids url
  pids="$(tunnel_pids | tr '\n' ' ')"
  if [ -n "$(echo "$pids" | tr -d '[:space:]')" ]; then
    url="$(read_tunnel_url)"
    if [ -n "$url" ]; then
      write_tunnel_url "$url"
      return 0
    fi
    log "tunnel process up but URL unknown yet; waiting"
    url="$(wait_for_tunnel_url || true)"
    if [ -n "$url" ]; then
      write_tunnel_url "$url"
      log "tunnel URL recovered: $url"
    fi
    return 0
  fi

  log "starting cloudflared quick tunnel → ${TUNNEL_URL}"
  : > "$CF_LOG"
  nohup "$CF_BIN" tunnel --url "$TUNNEL_URL" --no-autoupdate >>"$CF_LOG" 2>&1 &
  disown || true
  sleep 1
  if [ -z "$(tunnel_pids)" ]; then
    log "ERROR: cloudflared failed to start (see $CF_LOG)"
    return 1
  fi
  url="$(wait_for_tunnel_url || true)"
  if [ -n "$url" ]; then
    write_tunnel_url "$url"
    log "tunnel up: $url"
  else
    log "WARN: tunnel started but URL not parsed yet"
  fi
}

# --- bot -------------------------------------------------------------------

stop_bot() {
  local pid child
  for pid in $(bot_pids); do
    log "stopping bot pid=$pid"
    # Kill process group-ish: node and its uvicorn child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      kill "$child" 2>/dev/null || true
    done
    kill "$pid" 2>/dev/null || true
  done
  # Wait briefly, then SIGKILL stragglers
  sleep 2
  for pid in $(bot_pids); do
    log "force-killing bot pid=$pid"
    kill -9 "$pid" 2>/dev/null || true
  done
  # Also clear orphan bridge on GEMINI_BRIDGE_PORT if our bot died uncleanly
  local br
  for br in $(pgrep -f '[u]vicorn gemini_bridge:app' 2>/dev/null || true); do
    local bcwd
    bcwd="$(readlink "/proc/$br/cwd" 2>/dev/null || true)"
    if [ "$bcwd" = "$ROOT" ]; then
      # Only kill if no parent bot remains
      if [ -z "$(bot_pids)" ]; then
        log "stopping orphan bridge pid=$br"
        kill "$br" 2>/dev/null || true
        sleep 1
        kill -9 "$br" 2>/dev/null || true
      fi
    fi
  done
}

start_bot() {
  local url="$1"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    log "ERROR: TELEGRAM_BOT_TOKEN unset — cannot start bot"
    return 1
  fi
  if [ -z "$url" ]; then
    log "WARN: WEBAPP_URL empty — starting bot anyway (text chat ok, Mini App needs tunnel)"
  fi
  log "starting npm start (WEBAPP_URL set=$([ -n "$url" ] && echo yes || echo no))"
  (
    cd "$ROOT" || exit 1
    # Export only what we need; never echo the token
    export WEBAPP_URL="$url"
    export TELEGRAM_BOT_TOKEN
    export PORT HOST
    export GEMINI_BRIDGE_URL GEMINI_BRIDGE_HOST GEMINI_BRIDGE_PORT
    export GEMINI_COOKIES_PATH="${GEMINI_COOKIES_PATH:-.cookies.json}"
    export EXEC_NODE
    export PYTHON="${PYTHON:-.venv/bin/python}"
    nohup npm start >>"$BOT_LOG" 2>&1 &
    disown || true
  )
  LAST_BOT_WEBAPP="$url"
  # Give it a moment to claim getUpdates
  sleep 3
  if [ -z "$(bot_pids)" ]; then
    log "ERROR: bot did not stay up (see $BOT_LOG)"
    return 1
  fi
  log "bot started pids=$(bot_pids | tr '\n' ' ')"
}

ensure_bot() {
  local url want_restart=0
  url="$(read_tunnel_url)"
  local pids
  pids="$(bot_pids | tr '\n' ' ')"

  if [ -z "$(echo "$pids" | tr -d '[:space:]')" ]; then
    start_bot "$url" || return 1
    return 0
  fi

  # Already running — only restart if tunnel URL changed and bot has stale WEBAPP_URL
  if [ -n "$url" ]; then
    local running_url=""
    local pid
    pid="$(bot_pids | head -1)"
    if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
      running_url="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^WEBAPP_URL=//p' | head -1)"
    fi
    if [ -n "$running_url" ] && [ "$running_url" != "$url" ]; then
      log "WEBAPP_URL drift (tunnel changed) — restarting bot to sync Mini App URL"
      want_restart=1
    fi
  fi

  if [ "$want_restart" = 1 ]; then
    stop_bot
    sleep 1
    start_bot "$url" || return 1
  fi
}

# --- health / cookies ------------------------------------------------------

health_json() {
  curl -fsS -m 5 "${GEMINI_BRIDGE_URL}/health" 2>/dev/null || true
}

account_status() {
  local h="$1"
  # Prefer python for reliable JSON; fall back to grep
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$h" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  a=d.get("account") or {}
  print(a.get("status") or ("AVAILABLE" if a.get("authenticated") else "UNKNOWN"))
except Exception:
  print("UNKNOWN")
' 2>/dev/null || echo "UNKNOWN"
  else
    if echo "$h" | grep -q 'UNAUTHENTICATED'; then
      echo "UNAUTHENTICATED"
    elif echo "$h" | grep -q '"authenticated":\s*true\|AVAILABLE'; then
      echo "AVAILABLE"
    else
      echo "UNKNOWN"
    fi
  fi
}

try_cookie_refresh() {
  local now
  now="$(date +%s)"
  if [ $((now - LAST_COOKIE_AT)) -lt "$COOKIE_COOLDOWN_S" ]; then
    log "cookie refresh skipped (cooldown ${COOKIE_COOLDOWN_S}s)"
    return 1
  fi
  LAST_COOKIE_AT=$now
  log "UNAUTHENTICATED — attempting live cookie export"
  local out rc=0
  out="$(cd "$ROOT" && "$EXEC_NODE" scripts/export_live_cookies.mjs 2>&1)" || rc=$?
  # Log non-secret lines only (script already avoids values)
  printf '%s\n' "$out" | while IFS= read -r line; do
    log "cookie-export: $line"
  done
  if [ "$rc" -ne 0 ]; then
    log "cookie export failed (rc=$rc) — no Chrome/gemini cookies? will keep polling"
    return 1
  fi
  log "cookie export ok — restarting bot/bridge"
  local url
  url="$(read_tunnel_url)"
  stop_bot
  sleep 1
  start_bot "$url" || return 1
  return 0
}

check_health_and_auth() {
  if ! is_port_up "$GEMINI_BRIDGE_PORT"; then
    # Bridge may still be starting after bot spawn
    if [ -n "$(bot_pids)" ]; then
      log "bridge port ${GEMINI_BRIDGE_PORT} not up yet (bot present)"
    else
      log "bridge down and bot missing"
    fi
    return 0
  fi
  local h st
  h="$(health_json)"
  if [ -z "$h" ]; then
    log "health check empty/failed"
    return 0
  fi
  st="$(account_status "$h")"
  case "$st" in
    AVAILABLE)
      # quiet success — log occasionally would be noisy; only on first or after issues
      :
      ;;
    UNAUTHENTICATED)
      log "health account status=UNAUTHENTICATED"
      try_cookie_refresh || true
      ;;
    *)
      log "health account status=$st"
      ;;
  esac
}

# Print resolved settings and exit. For tests; does not start processes.
if [ "${WATCHDOG_CONFIG_ONLY:-}" = 1 ]; then
  printf 'PORT=%s\nHOST=%s\nTUNNEL_URL=%s\nGEMINI_BRIDGE_URL=%s\nGEMINI_BRIDGE_HOST=%s\nGEMINI_BRIDGE_PORT=%s\n' \
    "$PORT" "$HOST" "$TUNNEL_URL" "$GEMINI_BRIDGE_URL" "$GEMINI_BRIDGE_HOST" "$GEMINI_BRIDGE_PORT"
  exit 0
fi

# --- main loop -------------------------------------------------------------

main_loop() {
  trap 'log "signal — exiting"; jobs -p | xargs -r kill 2>/dev/null; exit 0' TERM INT
  log "starting (root=$ROOT interval=${INTERVAL}s port=${PORT} bridge=${GEMINI_BRIDGE_URL})"
  echo "$$" > "$PIDFILE"
  while true; do
    ensure_tunnel || true
    ensure_bot || true
    check_health_and_auth || true
    LOOP_N=$((LOOP_N + 1))
    if [ $((LOOP_N % HEARTBEAT_EVERY)) -eq 0 ]; then
      local hb_url hb_bot hb_tun hb_st
      hb_url="$(read_tunnel_url)"
      hb_bot="$(bot_pids | tr '\n' ' ')"
      hb_tun="$(tunnel_pids | tr '\n' ' ')"
      hb_st="$(account_status "$(health_json)")"
      log "heartbeat tunnel=up($([ -n "$(echo "$hb_tun" | tr -d '[:space:]')" ] && echo yes || echo no)) bot=up($([ -n "$(echo "$hb_bot" | tr -d '[:space:]')" ] && echo yes || echo no)) account=$hb_st url=${hb_url:-none}"
    fi
    sleep "$INTERVAL" &
    wait $! || true
  done
}

# flock single-instance (retry briefly — avoids supervise race after SIGTERM)
exec 9>"$LOCK"
got_lock=0
for _try in 1 2 3 4 5; do
  if flock -n 9; then
    got_lock=1
    break
  fi
  other="$(cat "$PIDFILE" 2>/dev/null || echo '?')"
  if [ -n "$other" ] && [ "$other" != '?' ] && [ -d "/proc/$other" ]; then
    echo "watchdog already running (pid=$other lock=$LOCK)" >&2
    exit 0
  fi
  sleep 1
done
if [ "$got_lock" != 1 ]; then
  other="$(cat "$PIDFILE" 2>/dev/null || echo '?')"
  echo "watchdog lock busy (pidfile=$other lock=$LOCK) — giving up" >&2
  exit 0
fi

main_loop
