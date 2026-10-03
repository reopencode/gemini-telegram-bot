import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  chat,
  chatWithFiles,
  healthCheck,
  listModels,
  listTools,
  getPrefs,
  setPrefs,
  resetSession,
} from './geminiClient.js';
import { validateWebAppInitData, authSummary, isAdmin, allowTarget, denyTarget, listAllowlist } from './auth.js';
import { httpListen } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } });

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function extractInitData(req) {
  return (
    req.get('x-telegram-init-data') ||
    req.get('X-Telegram-Init-Data') ||
    req.query?.initData ||
    req.body?.initData ||
    ''
  );
}

function requireMiniAppAuth(req, res, next) {
  const initData = extractInitData(req);
  const result = validateWebAppInitData(initData, botToken());
  if (!result.ok) {
    return res.status(401).json({ error: 'unauthorized', detail: result.error });
  }
  req.tgUser = result.user;
  req.tgSessionId = result.user?.id ? `mini-${result.user.id}` : 'mini-unknown';
  next();
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Public: liveness only (no Gemini). Auth config names only.
  app.get('/api/health', async (_req, res) => {
    try {
      const h = await healthCheck();
      res.json({
        ok: true,
        bridge: h,
        webapp_url: process.env.WEBAPP_URL || null,
        auth: authSummary(),
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  // All Gemini-facing routes require validated Mini App initData
  app.get('/api/models', requireMiniAppAuth, async (_req, res) => {
    try {
      res.json(await listModels());
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/tools', requireMiniAppAuth, async (_req, res) => {
    try {
      res.json(await listTools());
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/prefs', requireMiniAppAuth, async (req, res) => {
    try {
      const sessionId = req.tgSessionId;
      res.json(await getPrefs(sessionId));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/prefs', requireMiniAppAuth, async (req, res) => {
    try {
      const sessionId = req.tgSessionId;
      res.json(await setPrefs(sessionId, { model: req.body?.model, tools: req.body?.tools }));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/chat', requireMiniAppAuth, async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      const sessionId = req.tgSessionId;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      const result = await chat(prompt, sessionId, {
        model: req.body?.model,
        tools: req.body?.tools,
      });
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/chat_upload', requireMiniAppAuth, upload.array('files', 5), async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '');
      const sessionId = req.tgSessionId;
      let tools = req.body?.tools ?? req.body?.tools_json;
      if (typeof tools === 'string') {
        try {
          tools = JSON.parse(tools);
        } catch {
          tools = undefined;
        }
      }
      const files = (req.files || []).map((f) => ({
        buffer: f.buffer,
        filename: f.originalname,
        contentType: f.mimetype,
      }));
      if (!prompt.trim() && files.length === 0) {
        return res.status(400).json({ error: 'prompt or files required' });
      }
      const result = await chatWithFiles(prompt, sessionId, files, {
        model: req.body?.model || undefined,
        tools,
      });
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/reset', requireMiniAppAuth, async (req, res) => {
    try {
      res.json(await resetSession(req.tgSessionId));
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/me', requireMiniAppAuth, (req, res) => {
    res.json({
      ok: true,
      user: {
        id: req.tgUser?.id,
        username: req.tgUser?.username,
        first_name: req.tgUser?.first_name,
      },
      isAdmin: isAdmin(req.tgUser),
      session_id: req.tgSessionId,
    });
  });


  app.get('/api/admin/allowlist', requireMiniAppAuth, (req, res) => {
    if (!isAdmin(req.tgUser)) return res.status(403).json({ error: 'admin only' });
    res.json(listAllowlist());
  });

  app.post('/api/admin/allow', requireMiniAppAuth, (req, res) => {
    if (!isAdmin(req.tgUser)) return res.status(403).json({ error: 'admin only' });
    const raw = req.body?.username || req.body?.userId || req.body?.id || '';
    const result = allowTarget(raw);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/admin/deny', requireMiniAppAuth, (req, res) => {
    if (!isAdmin(req.tgUser)) return res.status(403).json({ error: 'admin only' });
    const raw = req.body?.username || req.body?.userId || req.body?.id || '';
    const result = denyTarget(raw);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  return app;
}

export function startServer() {
  const app = createApp();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let authed = false;
    let sessionId = null;
    let authTimer = setTimeout(() => {
      if (!authed) {
        ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
        ws.close();
      }
    }, 10000);

    // Allow initData via query string
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const q = url.searchParams.get('initData');
      if (q) {
        const result = validateWebAppInitData(q, botToken());
        if (result.ok) {
          authed = true;
          sessionId = `mini-${result.user.id}`;
          clearTimeout(authTimer);
          ws.send(JSON.stringify({ type: 'hello', session_id: sessionId, user: result.user?.username }));
        }
      }
    } catch {
      /* ignore */
    }

    if (!authed) {
      ws.send(JSON.stringify({ type: 'auth_required' }));
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
        return;
      }

      if (msg.type === 'auth') {
        const result = validateWebAppInitData(msg.initData || '', botToken());
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', error: 'unauthorized', detail: result.error }));
          ws.close();
          return;
        }
        authed = true;
        sessionId = `mini-${result.user.id}`;
        clearTimeout(authTimer);
        ws.send(JSON.stringify({ type: 'hello', session_id: sessionId, user: result.user?.username }));
        return;
      }

      if (!authed) {
        ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
        return;
      }

      if (msg.type === 'reset') {
        await resetSession(sessionId);
        ws.send(JSON.stringify({ type: 'reset_ok', session_id: sessionId }));
        return;
      }
      if (msg.type === 'prefs') {
        try {
          const data = await setPrefs(sessionId, { model: msg.model, tools: msg.tools });
          ws.send(JSON.stringify({ type: 'prefs_ok', ...data }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) }));
        }
        return;
      }
      if (msg.type === 'chat') {
        const prompt = String(msg.prompt || '').trim();
        if (!prompt) {
          ws.send(JSON.stringify({ type: 'error', error: 'empty prompt' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));
        try {
          const result = await chat(prompt, sessionId, { model: msg.model, tools: msg.tools });
          ws.send(
            JSON.stringify({
              type: 'reply',
              text: result.text,
              session_id: result.session_id,
              model: result.model,
              media: result.media || [],
            }),
          );
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) }));
        }
      }
    });

    ws.on('close', () => clearTimeout(authTimer));
  });

  const { host, port } = httpListen();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[server] listening on http://${host}:${port}`);
      resolve({ app, server, port });
    });
  });
}
