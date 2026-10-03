import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeSettings, httpListen } from '../src/env.js';

test('bridge and http settings follow env with the previous defaults', () => {
  const keys = [
    'GEMINI_BRIDGE_URL',
    'GEMINI_BRIDGE_HOST',
    'GEMINI_BRIDGE_PORT',
    'PORT',
    'HOST',
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };

  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(bridgeSettings(), {
      url: 'http://127.0.0.1:8765',
      host: '127.0.0.1',
      port: '8765',
    });
    assert.deepEqual(httpListen(), { host: '0.0.0.0', port: 8787 });

    process.env.GEMINI_BRIDGE_URL = 'http://10.0.0.2:9000';
    assert.deepEqual(bridgeSettings(), {
      url: 'http://10.0.0.2:9000',
      host: '10.0.0.2',
      port: '9000',
    });

    process.env.GEMINI_BRIDGE_HOST = '0.0.0.0';
    process.env.GEMINI_BRIDGE_PORT = '9001';
    assert.deepEqual(bridgeSettings(), {
      url: 'http://0.0.0.0:9001',
      host: '0.0.0.0',
      port: '9001',
    });

    process.env.HOST = '127.0.0.1';
    process.env.PORT = '8790';
    assert.deepEqual(httpListen(), { host: '127.0.0.1', port: 8790 });
  } finally {
    restore();
  }
});
