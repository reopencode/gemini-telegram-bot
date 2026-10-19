/**
 * Telegram text replies stream through POST /chat_stream.
 * If the stream fails before any text, the bot falls back to one-shot /chat.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(root, 'data', 'allowlist.json');
const allowlistExisted = fs.existsSync(allowlistPath);
const allowlistBackup = allowlistExisted ? fs.readFileSync(allowlistPath, 'utf8') : null;
process.env.PERMANENT_ADMINS = 'tester';
process.env.HISTORY_PATH = path.join(os.tmpdir(), `telegram-stream-history-${process.pid}.json`);

const state = {
  mode: 'stream-ok',
  prefs: {
    model: 'gemini-flash',
    tools: { extended_thinking: true },
  },
};
const bridgeHits = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function ndjson(obj) {
  return `${JSON.stringify(obj)}\n`;
}

let server;
let createBot;
let splitTelegramText;
let chatStream;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    bridgeHits.push({ method: req.method, path: url.pathname, body });

    if (url.pathname === '/prefs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session_id: url.searchParams.get('session_id'), prefs: state.prefs }));
      return;
    }
    if (url.pathname === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ id: 'gemini-flash', display_name: 'Flash', available: true }] }));
      return;
    }
    if (url.pathname === '/reset') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/chat' && req.method === 'POST') {
      if (state.mode === 'both-fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'chat down' }));
        return;
      }
      const prompt = JSON.parse(body || '{}').prompt;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        text: `one-shot:${prompt}`,
        session_id: 'tg-424242',
        model: 'gemini-flash',
        tools: state.prefs.tools,
        media: [],
      }));
      return;
    }
    if (url.pathname === '/chat_stream' && req.method === 'POST') {
      if (state.mode === 'http-error' || state.mode === 'both-fail') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'stream unavailable' }));
        return;
      }
      if (state.mode === 'socket-reset') {
        res.destroy();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      });
      if (state.mode === 'error-before-text') {
        res.end(ndjson({ type: 'error', detail: 'no tokens', started: false }));
        return;
      }
      if (state.mode === 'error-after-partial') {
        res.write(ndjson({ type: 'partial', text: 'partial answer' }));
        res.end(ndjson({ type: 'error', detail: 'cut off', started: true }));
        return;
      }
      if (state.mode === 'media') {
        res.write(ndjson({ type: 'partial', text: 'Here is the picture' }));
        await delay(40);
        res.end(ndjson({
          type: 'final',
          text: 'Here is the picture',
          session_id: 'tg-424242',
          model: 'gemini-flash',
          tools: state.prefs.tools,
          media: [{
            type: 'image',
            filename: 'a.png',
            url: '/media/a.png',
            path: state.mediaPath,
            title: '',
            mime: 'image/png',
          }],
        }));
        return;
      }
      if (state.mode === 'long') {
        res.end(ndjson({
          type: 'final',
          text: state.longText,
          session_id: 'tg-424242',
          model: null,
          tools: {},
          media: [],
        }));
        return;
      }
      if (state.mode === 'identical') {
        res.write(ndjson({ type: 'partial', text: 'Hello' }));
        await delay(1200);
        res.write(ndjson({ type: 'partial', text: 'Hello' }));
        await delay(1200);
        res.end(ndjson({
          type: 'final',
          text: 'Hello',
          session_id: 'tg-424242',
          model: null,
          tools: {},
          media: [],
        }));
        return;
      }
      // Grow while the reply is still open, then send the full answer.
      res.write(ndjson({ type: 'partial', text: 'Hel' }));
      await delay(200);
      res.write(ndjson({ type: 'partial', text: 'Hello' }));
      await delay(20);
      res.end(ndjson({
        type: 'final',
        text: 'Hello there',
        session_id: 'tg-424242',
        model: 'gemini-flash',
        tools: state.prefs.tools,
        media: [],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  process.env.GEMINI_BRIDGE_URL = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_BOT_TOKEN = '123456:TEST';
  delete process.env.WEBAPP_URL;
  ({ createBot, splitTelegramText } = await import('../src/bot.js'));
  ({ chatStream } = await import('../src/geminiClient.js'));
});

after(async () => {
  if (allowlistBackup != null) fs.writeFileSync(allowlistPath, allowlistBackup);
  else fs.rmSync(allowlistPath, { force: true });
  if (server) await new Promise((resolve) => server.close(resolve));
});

function mockApi(bot) {
  const calls = [];
  let nextId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    const entry = {
      method,
      text: payload?.text,
      caption: payload?.caption,
      message_id: payload?.message_id,
    };
    calls.push(entry);
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
      nextId += 1;
      entry.message_id = nextId;
      return {
        ok: true,
        result: {
          message_id: nextId,
          date: 1,
          chat: { id: payload.chat_id, type: 'private' },
          text: payload.text,
        },
      };
    }
    if (method === 'editMessageText') {
      return {
        ok: true,
        result: {
          message_id: payload.message_id,
          date: 1,
          chat: { id: payload.chat_id, type: 'private' },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });
  return calls;
}

function update(text, id = 1, messageExtra = {}) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 424242, type: 'private' },
      from: { id: 424242, is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
      ...messageExtra,
    },
  };
}

async function send(bot, text, id, messageExtra = {}) {
  bridgeHits.length = 0;
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'Gemini',
    username: 'gemini_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const calls = mockApi(bot);
  await bot.handleUpdate(update(text, id, messageExtra));
  return calls;
}

describe('telegram gemini streaming', { concurrency: 1 }, () => {
  test('splitTelegramText continues past 4096 on a newline', () => {
    const text = `${'a'.repeat(4000)}\n${'b'.repeat(200)}`;
    const parts = splitTelegramText(text);
    assert.deepEqual(parts, ['a'.repeat(4000), 'b'.repeat(200)]);
    const hard = 'c'.repeat(5000);
    const chunks = splitTelegramText(hard);
    assert.equal(chunks[0].length, 4096);
    assert.equal(chunks.join(''), hard);
  });

  test('a normal text message shows a placeholder, grows, then the full answer', async () => {
    state.mode = 'stream-ok';
    const bot = createBot();
    const calls = await send(bot, 'hello', 10);
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(sent, ['…']);
    assert.deepEqual(edits, ['Hel', 'Hello there']);
    const stream = bridgeHits.find((h) => h.path === '/chat_stream');
    assert.ok(stream);
    const body = JSON.parse(stream.body);
    assert.equal(body.prompt, 'hello');
    assert.equal(body.session_id, 'tg-424242');
    assert.equal(body.model, 'gemini-flash');
    assert.equal(body.tools.extended_thinking, true);
    assert.equal(bridgeHits.some((h) => h.path === '/chat'), false);
  });

  test('identical partial text is not edited again', { timeout: 15000 }, async () => {
    state.mode = 'identical';
    const previous = state.prefs;
    state.prefs = { model: null, tools: {} };
    try {
      const bot = createBot();
      const calls = await send(bot, 'again', 11);
      const edits = calls.filter((c) => c.method === 'editMessageText');
      assert.equal(edits.length, 1);
      assert.equal(edits[0].text, 'Hello');
    } finally {
      state.prefs = previous;
    }
  });

  test('answers longer than 4096 continue in a follow-up', async () => {
    state.mode = 'long';
    state.longText = 'd'.repeat(5000);
    const bot = createBot();
    const calls = await send(bot, 'long please', 12);
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.equal(sent[0], '…');
    assert.equal(sent[1], 'd'.repeat(904));
    assert.equal(edits[0], 'd'.repeat(4096));
    assert.equal(`${edits[0]}${sent[1]}`, state.longText);
  });

  test('streamed text is not repeated as a media caption', async () => {
    state.mode = 'media';
    state.mediaPath = path.join(os.tmpdir(), 'gemini-stream-a.png');
    fs.writeFileSync(state.mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const bot = createBot();
    const calls = await send(bot, 'picture', 13);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.ok(edits.includes('Here is the picture'));
    const photo = calls.find((c) => c.method === 'sendPhoto');
    assert.ok(photo);
    assert.equal(photo.caption, undefined);
    assert.equal(calls.some((c) => c.method === 'sendMessage' && c.text === 'Here is the picture'), false);
  });

  test('http failure before any text falls back to one-shot chat', async () => {
    state.mode = 'http-error';
    const bot = createBot();
    const calls = await send(bot, 'fallback please', 14);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(edits, ['one-shot:fallback please']);
    assert.equal(bridgeHits.filter((h) => h.path === '/chat_stream').length, 1);
    assert.equal(bridgeHits.filter((h) => h.path === '/chat').length, 1);
    assert.equal(JSON.parse(bridgeHits.find((h) => h.path === '/chat').body).prompt, 'fallback please');
  });

  test('error event before any text falls back to one-shot chat', async () => {
    state.mode = 'error-before-text';
    const bot = createBot();
    const calls = await send(bot, 'still there', 15);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(edits, ['one-shot:still there']);
    assert.equal(bridgeHits.filter((h) => h.path === '/chat').length, 1);
  });

  test('a dropped stream before text falls back to one-shot chat', async () => {
    state.mode = 'socket-reset';
    const bot = createBot();
    const calls = await send(bot, 'reset me', 16);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(edits, ['one-shot:reset me']);
    assert.equal(bridgeHits.filter((h) => h.path === '/chat').length, 1);
  });

  test('partial text is kept when the stream fails after Gemini started', async () => {
    state.mode = 'error-after-partial';
    const bot = createBot();
    const calls = await send(bot, 'do not resend', 17);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(edits, ['partial answer']);
    assert.equal(bridgeHits.some((h) => h.path === '/chat'), false);
  });

  test('both stream and one-shot failing still answers with the error message', async () => {
    state.mode = 'both-fail';
    const bot = createBot();
    const calls = await send(bot, 'nothing works', 18);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(edits, ['Gemini didn’t answer — try again in a bit.']);
    assert.equal(bridgeHits.filter((h) => h.path === '/chat').length, 1);
  });

  test('commands and reply-keyboard buttons do not open a stream', async () => {
    state.mode = 'stream-ok';
    const bot = createBot();
    const calls = await send(bot, '/new', 19, {
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
    });
    assert.equal(bridgeHits.some((h) => h.path === '/chat_stream'), false);
    assert.ok(bridgeHits.some((h) => h.path === '/reset'));
    assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.message_id === 19));
    await send(bot, 'Model', 20);
    assert.equal(bridgeHits.some((h) => h.path === '/chat_stream'), false);
    assert.ok(bridgeHits.some((h) => h.path === '/models'));
  });

  test('chatStream marks a pre-text failure as a fallback', async () => {
    state.mode = 'http-error';
    await assert.rejects(
      () => chatStream('hi', 'tg-1', {}),
      (err) => err.fallback === true && err.partial === false,
    );
  });
});
