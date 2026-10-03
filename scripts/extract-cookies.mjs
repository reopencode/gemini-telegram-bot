import { spawn } from 'node:child_process';
import path from 'node:path';
import { pythonBin, ROOT } from '../src/env.js';

const child = spawn(pythonBin(), [path.join(ROOT, 'scripts', 'extract_cookies.py')], {
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
