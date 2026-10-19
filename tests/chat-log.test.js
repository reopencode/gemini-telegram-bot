/**
 * Private-chat message ids remembered so New chat can delete the visible log.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatLog, rememberApiResult, deleteTrackedMessages } from '../src/chatLog.js';

describe('chat log', () => {
  test('remembers private chat ids and take() clears them', () => {
    const log = createChatLog();
    log.remember(42, 1);
    log.remember(42, 2);
    log.remember(-100, 9);
    assert.deepEqual(log.take(42), [1, 2]);
    assert.deepEqual(log.take(42), []);
    assert.deepEqual(log.take(-100), []);
  });

  test('drops the oldest ids past the cap', () => {
    const log = createChatLog(2);
    log.remember(7, 1);
    log.remember(7, 2);
    log.remember(7, 3);
    assert.deepEqual(log.take(7), [2, 3]);
  });

  test('records sendMessage and sendMediaGroup results, skips edits', () => {
    const log = createChatLog();
    rememberApiResult(log, 'sendMessage', { chat_id: 5 }, { ok: true, result: { message_id: 10 } });
    rememberApiResult(log, 'editMessageText', { chat_id: 5, message_id: 10 }, { ok: true, result: { message_id: 10 } });
    rememberApiResult(log, 'sendMediaGroup', { chat_id: 5 }, { ok: true, result: [{ message_id: 11 }, { message_id: 12 }] });
    rememberApiResult(log, 'sendMessage', { chat_id: -3 }, { ok: true, result: { message_id: 99 } });
    assert.deepEqual(log.take(5), [10, 11, 12]);
  });

  test('delete ignores Telegram failures and still tries every id', async () => {
    const seen = [];
    const api = {
      async deleteMessage(chatId, id) {
        seen.push([chatId, id]);
        if (id === 2) throw new Error('message can\'t be deleted');
      },
    };
    await deleteTrackedMessages(api, 5, [1, 2, 3]);
    assert.deepEqual(seen, [[5, 1], [5, 2], [5, 3]]);
  });
});
