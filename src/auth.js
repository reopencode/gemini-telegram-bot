/**
 * Authorization for Telegram bot + Mini App.
 * Permanent admins come from the PERMANENT_ADMINS env var (always allowed, cannot be removed).
 * Allowlist persisted at ALLOWLIST_PATH (default data/allowlist.json); env can seed extras.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { allowlistPath } from './env.js';

const STORE_PATH = allowlistPath();

export const DENY_MESSAGE = "You're not on the allowlist. Ask the admin to add you.";

function parseList(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeUsername(u) {
  if (!u) return '';
  return String(u).trim().replace(/^@+/g, '').toLowerCase();
}

/** Usernames from the PERMANENT_ADMINS env var. Always allowed, and /deny cannot remove them. */
export function permanentAdmins() {
  return [...new Set(parseList(process.env.PERMANENT_ADMINS).map(normalizeUsername).filter(Boolean))];
}

/** True when the arg is a pure numeric Telegram user id (not a username). */
export function looksLikeUserId(raw) {
  const s = String(raw || '').trim().replace(/^@+/g, '');
  if (!/^\d{5,}$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && Number.isSafeInteger(n);
}

export function normalizeUserId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(n)) return null;
  return n;
}

function emptyStore() {
  return {
    version: 1,
    usernames: [...permanentAdmins()],
    userIds: {}, // { "123": "username" }
    updatedAt: null,
  };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const data = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    const usernames = new Set(
      [...(data.usernames || []), ...permanentAdmins()].map(normalizeUsername).filter(Boolean),
    );
    const userIds = {};
    if (data.userIds && typeof data.userIds === 'object') {
      for (const [k, v] of Object.entries(data.userIds)) {
        const id = normalizeUserId(k);
        if (id == null) continue;
        userIds[String(id)] = normalizeUsername(v) || '';
      }
    }
    return {
      version: 1,
      usernames: [...usernames],
      userIds,
      updatedAt: data.updatedAt || null,
    };
  } catch (e) {
    console.warn('[auth] loadStore failed, using empty store:', e.message || e);
    return emptyStore();
  }
}

function saveStore(data) {
  // Always keep permanent admins
  const usernames = new Set(
    [...(data.usernames || []), ...permanentAdmins()].map(normalizeUsername).filter(Boolean),
  );
  const userIds = {};
  for (const [k, v] of Object.entries(data.userIds || {})) {
    const id = normalizeUserId(k);
    if (id == null) continue;
    userIds[String(id)] = normalizeUsername(v) || '';
  }
  const out = {
    version: 1,
    usernames: [...usernames].sort(),
    userIds,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, STORE_PATH);
  return out;
}

/** Merge env seeds into store once (idempotent add). */
export function seedAllowlistFromEnv() {
  const store = loadStore();
  let changed = false;
  for (const u of parseList(process.env.ALLOWED_USERNAMES)) {
    const n = normalizeUsername(u);
    if (n && !store.usernames.includes(n)) {
      store.usernames.push(n);
      changed = true;
    }
  }
  for (const idRaw of parseList(process.env.ALLOWED_USER_IDS)) {
    const id = normalizeUserId(idRaw);
    if (id == null) continue;
    const key = String(id);
    if (!(key in store.userIds)) {
      store.userIds[key] = store.userIds[key] || '';
      changed = true;
    }
  }
  if (changed || !existsSync(STORE_PATH)) saveStore(store);
  return loadStore();
}

export function getAllowlist() {
  seedAllowlistFromEnv();
  return loadStore();
}

export function getAllowedUsernames() {
  return new Set(getAllowlist().usernames.map(normalizeUsername));
}

export function getAllowedUserIds() {
  const store = getAllowlist();
  const ids = new Set(
    Object.keys(store.userIds || {})
      .map((s) => normalizeUserId(s))
      .filter((n) => n != null),
  );
  // env ids always honored
  for (const idRaw of parseList(process.env.ALLOWED_USER_IDS)) {
    const n = normalizeUserId(idRaw);
    if (n != null) ids.add(n);
  }
  return ids;
}

export function isPermanentAdmin(usernameOrFrom) {
  const uname =
    typeof usernameOrFrom === 'string'
      ? normalizeUsername(usernameOrFrom)
      : normalizeUsername(usernameOrFrom?.username);
  return permanentAdmins().includes(uname);
}

export function isAdmin(from) {
  return isPermanentAdmin(from);
}

export function isTelegramUserAllowed(from) {
  if (!from) return false;
  const id = normalizeUserId(from.id);
  const uname = normalizeUsername(from.username);
  // Permanent admin always (even if store was wiped)
  if (uname && permanentAdmins().includes(uname)) return true;
  if (uname && getAllowedUsernames().has(uname)) return true;
  if (id != null && getAllowedUserIds().has(id)) return true;
  return false;
}

/** Persist numeric id when an allowlisted user sends a message / opens Mini App. */
export function rememberAuthorizedUser(from) {
  if (!from?.id) return;
  const id = normalizeUserId(from.id);
  if (id == null) return;
  if (!isTelegramUserAllowed(from)) return;
  const uname = normalizeUsername(from.username);
  const store = loadStore();
  const key = String(id);
  const next = uname || store.userIds[key] || '';
  if (store.userIds[key] !== next) {
    store.userIds[key] = next;
    saveStore(store);
  }
}

export function allowUsername(username) {
  const n = normalizeUsername(username);
  if (!n) return { ok: false, error: 'invalid username' };
  if (looksLikeUserId(n)) {
    return allowUserId(n);
  }
  const store = loadStore();
  if (store.usernames.includes(n)) return { ok: true, already: true, username: n, store };
  store.usernames.push(n);
  const saved = saveStore(store);
  return { ok: true, already: false, username: n, store: saved };
}

export function allowUserId(userId, username = '') {
  const id = normalizeUserId(userId);
  if (id == null) return { ok: false, error: 'invalid user id' };
  const store = loadStore();
  const key = String(id);
  const uname = normalizeUsername(username);
  const already = key in store.userIds;
  store.userIds[key] = uname || store.userIds[key] || '';
  if (uname && !store.usernames.includes(uname)) {
    store.usernames.push(uname);
  }
  const saved = saveStore(store);
  return { ok: true, already, userId: id, username: uname || null, store: saved };
}

export function denyUsername(username) {
  const n = normalizeUsername(username);
  if (!n) return { ok: false, error: 'invalid username' };
  if (looksLikeUserId(n)) {
    return denyUserId(n);
  }
  if (permanentAdmins().includes(n)) {
    return { ok: false, error: `cannot remove permanent admin @${n}` };
  }
  const store = loadStore();
  if (!store.usernames.includes(n)) return { ok: true, already: true, username: n, store };
  store.usernames = store.usernames.filter((u) => u !== n);
  // drop mapped ids for that username
  for (const [id, uname] of Object.entries(store.userIds || {})) {
    if (normalizeUsername(uname) === n) delete store.userIds[id];
  }
  const saved = saveStore(store);
  return { ok: true, already: false, username: n, store: saved };
}

export function denyUserId(userId) {
  const id = normalizeUserId(userId);
  if (id == null) return { ok: false, error: 'invalid user id' };
  const store = loadStore();
  const key = String(id);
  const mapped = normalizeUsername(store.userIds[key]);
  if (mapped && permanentAdmins().includes(mapped)) {
    return { ok: false, error: `cannot remove permanent admin @${mapped}` };
  }
  // Also block denying the known admin id if we know it
  if (mapped && permanentAdmins().includes(mapped)) {
    return { ok: false, error: `cannot remove permanent admin id ${id}` };
  }
  if (!(key in store.userIds)) {
    return { ok: true, already: true, userId: id, store };
  }
  delete store.userIds[key];
  const saved = saveStore(store);
  return { ok: true, already: false, userId: id, store: saved };
}

/**
 * Allow by username, numeric id, or a Telegram `from` / replied-to user object.
 */
export function allowTarget(raw, fromUser = null) {
  if (fromUser?.id) {
    const id = normalizeUserId(fromUser.id);
    const uname = normalizeUsername(fromUser.username);
    if (id != null) return allowUserId(id, uname);
    if (uname) return allowUsername(uname);
  }
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'provide a @username or numeric user id' };
  if (looksLikeUserId(s)) return allowUserId(s);
  return allowUsername(s);
}

export function denyTarget(raw, fromUser = null) {
  if (fromUser?.id) {
    const id = normalizeUserId(fromUser.id);
    const uname = normalizeUsername(fromUser.username);
    if (uname && permanentAdmins().includes(uname)) {
      return { ok: false, error: `cannot remove permanent admin @${uname}` };
    }
    if (id != null) {
      const byId = denyUserId(id);
      if (uname) denyUsername(uname);
      return byId;
    }
    if (uname) return denyUsername(uname);
  }
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'provide a @username or numeric user id' };
  if (looksLikeUserId(s)) return denyUserId(s);
  return denyUsername(s);
}

export function listAllowlist() {
  const store = getAllowlist();
  return {
    usernames: store.usernames,
    userIds: store.userIds,
    admins: [...permanentAdmins()],
    updatedAt: store.updatedAt,
  };
}

export function authSummary() {
  const list = listAllowlist();
  return {
    usernames: list.usernames,
    userIds: Object.keys(list.userIds).map(Number),
    admins: list.admins,
  };
}

/**
 * Validate Telegram Mini App initData (HMAC-SHA256).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Bot API 8.0+ adds a `signature` (Ed25519) field for third-party checks.
 * Telegram's bot-token `hash` is computed over all fields except `hash` and
 * `signature`. Validators that fold `signature` into the check-string reject
 * authentic payloads from modern clients.
 */
export function validateWebAppInitData(initData, botToken, { maxAgeSec = 86400 } = {}) {
  if (!initData || !botToken) {
    return { ok: false, error: 'missing initData or token' };
  }
  let params;
  try {
    params = new URLSearchParams(String(initData));
  } catch {
    return { ok: false, error: 'malformed initData' };
  }
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing hash' };

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();

  function buildPairs(excludeSignature) {
    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      if (excludeSignature && key === 'signature') continue;
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    return pairs.join('\n');
  }

  function hashMatches(dataCheckString) {
    const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    try {
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // Prefer Bot API 8+ (exclude signature). Fall back to legacy (include signature)
  // so older clients / docs that folded signature into the bot-token hash still work.
  const modern = buildPairs(true);
  const legacy = buildPairs(false);
  if (!hashMatches(modern) && !hashMatches(legacy)) {
    return { ok: false, error: 'invalid hash' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, error: 'missing auth_date' };
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > maxAgeSec || age < -60) {
    return { ok: false, error: 'initData expired' };
  }

  let user = null;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      return { ok: false, error: 'invalid user json' };
    }
  }

  if (!isTelegramUserAllowed(user)) {
    return { ok: false, error: 'user not allowlisted', user };
  }

  rememberAuthorizedUser(user);
  return { ok: true, user, authDate, isAdmin: isAdmin(user) };
}
