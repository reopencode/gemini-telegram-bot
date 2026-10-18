/**
 * Find and stop leftover uvicorn gemini_bridge processes before a new one binds.
 * A bridge that ignored SIGTERM otherwise keeps the port and the next spawn
 * dies with "address already in use".
 */
import fs from 'node:fs';
import path from 'node:path';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isGeminiBridgeCommand(cmdline, port) {
  const cmd = String(cmdline || '');
  if (!cmd.includes('uvicorn') || !cmd.includes('gemini_bridge:app')) return false;
  const portText = String(port ?? '').trim();
  if (!portText) return false;
  const re = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${escapeRegExp(portText)}(?:\\s|$)`);
  return re.test(cmd);
}

/**
 * @param {{pid:number, cmdline?:string, cwd?:string}[]} processes
 * @param {{root?:string, port:string|number}} opts
 */
export function leftoverBridgePids(processes, { root, port } = {}) {
  const pids = [];
  for (const proc of processes || []) {
    if (!proc || proc.pid == null) continue;
    if (!isGeminiBridgeCommand(proc.cmdline, port)) continue;
    if (proc.cwd && root && proc.cwd !== root) continue;
    pids.push(Number(proc.pid));
  }
  return pids;
}

export function readProcTable(procRoot = '/proc') {
  let names = [];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const procs = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(procRoot, name);
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(path.join(dir, 'cmdline')).toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    let cwd = '';
    try {
      cwd = fs.readlinkSync(path.join(dir, 'cwd'));
    } catch {
      cwd = '';
    }
    procs.push({ pid: Number(name), cmdline, cwd });
  }
  return procs;
}

function defaultGraceMs() {
  const raw = process.env.BRIDGE_STOP_GRACE_MS;
  if (raw == null || String(raw).trim() === '') return 4000;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 4000;
}

/**
 * SIGTERM leftover bridges, then SIGKILL any that are still there after graceMs.
 */
export async function stopLeftoverBridges({
  procRoot = '/proc',
  root,
  port,
  graceMs = defaultGraceMs(),
  signal = (pid, sig) => process.kill(pid, sig),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (msg) => console.log(msg),
} = {}) {
  const match = () => leftoverBridgePids(readProcTable(procRoot), { root, port });
  const terminated = match();
  if (terminated.length === 0) return { terminated: [], killed: [] };
  for (const pid of terminated) {
    log(`[index] SIGTERM leftover gemini_bridge pid=${pid}`);
    try {
      signal(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await sleep(graceMs);
  const killed = [];
  for (const pid of match()) {
    log(`[index] SIGKILL leftover gemini_bridge pid=${pid}`);
    try {
      signal(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  return { terminated, killed };
}
