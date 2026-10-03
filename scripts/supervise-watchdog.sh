#!/usr/bin/env bash
# Thin supervise wrapper: keep scripts/watchdog.sh alive across crashes.
# Prefer: nohup npm run watch >> /tmp/gemini-bot-watchdog.log 2>&1 &
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${WATCHDOG_LOG:-/tmp/gemini-bot-watchdog.log}"
SUP_PIDFILE="${WATCHDOG_SUPERVISE_PIDFILE:-/tmp/gemini-bot-supervise.pid}"
SUP_LOCK="${WATCHDOG_SUPERVISE_LOCK:-/tmp/gemini-bot-supervise.lock}"

exec 8>"$SUP_LOCK"
if ! flock -n 8; then
  echo "supervise-watchdog already running (lock=$SUP_LOCK)" >&2
  exit 0
fi

echo "$$" > "$SUP_PIDFILE"
delay=2
while true; do
  printf '%s [supervise] launching watchdog\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" >>"$LOG"
  t0=$(date +%s)
  bash "$ROOT/scripts/watchdog.sh" >>"$LOG" 2>&1
  rc=$?
  t1=$(date +%s)
  ran=$((t1 - t0))
  # Healthy long run → reset backoff; quick flock-exit → mild delay only
  if [ "$ran" -ge 20 ]; then
    delay=2
  fi
  printf '%s [supervise] watchdog exited rc=%s ran=%ss — restart in %ss\n' \
    "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$rc" "$ran" "$delay" >>"$LOG"
  sleep "$delay"
  if [ "$ran" -lt 20 ]; then
    delay=$(( delay < 60 ? delay * 2 : 60 ))
  fi
done
