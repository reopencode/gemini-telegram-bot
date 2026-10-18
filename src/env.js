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

export function historyPath() {
  const raw = (process.env.HISTORY_PATH || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(ROOT, 'data', 'history.json');
}

function positiveInt(name, fallback, { max } = {}) {
  const n = Math.floor(Number(process.env[name]));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return max ? Math.min(n, max) : n;
}

/**
 * Chat history limits. Read on each call so a changed env value applies without a restart
 * of the test process; unset or invalid values fall back to the defaults below.
 */
export function historySettings() {
  return {
    maxChats: positiveInt('HISTORY_MAX_CHATS', 50),
    maxMessageChars: positiveInt('HISTORY_MAX_MESSAGE_CHARS', 20000),
    titleChars: positiveInt('HISTORY_TITLE_CHARS', 40),
    listLimit: positiveInt('HISTORY_LIST_LIMIT', 20),
    // Header + footer + page text must stay inside Telegram's 4096-character message limit.
    pageChars: positiveInt('HISTORY_PAGE_CHARS', 3600, { max: 3800 }),
  };
}

export function allowlistPath() {
  const raw = (process.env.ALLOWLIST_PATH || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(ROOT, 'data', 'allowlist.json');
}
