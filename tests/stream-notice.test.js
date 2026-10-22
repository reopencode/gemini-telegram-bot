/**
 * A fallback notice from the bridge is shown as it arrives, before the final text.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

process.env.HISTORY_PATH = path.join(os.tmpdir(), `notice-history-${process.pid}.json`);
process.env.GEMINI_PREFS_PATH = path.join(os.tmpdir(), `notice-prefs-${process.pid}.json`);

const NOTE = 'The selected model failed, so this reply used the default model.';

let server;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(
      `${JSON.stringify({ type: 'notice', text: NOTE, fallback: true })}\n` +
        `${JSON.stringify({
          type: 'final',
          text: `${NOTE}\n\nHi`,
          session_id: 'session-1',
          model: null,
          tools: {},
          media: [],
          fallback: true,
        })}\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.GEMINI_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

test('fallback notice is shown through the stream', async () => {
  const { chatStream } = await import('../src/geminiClient.js');
  const seen = [];
  const result = await chatStream('hello', 'session-1', {
    model: 'gemini-flash',
    onPartial: async (text) => {
      seen.push(text);
    },
  });
  assert.ok(seen.some((text) => text.includes('used the default model')));
  assert.match(result.text, /used the default model/);
  assert.match(result.text, /Hi/);
});
