import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function bash(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-deep-'));
  const log = path.join(dir, 'watchdog.log');
  const script = `
set -uo pipefail
unset WATCHDOG_LOG_DUP
export WATCHDOG_SOURCE_ONLY=1
export WATCHDOG_LOG=${JSON.stringify(log).slice(1, -1)}
export BOT_LOG=${path.join(dir, 'bot.log')}
cd ${JSON.stringify(ROOT)}
# shellcheck disable=SC1091
source scripts/watchdog.sh
${body}
`;
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    stdout = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        WATCHDOG_SOURCE_ONLY: '1',
        WATCHDOG_LOG: log,
      },
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
  }
  return { status, stdout, stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('deep health classification treats only a live ok as success', () => {
  const { status, stdout, stderr } = bash(`
classify_deep_health '{"ok":true,"reason":"ok"}'
echo
classify_deep_health '{"ok":true,"reason":"unauthenticated","stale":false,"account":{"status":"UNAUTHENTICATED"}}'
echo
classify_deep_health '{"ok":false,"reason":"timeout"}'
echo
classify_deep_health ''
echo
classify_deep_health '{"ok":false,"reason":"probe_failed"}'
echo
`);
  assert.equal(status, 0, stderr + stdout);
  assert.equal(
    stdout,
    ['ok', 'unauthenticated', 'fail', 'fail', 'fail', ''].join('\n'),
  );
});

test('two consecutive deep failures restart once, then cooldown holds', () => {
  const { status, stdout, stderr } = bash(`
DEEP_FAILS=0
LAST_STALE_RESTART_AT=0
DEEP_FAILS_BEFORE_RESTART=2
STALE_RESTART_COOLDOWN_S=300
apply_deep_class fail 1000; echo
apply_deep_class fail 1000; echo
apply_deep_class fail 1100; echo
apply_deep_class fail 1100; echo
apply_deep_class fail 1400; echo
apply_deep_class unauthenticated 2000; echo
apply_deep_class fail 2000; echo
printf 'fails=%s last=%s\n' "$DEEP_FAILS" "$LAST_STALE_RESTART_AT"
`);
  assert.equal(status, 0, stderr + stdout);
  assert.equal(
    stdout,
    ['fail', 'restart', 'fail', 'cooldown', 'restart', 'unauthenticated', 'fail', 'fails=1 last=1400', ''].join('\n'),
  );
});

test('deep check runs every few minutes and does not restart on UNAUTHENTICATED', () => {
  const { status, stdout, stderr, log } = bash(`
DEEP_FAILS=0
LAST_DEEP_AT=0
LAST_STALE_RESTART_AT=0
DEEP_HEALTH_EVERY_S=180
DEEP_FAILS_BEFORE_RESTART=2
STALE_RESTART_COOLDOWN_S=300
RESTARTS=0
restart_after_stale() { RESTARTS=$((RESTARTS + 1)); }
is_port_up() { return 0; }
deep_health_body() { printf '%s' '{"ok":false,"reason":"timeout"}'; }
maybe_deep_health 10000
printf 'after1 fails=%s restarts=%s last=%s\n' "$DEEP_FAILS" "$RESTARTS" "$LAST_DEEP_AT"
maybe_deep_health 10100
printf 'after2 fails=%s restarts=%s last=%s\n' "$DEEP_FAILS" "$RESTARTS" "$LAST_DEEP_AT"
maybe_deep_health 10200
printf 'after3 fails=%s restarts=%s\n' "$DEEP_FAILS" "$RESTARTS"
deep_health_body() { printf '%s' '{"ok":true,"reason":"unauthenticated","account":{"status":"UNAUTHENTICATED"}}'; }
LAST_DEEP_AT=0
maybe_deep_health 20000
printf 'after_unauth fails=%s restarts=%s\n' "$DEEP_FAILS" "$RESTARTS"
is_port_up() { return 1; }
LAST_DEEP_AT=0
DEEP_FAILS=0
maybe_deep_health 30000
printf 'port_down fails=%s last=%s\n' "$DEEP_FAILS" "$LAST_DEEP_AT"
`);
  assert.equal(status, 0, stderr + stdout);
  assert.match(stdout, /after1 fails=1 restarts=0 last=10000/);
  assert.match(stdout, /after2 fails=1 restarts=0 last=10000/);
  assert.match(stdout, /after3 fails=0 restarts=1/);
  assert.match(stdout, /after_unauth fails=0 restarts=1/);
  assert.match(stdout, /port_down fails=0 last=0/);
  assert.match(log, /not a stale-connection failure/);
  const unauth = log.split('\n').filter((line) => line.includes('UNAUTHENTICATED'));
  assert.ok(unauth.length >= 1, log);
  assert.ok(unauth.every((line) => !line.includes('restarting bot and bridge')), log);
});

test('stop escalates to SIGKILL and start kills a leftover bridge first', () => {
  const { status, stdout, stderr } = bash(`
STOP_GRACE_S=4
ALIVE="4242 5252"
bot_pids() { echo 4242; }
bridge_pids() { echo 5252; }
pid_alive() {
  case " $ALIVE " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}
kill() {
  local sig="TERM" pid=""
  if [ "$1" = "-KILL" ] || [ "$1" = "-9" ]; then
    sig="KILL"
    pid="$2"
  elif [ "$1" = "-TERM" ] || [ "$1" = "-15" ]; then
    sig="TERM"
    pid="$2"
  else
    pid="$1"
  fi
  printf 'kill %s %s\n' "$sig" "$pid"
  if [ "$sig" = "KILL" ]; then
    ALIVE="\${ALIVE//$pid/}"
  fi
}
sleep() { printf 'sleep %s\n' "$1"; }
stop_bot
printf '%s\n' '--- start ---'
ALIVE="5252"
bridge_pids() { echo 5252; }
bot_pids() { echo 777; }
launch_bot_process() { printf 'launch\n'; }
export TELEGRAM_BOT_TOKEN=dummy-token-for-test
start_bot "https://example.test"
`);
  assert.equal(status, 0, stderr + stdout);
  const lines = stdout.trim().split('\n');
  const stop = lines.slice(0, lines.indexOf('--- start ---'));
  assert.deepEqual(stop, [
    'kill TERM 4242',
    'kill TERM 5252',
    'sleep 4',
    'kill KILL 4242',
    'kill KILL 5252',
  ]);
  const start = lines.slice(lines.indexOf('--- start ---') + 1);
  const launchAt = start.indexOf('launch');
  assert.ok(launchAt > 0, stdout);
  assert.ok(start.slice(0, launchAt).some((line) => line.includes('kill TERM 5252')));
  assert.ok(start.slice(0, launchAt).some((line) => line.includes('kill KILL 5252')));
});
