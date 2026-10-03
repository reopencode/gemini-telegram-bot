/**
 * Admin helper: export live Gemini cookies from Chrome, clear gemini_webapi cache.
 * Spawns scripts/export_live_cookies.mjs via EXEC_NODE (needs WebSocket).
 * Never returns cookie values — only safe status strings.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execNode, geminiWebapiCache, ROOT } from './env.js';

const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'export_live_cookies.mjs');
const EXEC_NODE = execNode();
const CACHE_DIR = geminiWebapiCache();

/** Strip anything that looks like a secret from script stderr/stdout for Telegram. */
function sanitizeLine(line) {
  let s = String(line || '').replace(/\r/g, '').trim();
  if (!s) return '';
  // Drop lines that might contain cookie payload JSON / values
  if (/^\s*[{[]/.test(s)) return '';
  if (/__Secure-\w+\s*[:=]\s*\S{8,}/.test(s)) return '';
  if (/\b(SID|HSID|SSID|APISID|SAPISID|NID|SIDCC|COMPASS|LSID|OTZ)\s*[:=]\s*\S{8,}/.test(s)) {
    return '';
  }
  // Truncate long blobs
  if (s.length > 220) s = `${s.slice(0, 200)}…`;
  return s;
}

function summarizeExportOutput(stdout, stderr, code) {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined
    .split('\n')
    .map(sanitizeLine)
    .filter(Boolean);

  const hasGeminiTab = /gemini_tab=true/i.test(combined) || /geminiTab=true/i.test(combined);
  const hasPsidths = /1PSIDTS=true|__Secure-1PSIDTS=true|Has __Secure-1PSID=true.*1PSIDTS=true/i.test(
    combined,
  );
  const wrote = /Wrote .*\.cookies\.json/i.test(combined);
  const noChrome =
    /Could not find __Secure-1PSID/i.test(combined) ||
    /WebSocket missing/i.test(combined) ||
    /no such file|ENOENT|connect.*failed|ECONNREFUSED/i.test(combined);
  const noPorts =
    lines.every((l) => /port \d+ failed/i.test(l)) && !wrote && code !== 0;

  if (code === 0 && (wrote || hasPsidths)) {
    const bits = ['cookies refreshed'];
    if (hasGeminiTab) bits.push('gemini tab seen');
    else bits.push('no gemini tab (jar used anyway)');
    if (hasPsidths) bits.push('1PSIDTS present');
    return { ok: true, reason: bits.join(' · '), detail: lines.slice(-4).join(' | ') };
  }

  let reason = 'export failed';
  if (/WebSocket missing/i.test(combined)) {
    reason = `failed: need ${EXEC_NODE} (WebSocket missing)`;
  } else if (noChrome || /Could not find __Secure-1PSID/i.test(combined)) {
    reason = 'failed: no Chrome jar with Gemini cookies (open gemini.google.com signed-in)';
  } else if (noPorts) {
    reason = 'failed: no reachable Chrome debug ports';
  } else {
    const last = lines.filter((l) => /failed|error|Could not/i.test(l)).slice(-1)[0];
    if (last) reason = `failed: ${last.slice(0, 160)}`;
  }
  return { ok: false, reason, detail: lines.slice(-6).join(' | ') };
}

/**
 * Run cookie export script from project root.
 * @returns {Promise<{ok:boolean, reason:string, detail?:string, clearedCache:boolean}>}
 */
export function exportLiveCookies({ timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(EXPORT_SCRIPT)) {
      resolve({
        ok: false,
        reason: 'failed: export script missing',
        clearedCache: false,
      });
      return;
    }
    const nodeBin = existsSync(EXEC_NODE) ? EXEC_NODE : process.execPath;
    const child = spawn(nodeBin, [EXPORT_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxCap = 64 * 1024;
    child.stdout.on('data', (d) => {
      if (stdout.length < maxCap) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxCap) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        reason: 'failed: cookie export timed out',
        clearedCache: false,
      });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: `failed: could not start export (${String(e.message || e).slice(0, 120)})`,
        clearedCache: false,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const summary = summarizeExportOutput(stdout, stderr, code ?? 1);
      resolve({ ...summary, clearedCache: false });
    });
  });
}

/** Remove gemini_webapi on-disk cache if present (safe; no secrets logged). */
export function clearGeminiWebapiCache() {
  try {
    if (existsSync(CACHE_DIR)) {
      rmSync(CACHE_DIR, { recursive: true, force: true });
      return true;
    }
  } catch (e) {
    console.warn('[refreshCookies] cache clear failed', e.message || e);
  }
  return false;
}

/**
 * Full admin flow: export cookies → clear cache → (caller restarts bridge).
 * Does not restart the bridge itself — call restartBridge() after.
 */
export async function refreshGeminiCookies() {
  const exportResult = await exportLiveCookies();
  // Only wipe cache after a successful write so a failed export doesn't
  // discard a still-usable gemini_webapi session cache.
  const clearedCache = exportResult.ok ? clearGeminiWebapiCache() : false;
  return {
    ok: exportResult.ok,
    reason: exportResult.reason,
    clearedCache,
    detail: exportResult.detail,
  };
}
