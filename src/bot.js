import { unlinkSync } from 'node:fs';
import { Bot, InlineKeyboard } from 'grammy';
import { VIDEO_READY_TEXT, withoutVideos as stripVideoMedia } from '../public/videoReply.js';
import {
  chat,
  chatStream,
  chatWithFiles,
  resetSession,
  healthCheck,
  listModels,
  listTools,
  getPrefs,
  setPrefs,
} from './geminiClient.js';
import { listChats, getChat, formatTranscript } from './history.js';
import { historySettings } from './env.js';
import { refreshGeminiCookies } from './refreshCookies.js';
import {
  isTelegramUserAllowed,
  rememberAuthorizedUser,
  isAdmin,
  allowTarget,
  denyTarget,
  listAllowlist,
  DENY_MESSAGE,
  authSummary,
  seedAllowlistFromEnv,
} from './auth.js';

function requireToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return token;
}

function webAppUrl() {
  return process.env.WEBAPP_URL || '';
}

function sid(ctx) {
  return `tg-${ctx.from?.id || ctx.chat.id}`;
}

const TOOL_LABELS = {
  extended_thinking: 'Thinking',
  deep_research: 'Deep Research',
  create_image: 'Create Image',
  create_video: 'Create Video',
  create_music: 'Create Music',
  google_search: 'Search',
  code_execution: 'Code',
  canvas: 'Canvas',
};

const GEMINI_ERROR_MESSAGE = 'Gemini didn’t answer — try again in a bit.';
const TOOLS_INTRO = 'Tools — Tap to turn on or off. Active ones stay on until you tap them again.';

function formatActiveTools(tools = {}) {
  const on = Object.entries(tools)
    .filter(([, v]) => !!v)
    .map(([k]) => TOOL_LABELS[k] || k);
  return on.length ? on.join(', ') : '(none)';
}

async function sessionOptions(ctx) {
  const prefsRes = await getPrefs(sid(ctx));
  const prefs = prefsRes.prefs || {};
  return {
    model: prefs.model || undefined,
    tools: prefs.tools || {},
  };
}

/** Active-only sticky chips (tap → turn that tool off). */
function buildActiveChipsKb(tools = {}) {
  const active = Object.entries(tools || {}).filter(([, v]) => !!v);
  if (!active.length) return null;
  const kb = new InlineKeyboard();
  let n = 0;
  for (const [id] of active) {
    const label = TOOL_LABELS[id] || id;
    kb.text(`✓ ${label} ×`, `chip:${id}`);
    n += 1;
    if (n % 2 === 0) kb.row();
  }
  return kb;
}

function replyMarkupForTools(tools) {
  const kb = buildActiveChipsKb(tools);
  return kb ? { reply_markup: kb } : {};
}

/** In-memory sticky "Active tools" message per session (chatId+session). */
const chipsMessageIds = new Map();

function chipsKey(ctx) {
  return `${ctx.chat?.id}:${sid(ctx)}`;
}

async function upsertActiveChipsMessage(ctx, tools) {
  const kb = buildActiveChipsKb(tools);
  const key = chipsKey(ctx);
  const prevId = chipsMessageIds.get(key);
  const text = kb
    ? `Active tools\n${formatActiveTools(tools)}`
    : 'No tools are on right now.';
  if (prevId) {
    try {
      if (kb) {
        await ctx.api.editMessageText(ctx.chat.id, prevId, text, { reply_markup: kb });
      } else {
        await ctx.api.editMessageText(ctx.chat.id, prevId, text);
        try {
          await ctx.api.editMessageReplyMarkup(ctx.chat.id, prevId, {
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          /* ignore */
        }
        chipsMessageIds.delete(key);
      }
      return;
    } catch {
      chipsMessageIds.delete(key);
    }
  }
  if (!kb) return;
  const msg = await ctx.reply(text, { reply_markup: kb });
  chipsMessageIds.set(key, msg.message_id);
}

async function downloadTelegramFile(api, fileId) {
  const f = await api.getFile(fileId);
  const token = requireToken();
  const url = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = (f.file_path || 'file.bin').split('/').pop();
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer: buf, filename, contentType };
}


export function withoutVideos(result) {
  const media = result?.media || [];
  for (const m of media) {
    if (m?.type === 'video' && m.path) {
      try {
        unlinkSync(m.path);
      } catch {
        /* already removed, or not a local file */
      }
    }
  }
  return stripVideoMedia(result);
}

async function deliverMedia(ctx, result, tools, { textAlreadySent = false } = {}) {
  const hadVideo = (result?.media || []).some((m) => m.type === 'video');
  result = withoutVideos(result);
  const activeTools = tools || result?.tools || {};
  const chipOpts = replyMarkupForTools(activeTools);
  const media = result?.media || [];
  if (hadVideo && !textAlreadySent && !media.length) {
    await ctx.reply(VIDEO_READY_TEXT, chipOpts);
    return;
  }
  // When the answer was already streamed into a message, don't repeat it as a caption.
  const caption = textAlreadySent ? '' : (result?.text || '').slice(0, 900);
  let sentMedia = false;
  if (!media.length) {
    if (textAlreadySent) return;
    await ctx.reply((result?.text || '(empty reply)').slice(0, 4000), chipOpts);
    return;
  }
  const { InputFile } = await import('grammy');
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const file = new InputFile(m.path, m.filename || undefined);
    const cap = i === 0 && caption ? caption : undefined;
    const isLast = i === media.length - 1;
    const opts = {
      ...(cap ? { caption: cap } : {}),
      ...(isLast ? chipOpts : {}),
    };
    try {
      if (m.type === 'image') {
        await ctx.replyWithPhoto(file, opts);
      } else if (m.type === 'video') {
        await ctx.replyWithVideo(file, opts);
      } else if (m.type === 'audio') {
        await ctx.replyWithAudio(file, {
          ...opts,
          ...(m.title ? { title: m.title } : {}),
        });
      } else {
        await ctx.replyWithDocument(file, opts);
      }
      sentMedia = true;
    } catch (e) {
      console.warn('[bot] media send failed', m.type, e.message || e);
      try {
        await ctx.replyWithDocument(new InputFile(m.path, m.filename || 'file.bin'), {
          caption: cap || `Could not send as ${m.type}; sent as document.`,
          ...(isLast ? chipOpts : {}),
        });
        sentMedia = true;
      } catch (e2) {
        console.warn('[bot] document fallback failed', e2.message || e2);
      }
    }
  }
  if (!sentMedia && caption && !textAlreadySent) await ctx.reply(caption.slice(0, 4000), chipOpts);
  else if (sentMedia && Object.keys(chipOpts).length && media.length > 1) {
    // Chips already on last media; nothing else
  } else if (sentMedia && Object.keys(chipOpts).length === 0) {
    /* no chips */
  }
}


/** Telegram message text limit is 4096. Split on a nearby newline or space. */
export function splitTelegramText(text, limit = 4096) {
  const src = text == null ? '' : String(text);
  if (src.length <= limit) return src ? [src] : [];
  const parts = [];
  let i = 0;
  while (i < src.length) {
    if (src.length - i <= limit) {
      parts.push(src.slice(i));
      break;
    }
    let cut = src.lastIndexOf('\n', i + limit);
    if (cut < i + Math.floor(limit / 2)) cut = src.lastIndexOf(' ', i + limit);
    if (cut < i + Math.floor(limit / 2)) cut = i + limit;
    parts.push(src.slice(i, cut));
    i = cut;
    if (src[i] === '\n' || src[i] === ' ') i += 1;
  }
  return parts.filter((p) => p.length > 0);
}

function formatHistoryDate(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Transcript split into pages that fit one Telegram message together with the header. */
export function paginateTranscript(chat) {
  const pages = splitTelegramText(formatTranscript(chat), historySettings().pageChars);
  return pages.length ? pages : ['(empty chat)'];
}

const STREAM_EDIT_INTERVAL_MS = 1000;
const STREAM_PLACEHOLDER = '…';

function editErrorText(e) {
  return String(e?.description || e?.message || e || '');
}

function isNotModified(e) {
  return /message is not modified/i.test(editErrorText(e));
}

function retryAfterSeconds(e) {
  const n = e?.parameters?.retry_after;
  if (typeof n === 'number' && n > 0) return n;
  const m = editErrorText(e).match(/retry after (\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * One placeholder message that is edited as the cumulative reply grows.
 * Edits are throttled to about once a second and identical text is skipped.
 * Past 4096 chars, overflow is sent as follow-up messages.
 */
function createLiveReply(ctx, seedMsg) {
  const chatId = ctx.chat.id;
  const ids = [seedMsg.message_id];
  let lastShown = [seedMsg.text || STREAM_PLACEHOLDER];
  let pending = null;
  let timer = null;
  let lastEditAt = 0;
  let closed = false;
  let chain = Promise.resolve();

  function enqueue(fn) {
    chain = chain.then(fn, fn);
    return chain;
  }

  async function apply(fullText, replyMarkup) {
    const text = fullText && String(fullText).trim() ? String(fullText) : STREAM_PLACEHOLDER;
    const parts = splitTelegramText(text, 4096);
    if (!parts.length) parts.push(STREAM_PLACEHOLDER);
    while (ids.length < parts.length) {
      const msg = await ctx.reply(parts[ids.length]);
      ids.push(msg.message_id);
      lastShown.push(msg.text || parts[ids.length]);
    }
    while (ids.length > parts.length) {
      const extra = ids.pop();
      lastShown.pop();
      try {
        await ctx.api.deleteMessage(chatId, extra);
      } catch {
        /* leave a stale tail rather than crash */
      }
    }
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const markup = isLast && replyMarkup ? replyMarkup : undefined;
      if (lastShown[i] === parts[i] && !markup) continue;
      const extra = markup ? { reply_markup: markup } : {};
      try {
        await ctx.api.editMessageText(chatId, ids[i], parts[i], extra);
        lastShown[i] = parts[i];
      } catch (e) {
        if (isNotModified(e)) {
          lastShown[i] = parts[i];
          continue;
        }
        const wait = retryAfterSeconds(e);
        if (wait != null || e?.error_code === 429) {
          await new Promise((r) => setTimeout(r, Math.min(wait || 1, 5) * 1000));
          try {
            await ctx.api.editMessageText(chatId, ids[i], parts[i], extra);
            lastShown[i] = parts[i];
          } catch (e2) {
            console.warn('[bot] stream edit retry failed', editErrorText(e2).slice(0, 180));
          }
        } else {
          console.warn('[bot] stream edit failed', editErrorText(e).slice(0, 180));
        }
      }
    }
    lastEditAt = Date.now();
  }

  async function flushPending() {
    timer = null;
    if (closed) return;
    const text = pending;
    pending = null;
    if (text == null) return;
    await enqueue(() => apply(text));
    if (!closed && pending != null && !timer) {
      timer = setTimeout(() => {
        void flushPending();
      }, STREAM_EDIT_INTERVAL_MS);
    }
  }

  function update(fullText) {
    if (closed) return;
    pending = fullText;
    if (timer) return;
    const wait = lastEditAt === 0 ? 0 : Math.max(0, STREAM_EDIT_INTERVAL_MS - (Date.now() - lastEditAt));
    timer = setTimeout(() => {
      void flushPending();
    }, wait);
  }

  async function finish(fullText, replyMarkup) {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    await enqueue(() => apply(fullText, replyMarkup));
  }

  async function discard() {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    await enqueue(async () => {
      for (const id of ids.splice(0, ids.length)) {
        try {
          await ctx.api.deleteMessage(chatId, id);
        } catch {
          /* ignore */
        }
      }
      lastShown = [];
    });
  }

  return { update, finish, discard };
}

async function presentChatResult(ctx, result, tools, live) {
  result = withoutVideos(result);
  const media = result?.media || [];
  const chipKb = buildActiveChipsKb(tools || result?.tools || {});
  const raw = result?.text || '';
  const finalText = raw.trim() ? raw : media.length ? '' : '(empty reply)';
  if (live) {
    if (finalText) {
      await live.finish(finalText, media.length ? undefined : chipKb || undefined);
    } else {
      await live.discard();
    }
  } else if (!media.length) {
    await ctx.reply((raw || '(empty reply)').slice(0, 4000), replyMarkupForTools(tools));
  }
  if (media.length) {
    await deliverMedia(ctx, result, tools, { textAlreadySent: !!(live && finalText) });
  }
}

async function deny(ctx) {
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: DENY_MESSAGE, show_alert: true });
      try {
        await ctx.reply(DENY_MESSAGE);
      } catch {
        /* ignore */
      }
      return;
    }
    await ctx.reply(DENY_MESSAGE);
  } catch (e) {
    console.warn('[bot] deny reply failed', e.message || e);
  }
}

export function createBot(options = {}) {
  seedAllowlistFromEnv();
  const bot = new Bot(requireToken());
  const restartBridgeFn = typeof options.restartBridge === 'function' ? options.restartBridge : null;

  // Persistent Telegram reply keyboard next to the chat composer.
  function replyKeyboard(ctx) {
    const keyboard = [
      ['Model', 'Tools'],
      ['New chat', 'History'],
      ['Status', 'Fix'],
      ['Open app'],
    ];
    if (isAdmin(ctx.from)) keyboard.push(['Admin']);
    return {
      keyboard,
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: 'Choose an action…',
    };
  }

  /** Diagnose common “bot don’t answer” issues (no secrets). */
  async function buildFixReport(ctx) {
    let bridgeReachable = false;
    let sessionLabel = 'not ready';
    try {
      const h = await healthCheck();
      bridgeReachable = true;
      const acct = h.account || {};
      if (acct.status) {
        sessionLabel = String(acct.status);
      } else if (h.client_ready && h.ok) {
        sessionLabel = 'AVAILABLE';
      } else if (h.startup_error) {
        sessionLabel = String(h.startup_error).slice(0, 80);
      } else {
        sessionLabel = 'not ready';
      }
    } catch {
      bridgeReachable = false;
      sessionLabel = 'not ready';
    }
    const webappSet = !!webAppUrl();
    const allowlisted = isTelegramUserAllowed(ctx.from);
    const lines = [
      'Quick health check:',
      '',
      `Gemini session: ${sessionLabel}`,
      `Bridge: ${bridgeReachable ? 'reachable' : 'not reachable'}`,
      `Mini App URL: ${webappSet ? 'set' : 'not set'}`,
      `You’re on the allowlist: ${allowlisted ? 'yes' : 'no'}`,
      '',
      'Tip: new users must open the bot and tap Start before the bot can message them.',
    ];
    return { text: lines.join('\n'), bridgeReachable, sessionLabel, webappSet, allowlisted };
  }

  function fixAdminKeyboard() {
    return new InlineKeyboard()
      .text('Refresh Gemini cookies', 'fix:cookies')
      .row()
      .text('Restart Gemini bridge', 'fix:restart')
      .row()
      .text('Refresh status', 'fix:refresh');
  }

  async function sendFixReport(ctx, { edit = false } = {}) {
    const report = await buildFixReport(ctx);
    const admin = isAdmin(ctx.from);
    const opts = admin ? { reply_markup: fixAdminKeyboard() } : {};
    if (edit && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(report.text, opts);
        return report;
      } catch {
        /* fall through to reply */
      }
    }
    if (admin) {
      await ctx.reply(report.text, opts);
    } else {
      await replyWithMenu(ctx, report.text);
    }
    return report;
  }

  async function replyWithMenu(ctx, text, options = {}) {
    return ctx.reply(text, { ...options, reply_markup: replyKeyboard(ctx) });
  }

  /** Reset Gemini's context; resetSession archives the old chat as read-only history. */
  async function startNewChat(ctx) {
    const before = listChats(sid(ctx)).length;
    await resetSession(sid(ctx));
    const saved = listChats(sid(ctx)).length > before;
    return saved
      ? 'Fresh chat ready — your previous chat is saved in History. Send me a message whenever you’re ready.'
      : 'Fresh chat ready — send me a message whenever you’re ready.';
  }

  function historyListView(ctx) {
    const chats = listChats(sid(ctx));
    if (!chats.length) {
      return { text: 'No past chats yet. When you start a new chat, the old one is saved here.' };
    }
    const kb = new InlineKeyboard();
    for (const c of chats.slice(0, historySettings().listLimit)) {
      kb.text(`${formatHistoryDate(c.endedAt)} · ${c.title}`, `hist:o:${c.id}:0`).row();
    }
    return {
      text: 'Your past chats — tap one to read it. Archived chats are read-only.',
      reply_markup: kb,
    };
  }

  async function sendHistoryList(ctx) {
    const view = historyListView(ctx);
    await ctx.reply(view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
  }

  /** Read-only page of an archived chat, scoped to the caller's own session. */
  function historyChatView(ctx, chatId, page) {
    const chat = getChat(sid(ctx), chatId);
    if (!chat) return null;
    const pages = paginateTranscript(chat);
    const idx = Math.min(Math.max(Number(page) || 0, 0), pages.length - 1);
    const header = `Archived chat · read-only\n${chat.title} · ${formatHistoryDate(chat.endedAt)}`;
    const footer = pages.length > 1 ? `\n\nPage ${idx + 1}/${pages.length}` : '';
    const kb = new InlineKeyboard();
    if (idx > 0) kb.text('‹ Prev', `hist:o:${chat.id}:${idx - 1}`);
    if (idx < pages.length - 1) kb.text('Next ›', `hist:o:${chat.id}:${idx + 1}`);
    if (idx > 0 || idx < pages.length - 1) kb.row();
    kb.text('‹ Back to list', 'hist:l');
    return { text: `${header}\n\n${pages[idx]}${footer}`, reply_markup: kb };
  }

  // Gate every update before any handler
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!isTelegramUserAllowed(from)) {
      const who = from
        ? `@${from.username || 'unknown'} id=${from.id}`
        : 'no-from';
      console.warn(`[bot] deny ${who}`);
      await deny(ctx);
      return;
    }
    rememberAuthorizedUser(from);
    await next();
  });

  bot.command('start', async (ctx) => {
    const url = webAppUrl();
    const lines = [
      'Hey — I’m your private Gemini chat.',
      '',
      'Just send a message, photo, or file.',
      'Or open the app for the full Gemini-style UI.',
      '',
      'Quick actions:',
      '• /model — pick Flash / Pro',
      '• /tools — Thinking, Image, Video, Music…',
      '• /new — start a fresh chat (the old one is saved)',
      '• /history — read your past chats (read-only)',
      '• /status — what’s on right now',
      '• /fix — diagnose if the bot isn’t answering',
    ];
    if (isAdmin(ctx.from)) {
      lines.push('', 'Admin: /allow · /deny · /allowed');
    }
    // The reply keyboard is persistent; the inline button is kept as a quick launch too.
    await ctx.reply(lines.join('\n'), { reply_markup: replyKeyboard(ctx) });
    if (url) {
      const kb = new InlineKeyboard().webApp('Open Mini App', url);
      await ctx.reply('Open the full Gemini-style app:', { reply_markup: kb });
    }
  });

  bot.command('allowed', async (ctx) => {
    if (!isAdmin(ctx.from)) {
      await ctx.reply('That’s an admin-only command.');
      return;
    }
    const list = listAllowlist();
    const lines = [
      'Here’s the allowlist:',
      ...list.usernames.map((u) => {
        const admin = list.admins.includes(u) ? ' (admin)' : '';
        const ids = Object.entries(list.userIds)
          .filter(([, name]) => name === u)
          .map(([id]) => id);
        const idPart = ids.length ? ` · id ${ids.join(',')}` : '';
        return `• @${u}${admin}${idPart}`;
      }),
    ];
    const orphanIds = Object.entries(list.userIds).filter(([, name]) => !name);
    for (const [id] of orphanIds) {
      lines.push(`• id ${id}`);
    }
    if (list.updatedAt) lines.push('', `Updated: ${list.updatedAt}`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('allow', async (ctx) => {
    if (!isAdmin(ctx.from)) {
      await ctx.reply('That’s an admin-only command.');
      return;
    }
    const arg = (ctx.match || '').trim() || (ctx.message?.text || '').split(/\s+/).slice(1).join(' ');
    const replied = ctx.message?.reply_to_message?.from || null;
    const result = allowTarget(arg, replied);
    if (!result.ok) {
      await ctx.reply(
        result.error
          ? `I couldn’t add that user: ${result.error}.`
          : 'To add someone, use /allow <@username|user_id> or reply to their message with /allow.',
      );
      return;
    }
    if (result.userId != null && !result.username) {
      await ctx.reply(
        result.already
          ? `User id ${result.userId} is already on the allowlist.`
          : `Done — user id ${result.userId} is now on the allowlist.`,
      );
      return;
    }
    const label = result.username
      ? `@${result.username}${result.userId != null ? ` (id ${result.userId})` : ''}`
      : `id ${result.userId}`;
    await ctx.reply(
      result.already
        ? `${label} is already on the allowlist.`
        : `Done — ${label} is now on the allowlist.`,
    );
  });

  bot.command('deny', async (ctx) => {
    if (!isAdmin(ctx.from)) {
      await ctx.reply('That’s an admin-only command.');
      return;
    }
    const arg = (ctx.match || '').trim() || (ctx.message?.text || '').split(/\s+/).slice(1).join(' ');
    const replied = ctx.message?.reply_to_message?.from || null;
    const result = denyTarget(arg, replied);
    if (!result.ok) {
      await ctx.reply(
        result.error
          ? `I couldn’t remove that user: ${result.error}.`
          : 'To remove someone, use /deny <@username|user_id> or reply to their message with /deny.',
      );
      return;
    }
    const label = result.username
      ? `@${result.username}`
      : result.userId != null
        ? `user id ${result.userId}`
        : 'that user';
    await ctx.reply(
      result.already
        ? `${label} wasn’t on the allowlist.`
        : `Done — ${label} was removed from the allowlist.`,
    );
  });

  bot.command('app', async (ctx) => {
    const url = webAppUrl();
    if (!url) {
      await ctx.reply('Mini App URL not configured. Set WEBAPP_URL (see README).');
      return;
    }
    const kb = new InlineKeyboard().webApp('Open Gemini Chat', url);
    await ctx.reply('Opening Mini App…', { reply_markup: kb });
  });

  bot.command('new', async (ctx) => {
    await ctx.reply(await startNewChat(ctx), { reply_markup: replyKeyboard(ctx) });
  });

  bot.command('history', async (ctx) => {
    await sendHistoryList(ctx);
  });

  bot.command('status', async (ctx) => {
    try {
      const h = await healthCheck();
      const prefs = await getPrefs(sid(ctx));
      const acct = h.account || {};
      const auth = authSummary();
      await ctx.reply(
        [
          'Here’s what’s on right now:',
          '',
          `Gemini: ${h.ok ? 'connected' : 'not connected'}`,
          `Account: ${acct.status || 'unknown'}${acct.authenticated ? ' · signed in' : ''}`,
          `Model: ${prefs.prefs?.model || 'account default'}`,
          `Tools: ${formatActiveTools(prefs.prefs?.tools || {})}`,
          `Mini App: ${webAppUrl() ? 'ready' : 'not configured'}`,
          `Allowlist: ${auth.usernames.length ? auth.usernames.join(', ') : 'empty'}`,
        ].join('\n'),
      );
    } catch (e) {
      await ctx.reply('I can’t reach Gemini right now — try again in a bit.');
    }
  });

  bot.command('fix', async (ctx) => {
    await sendFixReport(ctx);
  });

  bot.command('model', async (ctx) => {
    try {
      const { models } = await listModels();
      const prefs = await getPrefs(sid(ctx));
      const current = prefs.prefs?.model;
      const kb = new InlineKeyboard();
      kb.text(current ? `Default` : `✓ Default`, 'model:').row();
      for (const m of models || []) {
        const mark = current === m.id ? '✓ ' : '';
        const avail = m.available ? '' : ' (limited)';
        kb.text(`${mark}${m.display_name || m.id}${avail}`, `model:${m.id}`).row();
      }
      await ctx.reply('Pick a model for this chat — Flash or Pro:', { reply_markup: kb });
    } catch (e) {
      await ctx.reply('I couldn’t load the models right now — try again in a bit.');
    }
  });

  bot.command('tools', async (ctx) => {
    try {
      const { tools } = await listTools();
      const prefs = await getPrefs(sid(ctx));
      const t = prefs.prefs?.tools || {};
      const kb = new InlineKeyboard();
      for (const tool of tools || []) {
        const on = !!t[tool.id];
        const stub = tool.supported ? '' : ' · stub';
        kb.text(`${on ? '✓' : '○'} ${tool.label}${stub}`, `tool:${tool.id}`).row();
      }
      const active = formatActiveTools(t);
      await ctx.reply(
        `${TOOLS_INTRO}\nActive now: ${active}`,
        { reply_markup: kb },
      );
      await upsertActiveChipsMessage(ctx, t);
    } catch (e) {
      await ctx.reply('I couldn’t load the tools right now — try again in a bit.');
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const session = sid(ctx);
    try {
      if (data.startsWith('model:')) {
        const model = data.slice('model:'.length) || null;
        await setPrefs(session, { model: model || '' });
        await ctx.answerCallbackQuery({ text: model ? `Using ${model}` : 'Using the account default' });
        await ctx.editMessageText(`Model ready: ${model || 'account default'}`);
        return;
      }
      if (data === 'hist:l') {
        const view = historyListView(ctx);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
        return;
      }
      if (data.startsWith('hist:o:')) {
        const [, , chatId, page] = data.split(':');
        const view = historyChatView(ctx, chatId, page);
        if (!view) {
          await ctx.answerCallbackQuery({ text: 'Chat not found', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(view.text, { reply_markup: view.reply_markup });
        } catch (e) {
          if (!isNotModified(e)) throw e;
        }
        return;
      }
      if (data.startsWith('chip:')) {
        const id = data.slice('chip:'.length);
        const prefs = await getPrefs(session);
        const tools = { ...(prefs.prefs?.tools || {}) };
        tools[id] = false;
        await setPrefs(session, { tools });
        const label = TOOL_LABELS[id] || id;
        await ctx.answerCallbackQuery({ text: `${label}: off` });
        const kb = buildActiveChipsKb(tools);
        const msgId = ctx.callbackQuery.message?.message_id;
        const key = chipsKey(ctx);
        const isSticky = chipsMessageIds.get(key) === msgId;
        try {
          if (isSticky) {
            // upsert refreshes sticky text + keyboard
          } else if (kb) {
            await ctx.editMessageReplyMarkup({ reply_markup: kb });
          } else {
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
          }
        } catch (e) {
          console.warn('[bot] chip markup refresh failed', e.message || e);
        }
        await upsertActiveChipsMessage(ctx, tools);
        return;
      }
      if (data.startsWith('tool:')) {
        const id = data.slice('tool:'.length);
        const prefs = await getPrefs(session);
        const tools = { ...(prefs.prefs?.tools || {}) };
        tools[id] = !tools[id];
        await setPrefs(session, { tools });
        const { tools: catalog } = await listTools();
        const kb = new InlineKeyboard();
        for (const tool of catalog || []) {
          const on = !!tools[tool.id];
          const stub = tool.supported ? '' : ' · stub';
          kb.text(`${on ? '✓' : '○'} ${tool.label}${stub}`, `tool:${tool.id}`).row();
        }
        const active = formatActiveTools(tools);
        await ctx.answerCallbackQuery({ text: `${id}: ${tools[id] ? 'on' : 'off'}` });
        try {
          await ctx.editMessageText(
            `${TOOLS_INTRO}\nActive now: ${active}`,
            { reply_markup: kb },
          );
        } catch {
          await ctx.editMessageReplyMarkup({ reply_markup: kb });
        }
        await upsertActiveChipsMessage(ctx, tools);
        return;
      }
      if (data === 'fix:cookies') {
        if (!isAdmin(ctx.from)) {
          await ctx.answerCallbackQuery({ text: 'Admin only', show_alert: true });
          return;
        }
        if (!restartBridgeFn) {
          await ctx.answerCallbackQuery({
            text: 'Cookie refresh needs bridge restart in this process.',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Refreshing cookies…' });
        try {
          await ctx.editMessageText(
            'Refreshing Gemini cookies from Chrome — hang tight…',
          );
        } catch {
          /* ignore */
        }
        let outcome = 'cookies refreshed';
        let exportOk = false;
        try {
          const result = await refreshGeminiCookies();
          exportOk = !!result.ok;
          outcome = result.reason || (exportOk ? 'cookies refreshed' : 'cookie refresh failed');
          // Always restart so bridge reloads .cookies.json (or reports UNAUTH after failed export)
          try {
            await restartBridgeFn();
          } catch (e) {
            const msg = String(e.message || e).slice(0, 160);
            outcome = exportOk
              ? `cookies written but bridge restart failed: ${msg}`
              : `${outcome}; bridge restart failed: ${msg}`;
            exportOk = false;
          }
        } catch (e) {
          outcome = `failed: ${String(e.message || e).slice(0, 160)}`;
          exportOk = false;
        }
        const report = await buildFixReport(ctx);
        const headline = exportOk ? 'Cookies refreshed.' : 'Cookie refresh failed.';
        const body = `${headline}\n${outcome}\n\n${report.text}`;
        try {
          await ctx.editMessageText(body, { reply_markup: fixAdminKeyboard() });
        } catch {
          await ctx.reply(body, { reply_markup: fixAdminKeyboard() });
        }
        return;
      }
      if (data === 'fix:refresh') {
        if (!isAdmin(ctx.from)) {
          await ctx.answerCallbackQuery({ text: 'Admin only', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Refreshing…' });
        await sendFixReport(ctx, { edit: true });
        return;
      }
      if (data === 'fix:restart') {
        if (!isAdmin(ctx.from)) {
          await ctx.answerCallbackQuery({ text: 'Admin only', show_alert: true });
          return;
        }
        if (!restartBridgeFn) {
          await ctx.answerCallbackQuery({
            text: 'Restart isn’t available in this process.',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Restarting bridge…' });
        try {
          await ctx.editMessageText('Restarting the Gemini bridge — hang tight…');
        } catch {
          /* ignore */
        }
        try {
          await restartBridgeFn();
          const report = await buildFixReport(ctx);
          const body = `Bridge restarted.\n\n${report.text}`;
          try {
            await ctx.editMessageText(body, { reply_markup: fixAdminKeyboard() });
          } catch {
            await ctx.reply(body, { reply_markup: fixAdminKeyboard() });
          }
        } catch (e) {
          const msg = String(e.message || e).slice(0, 200);
          const fail = `Bridge restart failed: ${msg}`;
          try {
            await ctx.editMessageText(fail, { reply_markup: fixAdminKeyboard() });
          } catch {
            await ctx.reply(fail, { reply_markup: fixAdminKeyboard() });
          }
        }
        return;
      }
      await ctx.answerCallbackQuery();
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String(e.message || e).slice(0, 180), show_alert: true });
    }
  });

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const caption = ctx.message.caption || 'Describe this image.';
    await ctx.replyWithChatAction('typing');
    try {
      const file = await downloadTelegramFile(ctx.api, best.file_id);
      file.filename = file.filename.endsWith('.jpg') ? file.filename : 'photo.jpg';
      file.contentType = 'image/jpeg';
      const opts = await sessionOptions(ctx);
      const result = await chatWithFiles(caption, sid(ctx), [file], opts);
      await deliverMedia(ctx, result, opts.tools);
    } catch (e) {
      await ctx.reply(GEMINI_ERROR_MESSAGE);
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || 'Please review this file.';
    await ctx.replyWithChatAction('typing');
    try {
      const file = await downloadTelegramFile(ctx.api, doc.file_id);
      file.filename = doc.file_name || file.filename;
      file.contentType = doc.mime_type || file.contentType;
      const opts = await sessionOptions(ctx);
      const result = await chatWithFiles(caption, sid(ctx), [file], opts);
      await deliverMedia(ctx, result, opts.tools);
    } catch (e) {
      await ctx.reply(GEMINI_ERROR_MESSAGE);
    }
  });

  // Reply-keyboard actions. Register before the generic text-chat handler.
  bot.hears('Model', async (ctx) => {
    try {
      const { models } = await listModels();
      const prefs = await getPrefs(sid(ctx));
      const current = prefs.prefs?.model;
      const kb = new InlineKeyboard();
      kb.text(current ? 'Default' : '✓ Default', 'model:').row();
      for (const m of models || []) {
        const mark = current === m.id ? '✓ ' : '';
        const avail = m.available ? '' : ' (limited)';
        kb.text(`${mark}${m.display_name || m.id}${avail}`, `model:${m.id}`).row();
      }
      await ctx.reply('Pick a model for this chat — Flash or Pro:', { reply_markup: kb });
    } catch {
      await replyWithMenu(ctx, 'I couldn’t load the models right now — try again in a bit.');
    }
  });

  bot.hears('Tools', async (ctx) => {
    try {
      const { tools } = await listTools();
      const prefs = await getPrefs(sid(ctx));
      const t = prefs.prefs?.tools || {};
      const kb = new InlineKeyboard();
      for (const tool of tools || []) {
        const on = !!t[tool.id];
        const stub = tool.supported ? '' : ' · stub';
        kb.text(`${on ? '✓' : '○'} ${tool.label}${stub}`, `tool:${tool.id}`).row();
      }
      await ctx.reply(`${TOOLS_INTRO}\nActive now: ${formatActiveTools(t)}`, { reply_markup: kb });
      await upsertActiveChipsMessage(ctx, t);
    } catch {
      await replyWithMenu(ctx, 'I couldn’t load the tools right now — try again in a bit.');
    }
  });

  bot.hears('New chat', async (ctx) => {
    await replyWithMenu(ctx, await startNewChat(ctx));
  });

  bot.hears('History', async (ctx) => {
    await sendHistoryList(ctx);
  });

  bot.hears('Status', async (ctx) => {
    try {
      const h = await healthCheck();
      const prefs = await getPrefs(sid(ctx));
      const acct = h.account || {};
      await replyWithMenu(ctx, [
        'Here’s what’s on right now:',
        '',
        `Gemini: ${h.ok ? 'connected' : 'not connected'}`,
        `Account: ${acct.status || 'unknown'}${acct.authenticated ? ' · signed in' : ''}`,
        `Model: ${prefs.prefs?.model || 'account default'}`,
        `Tools: ${formatActiveTools(prefs.prefs?.tools || {})}`,
        `Mini App: ${webAppUrl() ? 'ready' : 'not configured'}`,
      ].join('\n'));
    } catch {
      await replyWithMenu(ctx, 'I can’t reach Gemini right now — try again in a bit.');
    }
  });

  bot.hears('Fix', async (ctx) => {
    await sendFixReport(ctx);
  });

  bot.hears('Open app', async (ctx) => {
    const url = webAppUrl();
    if (!url) {
      await replyWithMenu(ctx, 'Mini App URL not configured. Set WEBAPP_URL (see README).');
      return;
    }
    const kb = new InlineKeyboard().webApp('Open Mini App', url);
    await ctx.reply('Opening Mini App…', { reply_markup: kb });
  });

  bot.hears('Admin', async (ctx) => {
    if (!isAdmin(ctx.from)) return;
    const list = listAllowlist();
    const lines = [
      'Here’s the allowlist:',
      ...list.usernames.map((u) => {
        const admin = list.admins.includes(u) ? ' (admin)' : '';
        return `• @${u}${admin}`;
      }),
    ];
    await replyWithMenu(ctx, lines.join('\n'));
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    if (!text || text.startsWith('/')) return;
    let live = null;
    try {
      try {
        await ctx.replyWithChatAction('typing');
      } catch {
        /* typing is optional */
      }
      const placeholder = await ctx.reply(STREAM_PLACEHOLDER);
      live = createLiveReply(ctx, placeholder);
      const opts = await sessionOptions(ctx);
      const createVideo = !!opts.tools?.create_video;
      let typingAt = Date.now();
      let lastPartial = '';
      let result;
      try {
        result = await chatStream(text, sid(ctx), {
          ...opts,
          onPartial: async (partial) => {
            // Create Video keeps the placeholder until the final ready message.
            if (!createVideo && partial) {
              lastPartial = partial;
              live.update(partial);
            }
            if (Date.now() - typingAt > 4000) {
              typingAt = Date.now();
              ctx.replyWithChatAction('typing').catch(() => {});
            }
          },
        });
      } catch (streamErr) {
        // Resend only when Gemini never yielded text. A partial means the turn
        // already started; calling /chat again would duplicate it.
        if (streamErr?.fallback && !streamErr?.partial) {
          console.warn('[bot] stream failed, falling back to /chat', String(streamErr.message || streamErr).slice(0, 180));
          result = await chat(text, sid(ctx), opts);
        } else if (lastPartial) {
          await live.finish(lastPartial);
          return;
        } else {
          throw streamErr;
        }
      }
      await presentChatResult(ctx, result, opts.tools, live);
    } catch (e) {
      console.warn('[bot] text reply failed', String(e?.message || e).slice(0, 180));
      if (live) {
        try {
          await live.finish(GEMINI_ERROR_MESSAGE);
          return;
        } catch {
          /* fall through */
        }
      }
      try {
        await ctx.reply(GEMINI_ERROR_MESSAGE);
      } catch {
        /* ignore */
      }
    }
  });

  bot.catch((err) => {
    console.error('[bot] error', err.error?.message || err);
  });

  return bot;
}

export async function startBot(options = {}) {
  seedAllowlistFromEnv();
  const bot = createBot(options);
  const me = await bot.api.getMe();
  console.log(`[bot] starting @${me.username}`);
  console.log(`[bot] allowlist`, authSummary());

  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Open your private Gemini chat' },
      { command: 'model', description: 'Pick Flash or Pro' },
      { command: 'tools', description: 'Turn tools on or off' },
      { command: 'new', description: 'Start a fresh chat' },
      { command: 'status', description: 'See what’s on right now' },
      { command: 'fix', description: 'Diagnose if the bot isn’t answering' },
      { command: 'app', description: 'Open the Mini App' },
      { command: 'allowed', description: 'Admin: list allowlist' },
      { command: 'allow', description: 'Admin: allow @user or user id' },
      { command: 'deny', description: 'Admin: deny @user or user id' },
    ]);
    console.log('[bot] command menu set');
  } catch (e) {
    console.warn('[bot] setMyCommands failed:', e.message || e);
  }

  const url = webAppUrl();
  if (url) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Gemini', web_app: { url } },
      });
      console.log('[bot] menu button set to Mini App');
    } catch (e) {
      console.warn('[bot] setChatMenuButton failed:', e.message || e);
    }
  }

  bot.start({
    onStart: (info) => console.log(`[bot] polling as @${info.username}`),
  });
  return bot;
}
