/**
 * Load project-root `.env` once, then resolve runtime settings.
 * Variables already set in the process environment are left unchanged.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

export const ROOT = root;

export function bridgeSettings() {
  const raw = (process.env.GEMINI_BRIDGE_URL || 'http://127.0.0.1:8765').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = new URL('http://127.0.0.1:8765');
  }
  const host = (process.env.GEMINI_BRIDGE_HOST || parsed.hostname || '127.0.0.1').trim();
  let port = (process.env.GEMINI_BRIDGE_PORT || parsed.port || '').trim();
  if (!port) port = parsed.protocol === 'https:' ? '443' : '8765';
  parsed.hostname = host;
  parsed.port = port;
  const url = parsed.toString().replace(/\/+$/, '');
  return { url, host, port };
}

export function httpListen() {
  const host = (process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  const port = Number(process.env.PORT || 8787);
  return { host, port: Number.isFinite(port) && port > 0 ? port : 8787 };
}

export function pythonBin() {
  return process.env.PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
}

export function execNode() {
  return process.env.EXEC_NODE || '/exec-daemon/node';
}

export function geminiWebapiCache() {
  return process.env.GEMINI_WEBAPI_CACHE || '/tmp/gemini_webapi';
}

export function allowlistPath() {
  const raw = (process.env.ALLOWLIST_PATH || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(ROOT, 'data', 'allowlist.json');
}
