import { spawn } from 'child_process';
import { bridgeSettings, pythonBin, ROOT } from './env.js';
import { startServer } from './server.js';
import { startBot } from './bot.js';
import { healthCheck } from './geminiClient.js';
import { stopLeftoverBridges } from './bridgeProcess.js';

/** @type {import('child_process').ChildProcess | null} */
let bridgeChild = null;
let bridgeRestarting = false;

async function spawnBridge() {
  if (process.env.SKIP_BRIDGE === '1') {
    console.log('[index] SKIP_BRIDGE=1 — expecting external bridge');
    return null;
  }
  const { host, port, url } = bridgeSettings();
  // An old uvicorn can ignore SIGTERM and keep the port. Kill it before bind.
  await stopLeftoverBridges({ root: ROOT, port });
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
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  child.on('exit', (code, signal) => {
    if (bridgeRestarting) {
      console.log(`[bridge] stopped for restart (code=${code} signal=${signal})`);
      return;
    }
    console.error(`[bridge] exited code=${code} signal=${signal}`);
  });
  bridgeChild = child;
  return child;
}

function startBridge() {
  return spawnBridge();
}

async function waitForBridge(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await healthCheck();
      // HTTP bridge is up; Gemini client may still be recovering from 429/auth
      if (h && (h.ok || h.cookies_present !== undefined)) {
        if (!h.client_ready) {
          console.warn('[index] bridge up but Gemini client not ready:', h.startup_error || h.account || h);
        }
        return h;
      }
      console.log('[index] bridge not ready yet', h.startup_error || h);
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Gemini bridge did not become ready in time');
}

/**
 * Safely restart only the Python/uvicorn gemini_bridge child spawned by this process.
 * Does not touch unrelated box processes.
 */
export async function restartBridge({ timeoutMs = 60000 } = {}) {
  if (process.env.SKIP_BRIDGE === '1') {
    throw new Error('Bridge is managed externally (SKIP_BRIDGE=1)');
  }
  if (bridgeRestarting) {
    throw new Error('Bridge restart already in progress');
  }
  bridgeRestarting = true;
  try {
    const old = bridgeChild;
    bridgeChild = null;
    if (old && old.exitCode == null && old.signalCode == null) {
      try {
        old.kill('SIGTERM');
      } catch (e) {
        console.warn('[index] bridge SIGTERM failed', e.message || e);
      }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            if (old.exitCode == null && old.signalCode == null) old.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 4000);
        old.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    // Brief pause so the port can release
    await new Promise((r) => setTimeout(r, 400));
    await spawnBridge();
    return await waitForBridge(timeoutMs);
  } finally {
    bridgeRestarting = false;
  }
}

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  const bridge = await startBridge();
  process.on('exit', () => {
    try {
      bridgeChild?.kill();
    } catch {
      /* ignore */
    }
  });
  process.on('SIGINT', () => {
    try {
      bridgeChild?.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  await waitForBridge();
  await startServer();
  await startBot({ restartBridge });
  console.log('[index] ready');
  if (!process.env.WEBAPP_URL) {
    console.log(
      '[index] WEBAPP_URL unset — bot text chat works; Mini App needs HTTPS tunnel (see README)',
    );
  }
  void bridge;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
