/**
 * Message ids for the current private chat, so New chat can delete them.
 * Telegram only allows deleting messages from the last 48 hours; callers ignore failures.
 */
export const CHAT_LOG_LIMIT = 200;

const TRACKED_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendAudio',
  'sendDocument',
  'sendVideo',
  'sendAnimation',
  'sendVoice',
  'sendVideoNote',
  'copyMessage',
  'sendMediaGroup',
]);

function privateChatId(chatId) {
  const chat = Number(chatId);
  return Number.isFinite(chat) && chat > 0 ? chat : null;
}

export function createChatLog(limit = CHAT_LOG_LIMIT) {
  const byChat = new Map();
  return {
    remember(chatId, messageId) {
      const chat = privateChatId(chatId);
      const id = Number(messageId);
      if (chat == null || !Number.isFinite(id)) return;
      const key = String(chat);
      const list = byChat.get(key) || [];
      if (!list.includes(id)) list.push(id);
      while (list.length > limit) list.shift();
      byChat.set(key, list);
    },
    take(chatId) {
      const chat = privateChatId(chatId);
      if (chat == null) return [];
      const key = String(chat);
      const list = byChat.get(key) || [];
      byChat.delete(key);
      return list.slice();
    },
  };
}

function messageIds(result) {
  if (!result || result.ok === false) return [];
  const body = result.ok === true ? result.result : result;
  if (Array.isArray(body)) return body.map((m) => m?.message_id);
  if (body && typeof body === 'object') return [body.message_id];
  return [];
}

/** Record ids from a Bot API send* response. `result` may be the raw `{ ok, result }` envelope. */
export function rememberApiResult(log, method, payload, result) {
  if (!TRACKED_METHODS.has(method)) return;
  for (const id of messageIds(result)) log.remember(payload?.chat_id, id);
}

export async function deleteTrackedMessages(api, chatId, ids) {
  for (const id of ids) {
    try {
      await api.deleteMessage(chatId, id);
    } catch {
      /* Older than 48 hours, or already gone. */
    }
  }
}
