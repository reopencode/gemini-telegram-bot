import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leftoverBridgePids, stopLeftoverBridges } from '../src/bridgeProcess.js';

const ROOT = '/workspace/gemini-telegram-bot';

function writeProc(procRoot, pid, cmdline, cwd) {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), `${cmdline.trim().replace(/ /g, '\0')}\0`);
  if (cwd) fs.symlinkSync(cwd, path.join(dir, 'cwd'));
}

test('leftover bridge pids are uvicorn gemini_bridge on this port and tree', () => {
  const procs = [
    {
      pid: 10,
      cmdline: 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 8765',
      cwd: ROOT,
    },
    {
      pid: 11,
      cmdline: 'node src/index.js',
      cwd: ROOT,
    },
    {
      pid: 12,
      cmdline: 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 8765',
      cwd: '/other/project',
    },
    {
      pid: 13,
      cmdline: 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 87650',
      cwd: ROOT,
    },
    {
      pid: 14,
      cmdline: 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 9000',
      cwd: ROOT,
    },
  ];
  assert.deepEqual(leftoverBridgePids(procs, { root: ROOT, port: '8765' }), [10]);
});

test('SIGTERM then SIGKILL when the leftover bridge ignores SIGTERM', async () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-proc-'));
  const cmdline = 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 8765';
  writeProc(procRoot, 42, cmdline, ROOT);
  const signals = [];
  const result = await stopLeftoverBridges({
    procRoot,
    root: ROOT,
    port: '8765',
    graceMs: 0,
    signal(pid, sig) {
      signals.push([pid, sig]);
      if (sig === 'SIGKILL') fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(signals, [
    [42, 'SIGTERM'],
    [42, 'SIGKILL'],
  ]);
  assert.deepEqual(result.killed, [42]);
});

test('SIGKILL is skipped when SIGTERM reaps the leftover bridge', async () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-proc-'));
  const cmdline = 'python -m uvicorn gemini_bridge:app --host 127.0.0.1 --port 8765';
  writeProc(procRoot, 7, cmdline, ROOT);
  const signals = [];
  let slept = 0;
  const result = await stopLeftoverBridges({
    procRoot,
    root: ROOT,
    port: '8765',
    graceMs: 25,
    signal(pid, sig) {
      signals.push([pid, sig]);
      fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
    },
    sleep: async (ms) => {
      slept = ms;
    },
    log: () => {},
  });
  assert.deepEqual(signals, [[7, 'SIGTERM']]);
  assert.equal(slept, 25);
  assert.deepEqual(result.killed, []);
});

test('no leftover bridge means no signals', async () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-proc-'));
  writeProc(procRoot, 3, 'node src/index.js', ROOT);
  const signals = [];
  await stopLeftoverBridges({
    procRoot,
    root: ROOT,
    port: '8765',
    graceMs: 4000,
    signal(pid, sig) {
      signals.push([pid, sig]);
    },
    sleep: async () => {
      throw new Error('should not wait');
    },
    log: () => {},
  });
  assert.deepEqual(signals, []);
});
