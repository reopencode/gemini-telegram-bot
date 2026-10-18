/**
 * "New chat" archives the finished conversation. Archived chats are listed and
 * readable per user, and never reach Gemini again.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
const historyFile = path.join(tmpDir, 'history.json');
const BOT_TOKEN = '123456:TEST-TOKEN';
process.env.HISTORY_PATH = historyFile;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.ALLOWLIST_PATH = path.join(tmpDir, 'allowlist.json');
process.env.PERMANENT_ADMINS = 'u100,u200';

const bridgeHits = [];
let bridge;
let appServer;
let appUrl;
let history;
let client;
let bot;

function signedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, username: `u${userId}` }),
    query_id: 'AAA',
  });
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
  return params.toString();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

before(async () => {
  bridge = http.createServer(async (req, res) => {
    const body = await readBody(req);
    bridgeHits.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/chat')) {
      const { prompt, session_id: sessionId } = JSON.parse(body || '{}');
      res.end(JSON.stringify({ text: `echo: ${prompt}`, session_id: sessionId, media: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  process.env.GEMINI_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`;

  history = await import('../src/history.js');
  client = await import('../src/geminiClient.js');
  bot = await import('../src/bot.js');
  const { createApp } = await import('../src/server.js');
  appServer = http.createServer(createApp());
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  bridge?.close();
  appServer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(historyFile, { force: true });
  bridgeHits.length = 0;
});

describe('history store', () => {
  const MAX_CHATS = 5;
  before(() => { process.env.HISTORY_MAX_CHATS = String(MAX_CHATS); });
  after(() => { delete process.env.HISTORY_MAX_CHATS; });

  test('reset archives the active chat and starts empty', async () => {
    await client.chat('hello there', 'tg-1');
    await client.chat('second question', 'tg-1');
    assert.equal(history.listChats('tg-1').length, 0, 'active chat is not listed');

    await client.resetSession('tg-1');
    const chats = history.listChats('tg-1');
    assert.equal(chats.length, 1);
    assert.equal(chats[0].title, 'hello there');
    assert.equal(chats[0].count, 4);

    const chat = history.getChat('tg-1', chats[0].id);
    assert.deepEqual(
      chat.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'hello there'],
        ['model', 'echo: hello there'],
        ['user', 'second question'],
        ['model', 'echo: second question'],
      ],
    );
    assert.ok(bridgeHits.some((h) => h.url.startsWith('/reset')), 'bridge context is still cleared');
  });

  test('resetting an empty chat does not create an archive entry', async () => {
    await client.resetSession('tg-2');
    await client.chat('hi', 'tg-2');
    await client.resetSession('tg-2');
    await client.resetSession('tg-2');
    assert.equal(history.listChats('tg-2').length, 1);
  });

  test('chats are isolated per session', async () => {
    await client.chat('mine', 'tg-3');
    await client.resetSession('tg-3');
    const [mine] = history.listChats('tg-3');
    assert.equal(history.listChats('tg-4').length, 0);
    assert.equal(history.getChat('tg-4', mine.id), null);
    assert.equal(history.getChat('tg-3', mine.id).title, 'mine');
  });

  test('a turn is recorded once', async () => {
    await client.chat('only once', 'tg-5');
    await client.resetSession('tg-5');
    const [c] = history.listChats('tg-5');
    assert.equal(c.count, 2);
  });

  test('media becomes a placeholder and file names are noted', () => {
    history.recordTurn('tg-6', 'draw a cat\n[file: cat.png]', 'here you go', ['image']);
    history.archiveActive('tg-6');
    const [c] = history.listChats('tg-6');
    const chat = history.getChat('tg-6', c.id);
    assert.equal(chat.messages[0].text, 'draw a cat\n[file: cat.png]');
    assert.equal(chat.messages[1].text, 'here you go\n[image]');
  });

  test('archive is capped per session, keeping the newest', () => {
    for (let i = 0; i < MAX_CHATS + 3; i++) {
      history.recordTurn('tg-7', `q${i}`, 'a');
      history.archiveActive('tg-7');
    }
    const chats = history.listChats('tg-7');
    assert.equal(chats.length, MAX_CHATS);
    assert.equal(chats[0].title, `q${MAX_CHATS + 2}`);
  });
});

describe('history env settings', () => {
  const keys = ['HISTORY_TITLE_CHARS', 'HISTORY_MAX_MESSAGE_CHARS', 'HISTORY_PAGE_CHARS', 'HISTORY_LIST_LIMIT'];
  after(() => { for (const k of keys) delete process.env[k]; });

  test('defaults apply when unset or invalid', async () => {
    const { historySettings } = await import('../src/env.js');
    for (const k of keys) delete process.env[k];
    delete process.env.HISTORY_MAX_CHATS;
    assert.deepEqual(historySettings(), {
      maxChats: 50, maxMessageChars: 20000, titleChars: 40, listLimit: 20, pageChars: 3600,
    });
    process.env.HISTORY_LIST_LIMIT = 'abc';
    process.env.HISTORY_TITLE_CHARS = '-3';
    assert.equal(historySettings().listLimit, 20);
    assert.equal(historySettings().titleChars, 40);
    process.env.HISTORY_PAGE_CHARS = '99999';
    assert.equal(historySettings().pageChars, 3800, 'page size is capped below the Telegram limit');
  });

  test('title and message length follow env', () => {
    process.env.HISTORY_TITLE_CHARS = '10';
    process.env.HISTORY_MAX_MESSAGE_CHARS = '20';
    history.recordTurn('tg-8', 'a very long first question indeed', 'b'.repeat(50));
    history.archiveActive('tg-8');
    const [c] = history.listChats('tg-8');
    assert.equal(c.title.length, 10);
    const chat = history.getChat('tg-8', c.id);
    assert.equal(chat.messages[0].text.length, 21);
    assert.equal(chat.messages[1].text, `${'b'.repeat(20)}…`);
  });
});

describe('bot transcript pages', () => {
  test('page size follows HISTORY_PAGE_CHARS', () => {
    process.env.HISTORY_PAGE_CHARS = '100';
    try {
      const chat = { messages: [{ role: 'user', text: 'word '.repeat(100) }] };
      const pages = bot.paginateTranscript(chat);
      assert.ok(pages.length > 3);
      for (const p of pages) assert.ok(p.length <= 100);
    } finally {
      delete process.env.HISTORY_PAGE_CHARS;
    }
  });

  test('pages stay within Telegram limits even with header and footer', () => {
    const long = 'x'.repeat(1500);
    const chat = {
      messages: Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 ? 'model' : 'user',
        text: `${i} ${long}`,
      })),
    };
    const pages = bot.paginateTranscript(chat);
    assert.ok(pages.length > 1);
    for (const p of pages) assert.ok(p.length + 200 < 4096, `page too long: ${p.length}`);
    assert.equal(bot.paginateTranscript({ messages: [] }).length, 1);
  });
});

describe('mini app history endpoints', () => {
  async function get(pathname, userId) {
    const headers = userId ? { 'X-Telegram-Init-Data': signedInitData(userId) } : {};
    const res = await fetch(`${appUrl}${pathname}`, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  test('requires auth', async () => {
    assert.equal((await get('/api/history')).status, 401);
    assert.equal((await get('/api/history/abc')).status, 401);
  });

  test('returns only the caller\'s chats', async () => {
    await client.chat('alice secret', 'mini-100');
    await client.resetSession('mini-100');

    const alice = await get('/api/history', 100);
    assert.equal(alice.status, 200);
    assert.equal(alice.body.chats.length, 1);
    const id = alice.body.chats[0].id;

    const opened = await get(`/api/history/${id}`, 100);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.chat.messages[0].text, 'alice secret');

    const bob = await get('/api/history', 200);
    assert.deepEqual(bob.body.chats, []);
    assert.equal((await get(`/api/history/${id}`, 200)).status, 404);
  });
});
