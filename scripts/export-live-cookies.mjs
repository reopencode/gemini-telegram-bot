import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execNode, ROOT } from '../src/env.js';

const script = path.join(ROOT, 'scripts', 'export_live_cookies.mjs');
const configured = execNode();
const nodeBin = existsSync(configured) ? configured : process.execPath;
const child = spawn(nodeBin, [script], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
});
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
