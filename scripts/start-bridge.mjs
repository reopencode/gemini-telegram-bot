import { spawn } from 'node:child_process';
import { bridgeSettings, pythonBin, ROOT } from '../src/env.js';

const { host, port, url } = bridgeSettings();
const child = spawn(
  pythonBin(),
  ['-m', 'uvicorn', 'gemini_bridge:app', '--host', host, '--port', String(port)],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_BRIDGE_URL: url,
      GEMINI_BRIDGE_HOST: host,
      GEMINI_BRIDGE_PORT: String(port),
    },
    stdio: 'inherit',
  },
);
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
