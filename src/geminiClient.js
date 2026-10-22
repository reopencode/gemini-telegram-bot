/**
 * Thin HTTP client for the local Python gemini_bridge.
 */
import { bridgeSettings } from './env.js';
import { recordTurn, archiveActive } from './history.js';

/** Archive bookkeeping must never break a chat turn. */
function safeRecord(sessionId, userText, result, extra = '') {
  try {
    const media = (result?.media || []).map((m) => m?.type).filter(Boolean);
    const user = [String(userText || '').trim(), extra].filter(Boolean).join('\n');
    recordTurn(sessionId, user, result?.text, media);
  } catch (e) {
    console.warn('[history] record failed', String(e?.message || e).slice(0, 160));
  }
}

function bridgeUrl() {
  return bridgeSettings().url;
}

export async function healthCheck() {
  const res = await fetch(`${bridgeUrl()}/health`);
  return res.json();
}

export async function listModels() {
  const res = await fetch(`${bridgeUrl()}/models`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

export async function listTools() {
  const res = await fetch(`${bridgeUrl()}/tools`);
  return res.json();
}

export async function getPrefs(sessionId = 'default') {
  const res = await fetch(`${bridgeUrl()}/prefs?session_id=${encodeURIComponent(sessionId)}`);
  return res.json();
}

export async function setPrefs(sessionId, { model, tools, thinkingLevel } = {}) {
  const res = await fetch(`${bridgeUrl()}/prefs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model, tools, thinking_level: thinkingLevel }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

export async function chat(prompt, sessionId = 'default', { model, tools, thinkingLevel } = {}) {
  const res = await fetch(`${bridgeUrl()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, session_id: sessionId, model, tools, thinking_level: thinkingLevel }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error || res.statusText;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  safeRecord(sessionId, prompt, data);
  return data;
}

export async function chatWithFiles(prompt, sessionId, files, { model, tools, thinkingLevel } = {}) {
  const form = new FormData();
  form.append('prompt', prompt || '');
  form.append('session_id', sessionId || 'default');
  if (model) form.append('model', model);
  if (tools != null) form.append('tools_json', JSON.stringify(tools));
  if (thinkingLevel) form.append('thinking_level', thinkingLevel);
  for (const f of files || []) {
    // f: { buffer, filename, contentType }
    const blob = new Blob([f.buffer], { type: f.contentType || 'application/octet-stream' });
    form.append('files', blob, f.filename || 'upload.bin');
  }
  const res = await fetch(`${bridgeUrl()}/chat_upload`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error || res.statusText;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  const names = (files || []).map((f) => `[file: ${f.filename || 'upload'}]`).join(' ');
  safeRecord(sessionId || 'default', prompt, data, names);
  return data;
}

/**
 * Consume POST /chat_stream (newline-delimited JSON).
 * onPartial receives the cumulative reply text so far (not a delta).
 * Throws an Error with `.fallback = true` when the Node side should call chat().
 * `.partial` is true when some text already arrived (do not resend the prompt).
 */
export async function chatStream(prompt, sessionId = 'default', { model, tools, thinkingLevel, onPartial } = {}) {
  let res;
  try {
    res = await fetch(`${bridgeUrl()}/chat_stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify({ prompt, session_id: sessionId, model, tools, thinking_level: thinkingLevel }),
    });
  } catch (e) {
    const err = new Error(e.message || 'bridge stream failed');
    err.fallback = true;
    err.partial = false;
    throw err;
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const detail = data.detail || data.error || res.statusText;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.fallback = true;
    err.partial = false;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finalEvent = null;
  let sawPartial = false;

  const handle = async (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'notice') {
      const note = typeof ev.text === 'string' ? ev.text : '';
      if (note.trim()) {
        sawPartial = true;
        if (onPartial) await onPartial(note);
      }
      return;
    }
    if (ev.type === 'partial') {
      sawPartial = true;
      if (onPartial) await onPartial(typeof ev.text === 'string' ? ev.text : '');
      return;
    }
    if (ev.type === 'final') {
      finalEvent = ev;
      return;
    }
    if (ev.type === 'error') {
      const err = new Error(ev.detail || 'Gemini stream failed');
      err.partial = sawPartial || !!ev.started;
      err.fallback = !err.partial;
      throw err;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        await handle(ev);
      }
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) {
      try {
        await handle(JSON.parse(tail));
      } catch (e) {
        if (e.fallback != null || e.partial != null) throw e;
      }
    }
  } catch (e) {
    if (e.fallback != null) throw e;
    const err = new Error(e.message || 'stream read failed');
    err.partial = sawPartial;
    err.fallback = !sawPartial;
    throw err;
  }

  if (!finalEvent) {
    const err = new Error('stream ended without a final reply');
    err.partial = sawPartial;
    err.fallback = !sawPartial;
    throw err;
  }

  const out = {
    text: finalEvent.text || '',
    session_id: finalEvent.session_id || sessionId,
    model: finalEvent.model ?? model ?? null,
    tools: finalEvent.tools || tools || null,
    thinking_level: finalEvent.thinking_level ?? thinkingLevel ?? null,
    media: Array.isArray(finalEvent.media) ? finalEvent.media : [],
  };
  safeRecord(sessionId, prompt, out);
  return out;
}

export async function resetSession(sessionId = 'default') {
  // Keep the finished conversation as a read-only archive before clearing Gemini's context.
  try {
    archiveActive(sessionId);
  } catch (e) {
    console.warn('[history] archive failed', String(e?.message || e).slice(0, 160));
  }
  const res = await fetch(`${bridgeUrl()}/reset?session_id=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
  });
  return res.json();
}
