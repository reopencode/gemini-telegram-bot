/**
 * Telegram must not receive a generated mp4.
 * Create Video keeps a placeholder until the final text, and never streams running model text.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = path.join(root, 'data', 'allowlist.json');
const allowlistExisted = fs.existsSync(allowlistPath);
const allowlistBackup = allowlistExisted ? fs.readFileSync(allowlistPath, 'utf8') : null;
process.env.PERMANENT_ADMINS = 'tester';

const VIDEO_READY_TEXT = 'Your video is ready!';
const PLACEHOLDER = '…';

const state = {
  tools: {},
  result: { text: 'ok', media: [] },
};
const bridgeHits = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ndjson(obj) {
  return `${JSON.stringify(obj)}\n`;
}

let server;
let createBot;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    bridgeHits.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === '/prefs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        session_id: url.searchParams.get('session_id'),
        prefs: { model: null, tools: state.tools },
      }));
      return;
    }
    if (url.pathname === '/chat' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        text: state.result.text,
        session_id: 'tg-424242',
        model: null,
        tools: state.tools,
        media: state.result.media,
      }));
      return;
    }
    if (url.pathname === '/chat_stream' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      });
      if (state.streamPartials) {
        res.write(ndjson({ type: 'partial', text: 'Rendering the ocean' }));
        await delay(200);
      }
      res.end(ndjson({
        type: 'final',
        text: state.result.text,
        session_id: 'tg-424242',
        model: null,
        tools: state.tools,
        media: state.result.media,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.GEMINI_BRIDGE_URL = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  ({ createBot } = await import('../src/bot.js'));
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
    if (
      method === 'sendMessage'
      || method === 'sendPhoto'
      || method === 'sendAudio'
      || method === 'sendVideo'
      || method === 'sendDocument'
    ) {
      nextId += 1;
      entry.message_id = nextId;
      return {
        ok: true,
        result: {
          message_id: nextId,
          date: 1,
          chat: { id: payload.chat_id, type: 'private' },
          text: payload.text || '',
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

function update(text, id) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 424242, type: 'private' },
      from: { id: 424242, is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
    },
  };
}

async function send(text, id) {
  bridgeHits.length = 0;
  const streamPartials = state.streamPartials;
  state.streamPartials = false;
  const bot = createBot();
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
  state.streamPartials = streamPartials;
  await bot.handleUpdate(update(text, id));
  state.streamPartials = false;
  return calls;
}

function textsOf(calls) {
  return calls.map((c) => c.text || c.caption || '').filter(Boolean);
}

describe('telegram video withholding', { concurrency: 1 }, () => {
  test('a generated video is replaced by the ready message and the file is removed', async () => {
    const file = path.join(os.tmpdir(), `gemini-withhold-${Date.now()}.mp4`);
    fs.writeFileSync(file, Buffer.from('not-a-real-video'));
    state.tools = { create_video: true };
    state.streamPartials = true;
    state.result = {
      text: 'Here is the ocean clip I rendered for you.',
      media: [{ type: 'video', path: file, filename: 'clip.mp4', url: '/media/clip.mp4', mime: 'video/mp4' }],
    };
    try {
      const calls = await send('make a video', 20);
      const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
      const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
      assert.deepEqual(sent, [PLACEHOLDER]);
      assert.deepEqual(edits, [VIDEO_READY_TEXT]);
      assert.equal(calls.some((c) => c.method === 'sendVideo' || c.method === 'sendDocument'), false);
      assert.equal(textsOf(calls).some((t) => t.includes('ocean clip') || t.includes('Rendering the ocean')), false);
      assert.equal(fs.existsSync(file), false);
      assert.equal(bridgeHits.some((h) => h.path === '/chat_stream'), true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('create video with no video keeps the normal text and does not stream it', async () => {
    state.tools = { create_video: true };
    state.streamPartials = true;
    state.result = { text: 'I could not make a video.', media: [] };
    const calls = await send('try video', 21);
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(sent, [PLACEHOLDER]);
    assert.deepEqual(edits, ['I could not make a video.']);
    assert.equal(edits.includes(VIDEO_READY_TEXT), false);
    assert.equal(edits.includes('Rendering the ocean'), false);
  });

  test('an image is still sent when create video is on but no video was produced', async () => {
    const file = path.join(os.tmpdir(), `gemini-image-video-mode-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    state.tools = { create_video: true };
    state.result = {
      text: 'A painting.',
      media: [{ type: 'image', path: file, filename: 'art.png', url: '/media/art.png', mime: 'image/png' }],
    };
    try {
      const calls = await send('draw instead', 26);
      assert.equal(calls.some((c) => c.method === 'sendPhoto'), true);
      assert.equal(textsOf(calls).includes('A painting.'), true);
      assert.equal(textsOf(calls).includes(VIDEO_READY_TEXT), false);
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('images are still sent when create video is off', async () => {
    const file = path.join(os.tmpdir(), `gemini-image-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    state.tools = { create_image: true };
    state.result = {
      text: 'A painting.',
      media: [{ type: 'image', path: file, filename: 'art.png', url: '/media/art.png', mime: 'image/png' }],
    };
    try {
      const calls = await send('draw', 22);
      assert.equal(calls.some((c) => c.method === 'sendPhoto'), true);
      assert.equal(calls.some((c) => c.text === VIDEO_READY_TEXT), false);
      assert.equal(calls.some((c) => c.text === PLACEHOLDER), true);
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('audio is still sent when create video is off', async () => {
    const file = path.join(os.tmpdir(), `gemini-audio-${Date.now()}.mp3`);
    fs.writeFileSync(file, Buffer.from('fake-mp3'));
    state.tools = { create_music: true };
    state.result = {
      text: 'A short tune.',
      media: [{ type: 'audio', path: file, filename: 'tune.mp3', url: '/media/tune.mp3', mime: 'audio/mpeg', title: 'Tune' }],
    };
    try {
      const calls = await send('music', 23);
      assert.equal(calls.some((c) => c.method === 'sendAudio'), true);
      assert.equal(calls.some((c) => c.method === 'sendVideo'), false);
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('a normal text reply is unchanged', async () => {
    state.tools = {};
    state.result = { text: 'Hello from Gemini', media: [] };
    const calls = await send('hello', 24);
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
    const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
    assert.deepEqual(sent, [PLACEHOLDER]);
    assert.deepEqual(edits, ['Hello from Gemini']);
  });

  test('a video is withheld even if the create video tool flag was not echoed', async () => {
    const file = path.join(os.tmpdir(), `gemini-withhold-flag-${Date.now()}.mp4`);
    fs.writeFileSync(file, Buffer.from('not-a-real-video'));
    state.tools = {};
    state.result = {
      text: 'watch this clip',
      media: [{ type: 'video', path: file, filename: 'clip.mp4', url: '/media/clip.mp4' }],
    };
    try {
      const calls = await send('video anyway', 25);
      const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text);
      const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.text);
      assert.deepEqual(sent, [PLACEHOLDER]);
      assert.equal(edits.includes(VIDEO_READY_TEXT), true);
      assert.equal(calls.some((c) => c.method === 'sendVideo' || c.method === 'sendDocument'), false);
      assert.equal(textsOf(calls).some((t) => t.includes('watch this clip')), false);
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
