/**
 * Per-session chat transcripts.
 *
 * Each session has one `active` chat (what Gemini is currently continuing) and a
 * list of `archived` chats. "New chat" archives the active one; archived chats are
 * read-only and are never sent back to Gemini.
 *
 * Persisted at HISTORY_PATH (default data/history.json). Lookup is always keyed by
 * session id, so a user can only see their own chats.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { historyPath, historySettings } from './env.js';

function load() {
  const file = historyPath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function save(data) {
  const file = historyPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function entry(data, sessionId) {
  const cur = data[sessionId];
  if (cur && typeof cur === 'object') {
    if (!Array.isArray(cur.archived)) cur.archived = [];
    return cur;
  }
  return { active: null, archived: [] };
}

function newId() {
  return randomBytes(4).toString('hex');
}

function clip(text) {
  const s = text == null ? '' : String(text);
  const { maxMessageChars } = historySettings();
  return s.length > maxMessageChars ? `${s.slice(0, maxMessageChars)}…` : s;
}

function makeTitle(messages) {
  const first = messages.find((m) => m.role === 'user' && m.text.trim());
  const text = (first ? first.text : messages[0]?.text || 'Chat').replace(/\s+/g, ' ').trim();
  const { titleChars } = historySettings();
  return text.length > titleChars ? `${text.slice(0, titleChars - 1)}…` : text || 'Chat';
}

/** Append one user/model exchange to the session's active chat. */
export function recordTurn(sessionId, userText, modelText, mediaTypes = []) {
  if (!sessionId) return;
  const media = (mediaTypes || []).filter(Boolean).map((t) => `[${t}]`).join(' ');
  const reply = [String(modelText || '').trim(), media].filter(Boolean).join('\n');
  const user = String(userText || '').trim();
  if (!user && !reply) return;
  const data = load();
  const cur = entry(data, sessionId);
  const now = Date.now();
  if (!cur.active) cur.active = { id: newId(), startedAt: now, messages: [] };
  if (user) cur.active.messages.push({ role: 'user', text: clip(user), ts: now });
  if (reply) cur.active.messages.push({ role: 'model', text: clip(reply), ts: now });
  data[sessionId] = cur;
  save(data);
}

/**
 * Move the active chat into the archive. Returns the archived summary,
 * or null when there was nothing to archive.
 */
export function archiveActive(sessionId) {
  if (!sessionId) return null;
  const data = load();
  const cur = entry(data, sessionId);
  const active = cur.active;
  if (!active || !active.messages?.length) return null;
  const archived = {
    id: active.id,
    title: makeTitle(active.messages),
    startedAt: active.startedAt,
    endedAt: Date.now(),
    messages: active.messages,
  };
  cur.archived.push(archived);
  const { maxChats } = historySettings();
  if (cur.archived.length > maxChats) cur.archived = cur.archived.slice(-maxChats);
  cur.active = null;
  data[sessionId] = cur;
  save(data);
  return summarize(archived);
}

function summarize(chat) {
  return {
    id: chat.id,
    title: chat.title,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    count: chat.messages.length,
  };
}

/** Archived chats for the session, newest first (no message bodies). */
export function listChats(sessionId) {
  if (!sessionId) return [];
  const cur = entry(load(), sessionId);
  return cur.archived.map(summarize).reverse();
}

/** One archived chat including messages, or null when it is not this session's. */
export function getChat(sessionId, chatId) {
  if (!sessionId || !chatId) return null;
  const cur = entry(load(), sessionId);
  return cur.archived.find((c) => c.id === String(chatId)) || null;
}

/** Plain-text transcript used by the bot to render a read-only view. */
export function formatTranscript(chat) {
  return (chat?.messages || [])
    .map((m) => `${m.role === 'user' ? 'You' : 'Gemini'}: ${m.text}`)
    .join('\n\n');
}
