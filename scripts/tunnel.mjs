import { spawn } from 'node:child_process';
import { httpListen, ROOT } from '../src/env.js';

const { port } = httpListen();
const child = spawn('npx', ['localtunnel', '--port', String(port)], {
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
console.log(`[tunnel] localtunnel → 127.0.0.1:${port}`);
