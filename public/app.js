import { appendReplyContent } from './videoReply.js';

(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#131314'); tg.setBackgroundColor('#131314'); } catch {}
  }

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const btnNew = document.getElementById('btnNew');
  const btnModel = document.getElementById('btnModel');
  const btnTools = document.getElementById('btnTools');
  const btnAdmin = document.getElementById('btnAdmin');
  const btnAttach = document.getElementById('btnAttach');
  const fileInput = document.getElementById('fileInput');
  const attachPreview = document.getElementById('attachPreview');
  const toolChips = document.getElementById('toolChips');
  const sheet = document.getElementById('sheet');
  const sheetTitle = document.getElementById('sheetTitle');
  const sheetBody = document.getElementById('sheetBody');
  const sheetBackdrop = document.getElementById('sheetBackdrop');
  const authGate = document.getElementById('authGate');
  const authGateMsg = document.getElementById('authGateMsg');

  const initData = tg?.initData || '';
  const unsafeUser = tg?.initDataUnsafe?.user;
  let sessionId = unsafeUser?.id ? `mini-${unsafeUser.id}` : null;
  let busy = false;
  let ws = null;
  let useHttp = false;
  let models = [];
  let toolsCatalog = [];
  let prefs = { model: null, tools: {}, thinking_level: 'medium' };
  const THINKING_LEVELS = ['low', 'medium', 'high'];

  function thinkingLevel() {
    return THINKING_LEVELS.includes(prefs.thinking_level) ? prefs.thinking_level : 'medium';
  }

  function levelLabel(level) {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }

  function toolLabelFor(id, fallback) {
    const base = fallback || id;
    return id === 'extended_thinking' ? `${base} · ${levelLabel(thinkingLevel())}` : base;
  }
  let pendingFiles = [];
  let isAdminUser = false;
  let authed = false;

  function authHeaders(extra = {}) {
    const h = { ...extra };
    if (initData) h['X-Telegram-Init-Data'] = initData;
    return h;
  }

  async function api(path, opts = {}) {
    const headers = authHeaders(opts.headers || {});
    if (opts.json) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || data.error || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showAuthGate(msg) {
    authGate.classList.remove('hidden');
    authGateMsg.textContent = msg || 'Not authorized.';
    statusEl.textContent = 'Unauthorized';
  }

  function addBubble(role, text, extraClass = '', images = [], media = []) {
    const welcome = messagesEl.querySelector('.welcome');
    if (welcome) welcome.remove();
    const row = document.createElement('div');
    row.className = `row ${role}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble ${extraClass}`.trim();
    for (const url of images) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = url;
      bubble.appendChild(img);
    }
    appendReplyContent(bubble, text, media, document);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function showWelcome() {
    messagesEl.innerHTML = '';
    const w = document.createElement('div');
    w.className = 'welcome';
    const name = unsafeUser?.username ? `@${unsafeUser.username}` : 'there';
    w.innerHTML = `<h1>Hello</h1><p>${name} · Ask Gemini · attach photos</p>`;
    messagesEl.appendChild(w);
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v || !authed;
  }

  function modelLabel() {
    const id = prefs.model;
    if (!id) return 'Model';
    const m = models.find((x) => x.id === id);
    return (m?.display_name || id).replace(/^Gemini\s*/i, '') || id;
  }

  function refreshChrome() {
    btnModel.textContent = modelLabel();
    if (isAdminUser) btnAdmin.classList.remove('hidden');
    else btnAdmin.classList.add('hidden');
    renderToolChips();
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

  function activeToolIds() {
    const t = prefs.tools || {};
    return Object.keys(t).filter((id) => !!t[id]);
  }

  function renderToolChips() {
    if (!toolChips) return;
    const active = activeToolIds();
    toolChips.innerHTML = '';
    if (!active.length) {
      toolChips.classList.add('hidden');
      if (statusEl.dataset.base) statusEl.textContent = statusEl.dataset.base;
      return;
    }
    toolChips.classList.remove('hidden');
    for (const id of active) {
      const meta = (toolsCatalog || []).find((t) => t.id === id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-chip ' + ((meta && meta.kind) || (id.startsWith('create_') ? 'media' : 'flag'));
      btn.title = 'Tap to turn off';
      btn.innerHTML = `<span>${toolLabelFor(id, TOOL_LABELS[id] || meta?.label)}</span><span class="x" aria-hidden="true">×</span>`;
      btn.addEventListener('click', async () => {
        const next = { ...(prefs.tools || {}) };
        next[id] = false;
        await savePrefs({ tools: next });
      });
      toolChips.appendChild(btn);
    }
    // Also mirror in status subtitle
    const labels = active.map((id) => toolLabelFor(id, TOOL_LABELS[id]));
    statusEl.textContent = (statusEl.dataset.base || 'Online') + ' · ' + labels.join(' · ');
  }



  function openSheet(title, render) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = '';
    render(sheetBody);
    sheet.classList.remove('hidden');
  }
  function closeSheet() { sheet.classList.add('hidden'); }
  sheetBackdrop.addEventListener('click', closeSheet);

  async function bootstrapAuth() {
    if (!initData) {
      showAuthGate('Open this Mini App from the Telegram bot (missing initData).');
      return false;
    }
    try {
      const me = await api('/api/me');
      authed = true;
      sessionId = me.session_id || sessionId;
      isAdminUser = !!me.isAdmin;
      statusEl.dataset.base = me.user?.username ? `@${me.user.username}` : 'Online';
      statusEl.textContent = statusEl.dataset.base;
      refreshChrome();
      return true;
    } catch (e) {
      showAuthGate(e.data?.detail || e.message || 'Not authorized.');
      return false;
    }
  }

  async function loadMeta() {
    if (!authed) return;
    try {
      const [mRes, tRes, pRes] = await Promise.all([
        api('/api/models'),
        api('/api/tools'),
        api(`/api/prefs`),
      ]);
      models = mRes.models || [];
      toolsCatalog = tRes.tools || [];
      prefs = pRes.prefs || prefs;
      refreshChrome();
    } catch (e) {
      if (e.status === 401) showAuthGate(e.data?.detail || 'Not authorized.');
    }
  }

  async function savePrefs(patch) {
    const data = await api('/api/prefs', { method: 'POST', json: patch });
    if (data.prefs) prefs = data.prefs;
    refreshChrome();
    renderToolChips();
    if (!useHttp && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'prefs', model: prefs.model, tools: prefs.tools, thinking_level: prefs.thinking_level }));
    }
  }

  function renderModelSheet(root) {
    const mk = (label, desc, id, selected) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.innerHTML = `<div><div class="label">${label}</div><div class="desc">${desc || ''}</div></div><div class="meta">${selected ? '✓' : ''}</div>`;
      btn.addEventListener('click', async () => {
        await savePrefs({ model: id || '' });
        closeSheet();
      });
      root.appendChild(btn);
    };
    mk('Account default', 'Let Gemini choose', '', !prefs.model);
    for (const m of models) {
      const avail = m.available ? 'Available' : 'May be limited';
      mk(m.display_name || m.id, `${m.description || ''} · ${avail}`, m.id, prefs.model === m.id);
    }
  }

  function renderToolsSheet(root) {
    for (const tool of toolsCatalog) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'option' + (tool.supported ? '' : ' disabled');
      const on = !!prefs.tools?.[tool.id];
      row.innerHTML = `
        <div>
          <div class="label">${tool.label}${tool.supported ? '' : '<span class="stub-badge">stub</span>'}</div>
          <div class="desc">${tool.description || ''}</div>
        </div>
        <div class="toggle ${on ? 'on' : ''}"></div>`;
      row.addEventListener('click', async () => {
        const next = { ...(prefs.tools || {}) };
        next[tool.id] = !next[tool.id];
        await savePrefs({ tools: next });
        sheetBody.innerHTML = '';
        renderToolsSheet(sheetBody);
      });
      root.appendChild(row);
      if (tool.id === 'extended_thinking' && on) root.appendChild(renderThinkingLevels());
    }
  }

  function renderThinkingLevels() {
    const wrap = document.createElement('div');
    wrap.className = 'level-row';
    const cur = thinkingLevel();
    const lbl = document.createElement('div');
    lbl.className = 'desc';
    lbl.textContent = 'Thinking level';
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const l of THINKING_LEVELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg' + (l === cur ? ' on' : '');
      b.textContent = levelLabel(l);
      b.addEventListener('click', async () => {
        await savePrefs({ thinking_level: l });
        sheetBody.innerHTML = '';
        renderToolsSheet(sheetBody);
      });
      seg.appendChild(b);
    }
    wrap.append(lbl, seg);
    return wrap;
  }

  async function renderAdminSheet(root) {
    root.innerHTML = '<p class="desc">Loading allowlist…</p>';
    try {
      const list = await api('/api/admin/allowlist');
      root.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'desc';
      title.textContent = 'Allowed usernames (you are permanent admin).';
      root.appendChild(title);
      const ul = document.createElement('ul');
      ul.className = 'admin-list';
      for (const u of list.usernames || []) {
        const li = document.createElement('li');
        const isAdm = (list.admins || []).includes(u);
        li.textContent = `@${u}${isAdm ? ' · admin' : ''}`;
        ul.appendChild(li);
      }
      root.appendChild(ul);

      const row = document.createElement('div');
      row.className = 'admin-row';
      const inp = document.createElement('input');
      inp.placeholder = '@username or user id';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ghost';
      addBtn.textContent = 'Allow';
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost';
      delBtn.textContent = 'Deny';
      addBtn.addEventListener('click', async () => {
        await api('/api/admin/allow', { method: 'POST', json: { username: inp.value } });
        renderAdminSheet(root);
      });
      delBtn.addEventListener('click', async () => {
        await api('/api/admin/deny', { method: 'POST', json: { username: inp.value } });
        renderAdminSheet(root);
      });
      row.append(inp, addBtn, delBtn);
      root.appendChild(row);
    } catch (e) {
      root.innerHTML = `<p class="desc">${e.message || e}</p>`;
    }
  }

  function renderAttachPreview() {
    if (!pendingFiles.length) {
      attachPreview.classList.add('hidden');
      attachPreview.innerHTML = '';
      return;
    }
    attachPreview.classList.remove('hidden');
    attachPreview.innerHTML = '';
    pendingFiles.forEach((f, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      if (f.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        chip.appendChild(img);
      }
      const name = document.createElement('span');
      name.textContent = f.name;
      chip.appendChild(name);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.addEventListener('click', () => {
        pendingFiles.splice(idx, 1);
        renderAttachPreview();
      });
      chip.appendChild(x);
      attachPreview.appendChild(chip);
    });
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connectWs() {
    return new Promise((resolve) => {
      if (!authed || !initData) return resolve(false);
      try {
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', initData }));
        };
        ws.onerror = () => {
          useHttp = true;
          resolve(false);
        };
        ws.onclose = () => {
          if (authed) setTimeout(connectWs, 2500);
        };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === 'hello') {
            useHttp = false;
            if (msg.session_id) sessionId = msg.session_id;
            resolve(true);
          }
          if (msg.type === 'error' && msg.error === 'unauthorized') {
            showAuthGate(msg.detail || 'Not authorized.');
            resolve(false);
          }
          if (msg.type === 'reply') {
            const thinking = messagesEl.querySelector('.bubble.thinking');
            if (thinking) thinking.parentElement.remove();
            addBubble('ai', msg.text || '', '', [], msg.media || []);
            setBusy(false);
          }
          if (msg.type === 'error' && msg.error !== 'unauthorized') {
            const thinking = messagesEl.querySelector('.bubble.thinking');
            if (thinking) thinking.parentElement.remove();
            addBubble('ai', msg.error || 'Error', 'error');
            setBusy(false);
          }
          if (msg.type === 'reset_ok') {
            showWelcome();
            setBusy(false);
          }
        };
      } catch {
        useHttp = true;
        resolve(false);
      }
    });
  }

  async function sendHttp(prompt, files) {
    if (files?.length) {
      const fd = new FormData();
      fd.append('prompt', prompt || '');
      fd.append('initData', initData);
      if (prefs.model) fd.append('model', prefs.model);
      fd.append('tools', JSON.stringify(prefs.tools || {}));
      fd.append('tools_json', JSON.stringify(prefs.tools || {}));
      fd.append('thinking_level', thinkingLevel());
      for (const f of files) fd.append('files', f, f.name);
      const res = await fetch('/api/chat_upload', {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || 'upload failed');
      return data;
    }
    const data = await api('/api/chat', {
      method: 'POST',
      json: { prompt, model: prefs.model, tools: prefs.tools, thinking_level: thinkingLevel(), initData },
    });
    return data;
  }

  async function handleSend(prompt) {
    if (!authed || busy) return;
    if (!prompt && !pendingFiles.length) return;
    setBusy(true);
    const files = pendingFiles.slice();
    const previews = files.filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f));
    addBubble('user', prompt || (files.length ? `(${files.length} file${files.length > 1 ? 's' : ''})` : ''), '', previews);
    pendingFiles = [];
    renderAttachPreview();
    addBubble('ai', 'Thinking…', 'thinking');

    if (files.length || useHttp || !ws || ws.readyState !== WebSocket.OPEN) {
      try {
        const data = await sendHttp(prompt, files);
        const thinking = messagesEl.querySelector('.bubble.thinking');
        if (thinking) thinking.parentElement.remove();
        addBubble('ai', data.text || '', '', [], data.media || []);
      } catch (e) {
        const thinking = messagesEl.querySelector('.bubble.thinking');
        if (thinking) thinking.parentElement.remove();
        if (e.status === 401) showAuthGate(e.data?.detail || e.message);
        else addBubble('ai', String(e.message || e), 'error');
      } finally {
        setBusy(false);
      }
      return;
    }

    ws.send(JSON.stringify({ type: 'chat', prompt, model: prefs.model, tools: prefs.tools, thinking_level: thinkingLevel() }));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    input.value = '';
    input.style.height = 'auto';
    handleSend(prompt);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  btnNew.addEventListener('click', async () => {
    if (!authed || busy) return;
    setBusy(true);
    try {
      if (!useHttp && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'reset' }));
      } else {
        await api('/api/reset', { method: 'POST', json: {} });
        showWelcome();
      }
    } finally {
      setBusy(false);
    }
  });

  btnModel.addEventListener('click', () => authed && openSheet('Model', renderModelSheet));
  btnTools.addEventListener('click', () => authed && openSheet('Tools', renderToolsSheet));
  btnAdmin.addEventListener('click', () => authed && openSheet('Admin allowlist', (root) => { renderAdminSheet(root); }));
  btnAttach.addEventListener('click', () => authed && fileInput.click());
  fileInput.addEventListener('change', () => {
    pendingFiles = pendingFiles.concat(Array.from(fileInput.files || []));
    fileInput.value = '';
    renderAttachPreview();
  });

  ;['dragenter', 'dragover'].forEach((ev) => {
    document.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!authed) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) {
      pendingFiles = pendingFiles.concat(files);
      renderAttachPreview();
    }
  });

  (async () => {
    showWelcome();
    setBusy(true);
    const ok = await bootstrapAuth();
    if (!ok) return;
    await loadMeta();
    await connectWs();
    setBusy(false);
  })();
})();
