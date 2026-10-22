"""
HTTP bridge to unofficial gemini_webapi using browser session cookies.
Personal / research use only — fragile and may violate Google ToS.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from gemini_webapi import GeminiClient
from gemini_webapi.constants import AccountStatus

from envfile import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent
COOKIES_PATH = Path(os.environ.get("GEMINI_COOKIES_PATH", ROOT / ".cookies.json"))
PREFS_PATH = Path(os.environ.get("GEMINI_PREFS_PATH", ROOT / "data" / "prefs.json"))
UPLOAD_DIR = ROOT / "uploads"
MEDIA_DIR = ROOT / "public" / "media"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)

# Tools shown in the UI. Thinking is not a tool: it is a per-chat level.
SUPPORTED_TOOLS = [
    {
        "id": "create_image",
        "label": "Create Image",
        "description": "Steer Gemini to generate images (prompt-based; library parses GeneratedImage).",
        "supported": True,
        "kind": "media",
    },
    {
        "id": "create_video",
        "label": "Create Video",
        "description": "Steer Gemini to generate video (may be slow / plan-limited).",
        "supported": True,
        "kind": "media",
    },
    {
        "id": "create_music",
        "label": "Create Music",
        "description": "Steer Gemini to generate music/audio (GeneratedMedia when available).",
        "supported": True,
        "kind": "media",
    },
]
TOOL_IDS = tuple(t["id"] for t in SUPPORTED_TOOLS)
MEDIA_TOOL_IDS = TOOL_IDS

THINKING_LEVELS = ["low", "medium", "high"]
DEFAULT_THINKING_LEVEL = "medium"

# gemini_webapi only has an on/off `extended_thinking` flag (request payload index 80).
# The level is always applied: Low uses the standard mode, Medium and High use
# extended thinking. Low and High also steer the prompt; Medium adds nothing.
THINKING_EXTENDED = {"low": False, "medium": True, "high": True}
THINKING_PROMPT_PREFIX = {
    "low": "Reason briefly, then answer concisely.\n\n",
    "medium": "",
    "high": "Reason step by step and double-check your work before answering.\n\n",
}


def normalize_thinking_level(level: Any) -> str:
    level = str(level or "").strip().lower()
    return level if level in THINKING_LEVELS else DEFAULT_THINKING_LEVEL


DEFAULT_PREFS = {
    "model": None,
    "thinking_level": DEFAULT_THINKING_LEVEL,
    "tools": {tool_id: False for tool_id in TOOL_IDS},
}

MEDIA_PROMPT_PREFIX = {
    "create_image": (
        "GENERATE an image (create a visual image, not just a text description) for the following request:\n\n"
    ),
    "create_video": (
        "Generate a short video (moving visuals) for the following request:\n\n"
    ),
    "create_music": (
        "Generate a piece of music / audio track (not just lyrics text) for the following request:\n\n"
    ),
}

app = FastAPI(title="Gemini Web Bridge", version="0.2.0")
_client: Optional[GeminiClient] = None
_client_lock = asyncio.Lock()
_chats: dict[str, Any] = {}


_prefs_cache: dict | None = None
_prefs_stamp: tuple[int, int] | None = None


def _prefs_file_stamp() -> tuple[int, int] | None:
    try:
        st = PREFS_PATH.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _load_prefs() -> dict:
    """All sessions' prefs. Re-read only when the file changed on disk."""
    global _prefs_cache, _prefs_stamp
    stamp = _prefs_file_stamp()
    if _prefs_cache is not None and stamp == _prefs_stamp:
        return _prefs_cache
    data: dict = {}
    if stamp is not None:
        try:
            loaded = json.loads(PREFS_PATH.read_text())
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            data = {}
    _prefs_cache, _prefs_stamp = data, stamp
    return data


def _save_prefs(data: dict) -> None:
    global _prefs_cache, _prefs_stamp
    tmp = PREFS_PATH.with_name(f"{PREFS_PATH.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(PREFS_PATH)
    _prefs_cache, _prefs_stamp = data, _prefs_file_stamp()


def get_session_prefs(session_id: str) -> dict:
    prefs = _load_prefs().get(session_id) or {}
    saved_tools = prefs.get("tools") or {}
    return {
        "model": prefs.get("model", DEFAULT_PREFS["model"]),
        "thinking_level": normalize_thinking_level(prefs.get("thinking_level")),
        # Only current tools; keys left from older versions (thinking, search...) are dropped.
        "tools": {t: bool(saved_tools.get(t, False)) for t in TOOL_IDS},
    }


def set_session_prefs(
    session_id: str,
    *,
    model: str | None = None,
    tools: dict | None = None,
    thinking_level: str | None = None,
) -> dict:
    """Merge any of model / tools / level and write at most once."""
    cur = get_session_prefs(session_id)
    new = {**cur, "tools": dict(cur["tools"])}
    if model is not None:
        new["model"] = model or None
    if thinking_level is not None:
        new["thinking_level"] = normalize_thinking_level(thinking_level)
    if tools is not None:
        new["tools"].update({k: bool(v) for k, v in tools.items() if k in TOOL_IDS})
    if new != cur or session_id not in _load_prefs():
        _save_prefs({**_load_prefs(), session_id: new})
    return new


def _load_cookies() -> tuple[str, str]:
    if not COOKIES_PATH.exists():
        raise RuntimeError(
            f"Missing cookies file at {COOKIES_PATH}. Run: npm run extract-cookies"
        )
    data = json.loads(COOKIES_PATH.read_text())
    psid = data.get("__Secure-1PSID") or data.get("Secure_1PSID")
    psidts = data.get("__Secure-1PSIDTS") or data.get("Secure_1PSIDTS") or ""
    if not psid:
        raise RuntimeError("__Secure-1PSID missing from cookies file")
    return psid, psidts


def _client_alive(client) -> bool:
    """False once GeminiClient.close() has dropped the shared session.

    Duck-typed fakes that have no inner session are left alone. Replacing a
    closed client is how the next turn recovers; this helper never closes one.
    """
    if client is None:
        return False
    if getattr(client, "_running", True) is False:
        return False
    try:
        inner = client.client
    except AttributeError:
        return True
    return inner is not None


async def get_client() -> GeminiClient:
    global _client
    if _client_alive(_client):
        return _client
    async with _client_lock:
        if _client_alive(_client):
            return _client
        if _client is not None:
            # The library closes this session on its own watchdog and on some
            # API errors. Drop the dead object so other turns can reconnect.
            print("[bridge] shared Gemini client is closed; opening a new one")
            _client = None
        psid, psidts = _load_cookies()
        client = GeminiClient(psid, psidts or None)
        await client.init(
            timeout=float(os.environ.get("GEMINI_TIMEOUT", "180")),
            auto_refresh=True,
            auto_close=False,
        )
        _client = client
        return client


def _serialize_models(client: GeminiClient) -> list[dict]:
    models = client.list_models() or []
    out = []
    for m in models:
        out.append(
            {
                "id": m.model_name,
                "name": m.model_name,
                "display_name": m.display_name or m.model_name,
                "description": m.description or "",
                "available": bool(m.is_available),
                "aliases": list(m.aliases or [])[:12],
            }
        )
    # Always include static enum fallbacks if registry empty
    if not out:
        from gemini_webapi.constants import Model

        for m in Model:
            if m.name == "UNSPECIFIED":
                continue
            out.append(
                {
                    "id": m.model_name,
                    "name": m.model_name,
                    "display_name": m.model_name,
                    "description": "Static model header (enum fallback)",
                    "available": not m.advanced_only,
                    "aliases": [],
                }
            )
    return out


MODELS_TTL_SECONDS = 60.0
_models_cache: tuple[int, float, list[dict]] | None = None


def _cached_models(client: GeminiClient) -> list[dict]:
    global _models_cache
    now = time.monotonic()
    if (
        _models_cache is not None
        and _models_cache[0] == id(client)
        and now - _models_cache[1] < MODELS_TTL_SECONDS
    ):
        return _models_cache[2]
    out = _serialize_models(client)
    _models_cache = (id(client), now, out)
    return out


def _account_info(client: GeminiClient) -> dict:
    status = client.account_status
    name = getattr(status, "name", str(status))
    return {
        "status": name,
        "authenticated": name == AccountStatus.AVAILABLE.name,
        "description": getattr(status, "description", ""),
    }


class ChatRequest(BaseModel):
    prompt: str = Field(default="", max_length=32000)
    session_id: str = Field(default="default", max_length=128)
    model: str | None = None
    tools: dict[str, bool] | None = None
    thinking_level: str | None = None


class PrefsRequest(BaseModel):
    session_id: str = Field(default="default", max_length=128)
    model: str | None = None
    tools: dict[str, bool] | None = None
    thinking_level: str | None = None


class MediaItem(BaseModel):
    type: str  # image | video | audio
    filename: str
    url: str  # /media/... for Mini App
    path: str  # absolute path for Telegram bot
    title: str = ""
    mime: str = ""


class ChatResponse(BaseModel):
    text: str
    session_id: str
    model: str | None = None
    tools: dict[str, bool] | None = None
    thinking_level: str | None = None
    media: list[MediaItem] = []
    # True when an explicit model failed and this reply came from the default model.
    fallback: bool = False


@app.on_event("startup")
async def startup():
    # Warm the client in the background so the HTTP server accepts requests immediately
    # and a 429 / transient auth issue never blocks startup.
    app.state.startup_error = None

    async def warm():
        try:
            await get_client()
        except Exception as e:
            app.state.startup_error = str(e)

    app.state.warm_task = asyncio.create_task(warm())


@app.get("/health")
async def health():
    info = {}
    if _client is not None:
        info = _account_info(_client)
    return {
        "ok": True,
        "client_ready": _client is not None,
        "cookies_present": COOKIES_PATH.exists(),
        "startup_error": getattr(app.state, "startup_error", None),
        "account": info,
    }


def _deep_health_timeout() -> float:
    """Short bound for the quota probe. Invalid or non-positive values fall back to 15s."""
    raw = os.environ.get("GEMINI_DEEP_HEALTH_TIMEOUT", "15")
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        return 15.0
    return timeout if timeout > 0 else 15.0


def _account_status_name(client) -> str:
    if client is None:
        return ""
    try:
        return str(_account_info(client).get("status") or "")
    except Exception:
        return ""


def _failure_is_unauthenticated(exc: BaseException, client) -> bool:
    """Expired cookies are not a stale-connection failure. Timeouts are."""
    if isinstance(exc, TimeoutError):
        return False
    if "timeout" in type(exc).__name__.lower():
        return False
    if _account_status_name(client) == AccountStatus.UNAUTHENTICATED.name:
        return True
    if "auth" in type(exc).__name__.lower():
        return True
    text = str(exc).lower()
    return "unauthenticated" in text or "permission denied" in text


def _safe_account(client) -> dict | None:
    """Status only. Never include cookie values or exception text."""
    if client is None:
        return None
    try:
        info = _account_info(client)
    except Exception:
        return None
    return {
        "status": info.get("status"),
        "authenticated": bool(info.get("authenticated")),
    }


async def probe_google_quota(client, timeout: float) -> None:
    """One cheap quota RPC through the existing client.

    Uses the same CHECK_QUOTA call as gemini_webapi's extra-quota fetch.
    Does not start a chat or send a prompt. `timeout` is per-request so a
    dead connection fails without lowering the timeout of in-flight chats.
    """
    batch = getattr(client, "_batch_execute", None)
    if batch is not None:
        from gemini_webapi.constants import GRPC
        from gemini_webapi.types import RPCData

        rpc_id = GRPC.CHECK_QUOTA
        response = await batch([RPCData(rpcid=rpc_id, payload="[]")], timeout=timeout)
        parser = getattr(client, "_parse_rpc_results", None)
        text = getattr(response, "text", "") if response is not None else ""
        if parser is not None and text:
            for _part in parser(text, rpc_id):
                pass
        return

    extra = getattr(client, "_fetch_extra_quota", None)
    if extra is not None:
        await extra()
        return
    activity = getattr(client, "_sync_activity", None)
    if activity is not None:
        await activity()
        return
    quota = getattr(client, "_fetch_quota", None)
    if quota is not None:
        await quota()
        return
    raise RuntimeError("gemini client has no quota probe")


def _deep_health_body(ok: bool, reason: str, client=None, stale: bool | None = None) -> dict:
    body: dict[str, Any] = {"ok": ok, "reason": reason}
    if stale is not None:
        body["stale"] = stale
    account = _safe_account(client)
    if account is not None:
        body["account"] = account
    return body


@app.get("/health/deep")
async def health_deep():
    """Real Google round-trip. Shallow /health stays local and can stay green on a dead socket."""
    timeout = _deep_health_timeout()
    client: GeminiClient | None = None

    async def run():
        nonlocal client
        client = await get_client()
        await probe_google_quota(client, timeout)

    try:
        await asyncio.wait_for(run(), timeout)
    except TimeoutError:
        print("[bridge] deep health timed out")
        return JSONResponse(status_code=503, content=_deep_health_body(False, "timeout"))
    except Exception as e:
        if _failure_is_unauthenticated(e, client):
            return _deep_health_body(True, "unauthenticated", client, stale=False)
        # Type name only — exception text can echo request headers, including cookies.
        print(f"[bridge] deep health probe failed: {type(e).__name__}")
        return JSONResponse(status_code=503, content=_deep_health_body(False, "probe_failed"))

    if _account_status_name(client) == AccountStatus.UNAUTHENTICATED.name:
        return _deep_health_body(True, "unauthenticated", client, stale=False)
    return _deep_health_body(True, "ok", client, stale=False)


@app.get("/models")
async def models():
    try:
        client = await get_client()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Gemini client unavailable: {e}") from e
    return {"models": _cached_models(client), "account": _account_info(client)}


@app.get("/tools")
async def tools():
    return {
        "tools": SUPPORTED_TOOLS,
        "thinking": {"levels": THINKING_LEVELS, "default": DEFAULT_THINKING_LEVEL},
    }


@app.get("/prefs")
async def prefs_get(session_id: str = "default"):
    return {"session_id": session_id, "prefs": get_session_prefs(session_id)}


@app.post("/prefs")
async def prefs_set(req: PrefsRequest):
    prefs = set_session_prefs(
        req.session_id,
        model=req.model,
        tools=req.tools,
        thinking_level=req.thinking_level,
    )
    # Changing model mid-chat: reset chat so next message uses new model cleanly
    if req.model is not None:
        _chats.pop(req.session_id, None)
    return {"session_id": req.session_id, "prefs": prefs}



def _steer_prompt(prompt: str, tools: dict, thinking_level: str | None = None) -> str:
    """Best-effort Android-like Create Image/Video/Music via prompt steering.

    Without a media tool the thinking level adds its reasoning prefix (medium
    adds none). With a media tool the prompt is the generation request, so the
    reasoning prefix is skipped; the level still sets the extended-thinking flag.
    """
    p = (prompt or "").strip()
    # Priority if multiple media tools on: image > video > music
    for key in ("create_image", "create_video", "create_music"):
        if tools.get(key):
            prefix = MEDIA_PROMPT_PREFIX[key]
            # Avoid double-prefixing
            if p.lower().startswith("generate an image") or p.lower().startswith("generate a short video") or p.lower().startswith("generate a piece of music"):
                return p
            return prefix + (p or "a creative result")
    prefix = THINKING_PROMPT_PREFIX.get(normalize_thinking_level(thinking_level), "")
    return prefix + p if prefix and p else p


async def _collect_media(result) -> list[MediaItem]:
    """Save generated images/videos/audio from ModelOutput to public/media."""
    items: list[MediaItem] = []
    if result is None:
        return items
    try:
        cand = result.candidates[result.chosen] if getattr(result, "candidates", None) else None
    except Exception:
        cand = None
    if cand is None:
        return items

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    async def save_one(obj, kind: str, default_mime: str, prefer_attr: str | None = None):
        nonlocal items
        try:
            ext = { "image": ".png", "video": ".mp4", "audio": ".mp3" }.get(kind, ".bin")
            # Prefer mp3 for music when available
            if kind == "audio" and getattr(obj, "mp3_url", None):
                # GeneratedMedia.save may use video url; download mp3 directly if needed
                pass
            fname = f"{uuid.uuid4().hex}{ext}"
            # Image.save / Video.save write under path/
            saved = await obj.save(path=str(MEDIA_DIR), filename=fname, verbose=False)
            if not saved:
                return
            path = Path(saved)
            # If library used a different suffix, rename to our uuid name when possible
            if path.name != fname and path.exists():
                target = MEDIA_DIR / fname
                try:
                    path.replace(target)
                    path = target
                except Exception:
                    fname = path.name
            mime = mimetypes.guess_type(str(path))[0] or default_mime
            title = getattr(obj, "title", "") or ""
            items.append(
                MediaItem(
                    type=kind,
                    filename=path.name,
                    url=f"/media/{path.name}",
                    path=str(path.resolve()),
                    title=title,
                    mime=mime,
                )
            )
        except Exception as e:
            # Keep going; text reply still useful
            print(f"[bridge] media save failed ({kind}): {e}")

    for img in getattr(cand, "generated_images", None) or []:
        await save_one(img, "image", "image/png")
    for vid in getattr(cand, "generated_videos", None) or []:
        await save_one(vid, "video", "video/mp4")
    for med in getattr(cand, "generated_media", None) or []:
        # Music often has mp3_url; try save() which handles GeneratedMedia
        kind = "audio" if getattr(med, "mp3_url", None) and not getattr(med, "url", None) else (
            "audio" if getattr(med, "mp3_url", None) else "video"
        )
        # Prefer downloading mp3 when present
        if getattr(med, "mp3_url", None):
            try:
                import httpx
                fname = f"{uuid.uuid4().hex}.mp3"
                dest = MEDIA_DIR / fname
                async with httpx.AsyncClient(timeout=120, follow_redirects=True) as hx:
                    r = await hx.get(med.mp3_url)
                    r.raise_for_status()
                    dest.write_bytes(r.content)
                items.append(
                    MediaItem(
                        type="audio",
                        filename=fname,
                        url=f"/media/{fname}",
                        path=str(dest.resolve()),
                        title=getattr(med, "title", "") or "",
                        mime="audio/mpeg",
                    )
                )
                continue
            except Exception as e:
                print(f"[bridge] mp3 download failed: {e}")
        await save_one(med, kind, "audio/mpeg" if kind == "audio" else "video/mp4")

    return items


VIDEO_READY_TEXT = "Your video is ready!"


def _remove_video_file(path: str) -> None:
    """Generated videos must not remain where the Mini App can fetch them."""
    file = Path(path)
    try:
        file.unlink(missing_ok=True)
    except Exception:
        pass
    if not file.exists():
        return
    private = ROOT / "data" / "private-video"
    try:
        private.mkdir(parents=True, exist_ok=True)
        dest = private / file.name
        file.replace(dest)
        dest.unlink(missing_ok=True)
    except Exception:
        pass


def _withhold_videos(text: str, media_items: list[MediaItem]) -> tuple[str, list[MediaItem]]:
    """Do not deliver generated videos. Delete the files and return a short notice."""
    videos = [m for m in media_items if m.type == "video"]
    if not videos:
        return text, media_items
    for m in videos:
        _remove_video_file(m.path)
    return VIDEO_READY_TEXT, []


def merge_stream_text(accumulated: str, output) -> str:
    """Fold one streamed ModelOutput into the full text so far.

    Verified in gemini_webapi ChatSession.send_message_stream →
    generate_content_stream (client.py) and get_delta_by_fp_len:

    - ModelOutput.text is the current frame's snapshot: the provider's full
      text so far (raw), not a delta. Non-final frames can carry trailing
      flicker that a later snapshot trims.
    - ModelOutput.text_delta is only the new characters since the previous
      yield.

    Prefer the snapshot when it extends, trims, or replaces the running text.
    Append text_delta only when the snapshot is missing or not a plausible
    full-text update.
    """
    snapshot = getattr(output, "text", None) or ""
    delta = getattr(output, "text_delta", None) or ""
    if not isinstance(snapshot, str):
        snapshot = str(snapshot)
    if not isinstance(delta, str):
        delta = str(delta)
    acc = accumulated or ""
    if snapshot:
        if not acc or snapshot.startswith(acc) or acc.startswith(snapshot):
            return snapshot
        prefix = 0
        limit = min(len(snapshot), len(acc))
        while prefix < limit and snapshot[prefix] == acc[prefix]:
            prefix += 1
        if prefix >= min(20, len(acc)) or len(snapshot) >= len(acc):
            return snapshot
    if delta:
        return acc + delta
    return acc


def _ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _clean_reply_text(text: str) -> str:
    if text and text.strip().startswith("_") and len(text.strip()) < 12:
        return ""
    return text or ""


# Short junk replies seen when an explicitly chosen model fails.
_GENERIC_FAILURES = (
    "sorry, something went wrong",
    "i encountered an error doing what you asked",
    "unknown api error code: 1097",
)
FALLBACK_NOTE = "The selected model failed, so this reply used the default model.\n\n"
TURN_STOPPED_MESSAGE = "This turn took too long and was stopped. Please try again."
_STREAM_END = object()


class TurnBudgetExceeded(Exception):
    """The per-turn deadline fired. The shared Gemini client is not closed."""


def _turn_timeout() -> float:
    """Overall cap for one turn, including a single default-model retry."""
    raw = os.environ.get("TURN_TIMEOUT", "240")
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        return 240.0
    return timeout if timeout > 0 else 240.0


def _is_generic_failure(text: str) -> bool:
    cleaned = " ".join((text or "").split())
    if not cleaned or len(cleaned) > 400:
        return False
    low = cleaned.lower()
    return any(snippet in low for snippet in _GENERIC_FAILURES)


def _result_text(result) -> str:
    if result is None:
        return ""
    raw = getattr(result, "text", None)
    if not isinstance(raw, str):
        raw = str(result)
    return _clean_reply_text(raw)


def _can_fallback(prepared: dict) -> bool:
    return bool(prepared.get("use_model")) and not prepared.get("fell_back")


def _needs_text_fallback(prepared: dict, text: str, media: list) -> bool:
    if not _can_fallback(prepared):
        return False
    if media:
        return False
    cleaned = (text or "").strip()
    if not cleaned:
        return True
    return _is_generic_failure(cleaned)


def _prefix_fallback_note(text: str) -> str:
    body = text or ""
    if body.startswith(FALLBACK_NOTE):
        return body
    return FALLBACK_NOTE + body


def _visible_text(prepared: dict, text: str) -> str:
    if prepared.get("fell_back"):
        return _prefix_fallback_note(text)
    return text or ""


def _timeout_text(prepared: dict) -> str:
    if prepared.get("fell_back"):
        return _prefix_fallback_note(TURN_STOPPED_MESSAGE)
    return TURN_STOPPED_MESSAGE


async def _await_bounded(awaitable, deadline: float):
    """Wait until `deadline`. Cancel this attempt only — never the shared client."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise TurnBudgetExceeded()
    task = asyncio.ensure_future(awaitable)
    try:
        done, _pending = await asyncio.wait({task}, timeout=remaining)
    except asyncio.CancelledError:
        task.cancel()
        raise
    if task in done:
        return task.result()
    task.cancel()

    def _drain(finished: asyncio.Task) -> None:
        try:
            finished.exception()
        except (asyncio.CancelledError, Exception):
            pass

    task.add_done_callback(_drain)
    raise TurnBudgetExceeded()


async def _next_stream_item(agen, deadline: float):
    async def pull():
        try:
            return await agen.__anext__()
        except StopAsyncIteration:
            return _STREAM_END

    return await _await_bounded(pull(), deadline)


async def _quiet_aclose(agen) -> None:
    aclose = getattr(agen, "aclose", None)
    if aclose is None:
        return
    try:
        await aclose()
    except (Exception, asyncio.CancelledError):
        pass


async def _retry_with_default(prepared: dict) -> dict:
    """One new chat on the default model. Does not change the saved preference."""
    client = prepared.get("client")
    if not _client_alive(client):
        client = await get_client()
    session_id = prepared["session_id"]
    _chats.pop(session_id, None)
    chat = client.start_chat()
    _chats[session_id] = chat
    print(
        f"[bridge] model {prepared.get('use_model')} failed; "
        "retrying once with the default model"
    )
    return {
        **prepared,
        "client": client,
        "chat": chat,
        "use_model": None,
        "fell_back": True,
    }


def _chat_response(prepared: dict, text: str, media: list) -> ChatResponse:
    return ChatResponse(
        text=text or "",
        session_id=prepared["session_id"],
        model=prepared.get("use_model"),
        tools=prepared["tools_out"],
        thinking_level=prepared["thinking_level"],
        media=media,
        fallback=bool(prepared.get("fell_back")),
    )


def _final_event(prepared: dict, text: str, media: list) -> dict:
    return {
        "type": "final",
        "text": text or "",
        "session_id": prepared["session_id"],
        "model": prepared.get("use_model"),
        "tools": prepared["tools_out"],
        "thinking_level": prepared["thinking_level"],
        "media": [m.model_dump() for m in media],
        "fallback": bool(prepared.get("fell_back")),
    }


def _fallback_failed_response(prepared: dict) -> ChatResponse:
    failed = {**prepared, "fell_back": True, "use_model": None}
    return _chat_response(
        failed,
        _prefix_fallback_note("The default model also failed. Please try again."),
        [],
    )


async def _prepare_turn(
    *,
    prompt: str,
    session_id: str,
    model: str | None,
    tools: dict[str, bool] | None,
    file_paths: list[Path] | None = None,
    thinking_level: str | None = None,
) -> dict:
    """Shared session / prefs / model / tools setup for /chat and /chat_stream."""
    try:
        client = await get_client()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Gemini client unavailable: {e}") from e

    prefs = set_session_prefs(
        session_id, model=model, tools=tools, thinking_level=thinking_level
    )

    use_model = prefs.get("model") or None
    t = prefs.get("tools") or {}

    # Soft fallback: advanced models require AVAILABLE auth; keep chat usable
    # (tools still apply) when cookies are guest/unauthenticated.
    try:
        acct = _account_info(client)
        if use_model and not acct.get("authenticated"):
            print(f"[bridge] model {use_model} skipped — account {acct.get('status')}; using default")
            use_model = None
    except Exception:
        pass

    prompt = (prompt or "").strip()
    if not prompt and not file_paths:
        raise HTTPException(status_code=400, detail="Empty prompt")
    if not prompt:
        prompt = "Please review the attached file(s) and respond helpfully."

    thinking_level_out = normalize_thinking_level(prefs.get("thinking_level"))
    prompt = _steer_prompt(prompt, t, thinking_level_out)
    request_thinking = THINKING_EXTENDED[thinking_level_out]

    files_arg: list | None = None
    if file_paths:
        files_arg = [str(p) for p in file_paths]

    chat = _chats.get(session_id)
    if chat is None:
        chat = client.start_chat(model=use_model) if use_model else client.start_chat()
        _chats[session_id] = chat
    elif use_model and getattr(chat, "model", None) not in (use_model, None):
        chat = client.start_chat(model=use_model)
        _chats[session_id] = chat

    kwargs: dict[str, Any] = {
        "temporary": False,
        "extended_thinking": request_thinking,
    }
    if files_arg:
        kwargs["files"] = files_arg

    tools_out = {
        "create_image": bool(t.get("create_image")),
        "create_video": bool(t.get("create_video")),
        "create_music": bool(t.get("create_music")),
    }
    print(
        f"[bridge] turn session={session_id} model={use_model or 'default'} "
        f"thinking={thinking_level_out} extended_thinking={request_thinking} "
        f"tools={[k for k, v in tools_out.items() if v]}"
    )
    return {
        "chat": chat,
        "client": client,
        "prompt": prompt,
        "kwargs": kwargs,
        "use_model": use_model,
        "session_id": session_id,
        "tools_out": tools_out,
        "thinking_level": thinking_level_out,
        "fell_back": False,
    }


async def _finish_model_output(result, text: str, deadline: float):
    """Collect media within the turn budget. Returns (text, media) or raises TurnBudgetExceeded."""
    try:
        media_items = await _await_bounded(_collect_media(result), deadline)
    except TurnBudgetExceeded:
        media_items = []
        if not (text or "").strip():
            raise
    except Exception as media_err:
        print(f"[bridge] media collect failed: {type(media_err).__name__}")
        media_items = []
    if not text and media_items:
        text = f"(generated {len(media_items)} media file(s))"
    return _withhold_videos(text, media_items)


async def _run_chat(
    *,
    prompt: str,
    session_id: str,
    model: str | None,
    tools: dict[str, bool] | None,
    file_paths: list[Path] | None = None,
    thinking_level: str | None = None,
) -> ChatResponse:
    """One-shot turn used by /chat and /chat_upload.

    An explicit model that errors, times out, is empty, or returns a known
    generic failure is retried once on the default model. The saved preference
    is not changed. A hung turn stops at TURN_TIMEOUT without closing the client.
    """
    try:
        prepared = await _prepare_turn(
            prompt=prompt,
            session_id=session_id,
            model=model,
            tools=tools,
            file_paths=file_paths,
            thinking_level=thinking_level,
        )
        deadline = time.monotonic() + _turn_timeout()
        while True:
            try:
                result = await _await_bounded(
                    prepared["chat"].send_message(prepared["prompt"], **prepared["kwargs"]),
                    deadline,
                )
            except TurnBudgetExceeded:
                return _chat_response(prepared, _timeout_text(prepared), [])
            except HTTPException:
                raise
            except Exception as e:
                if _can_fallback(prepared):
                    try:
                        prepared = await _retry_with_default(prepared)
                    except Exception as retry_err:
                        print(f"[bridge] default-model retry failed: {type(retry_err).__name__}")
                        return _fallback_failed_response(prepared)
                    continue
                if prepared.get("fell_back"):
                    print(f"[bridge] default-model retry failed: {type(e).__name__}")
                    return _fallback_failed_response(prepared)
                raise HTTPException(status_code=502, detail=f"Gemini request failed: {e}") from e

            text = _result_text(result)
            try:
                text, media_items = await _finish_model_output(result, text, deadline)
            except TurnBudgetExceeded:
                return _chat_response(prepared, _timeout_text(prepared), [])
            if _needs_text_fallback(prepared, text, media_items):
                try:
                    prepared = await _retry_with_default(prepared)
                except Exception:
                    print("[bridge] default-model retry failed")
                    return _fallback_failed_response(prepared)
                continue
            return _chat_response(prepared, _visible_text(prepared, text), media_items)
    except HTTPException:
        raise
    finally:
        if file_paths:
            for p in file_paths:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass


@app.post("/chat_stream")
async def chat_stream(req: ChatRequest):
    """Newline-delimited JSON stream of the same turn as /chat.

    Events:
      {"type":"partial","text":"<full text so far>"}
      {"type":"notice","text":"...","fallback":true}
      {"type":"final","text":"...","media":[...],"session_id","model","tools","fallback"}
      {"type":"error","detail":"...","started":bool}

    An explicit model that errors, times out, is empty, or returns a known
    generic failure is retried once on the default model. The notice and the
    reply text both say so. A hung turn ends as a final message at TURN_TIMEOUT
    so the client does not resend; the shared Gemini client is not closed.

    Failures before the body starts are normal HTTP errors so the Node client
    can fall back to POST /chat. Failures after the stream opens are a final
    error event (started=false when Gemini yielded nothing yet).
    """
    prepared = await _prepare_turn(
        prompt=req.prompt,
        session_id=req.session_id,
        model=req.model,
        tools=req.tools,
        file_paths=None,
        thinking_level=req.thinking_level,
    )

    deadline = time.monotonic() + _turn_timeout()

    async def gen():
        current = prepared
        while True:
            agen = current["chat"].send_message_stream(current["prompt"], **current["kwargs"])
            acc = ""
            last = None
            abandon = False
            try:
                while True:
                    item = await _next_stream_item(agen, deadline)
                    if item is _STREAM_END:
                        break
                    last = item
                    new_acc = merge_stream_text(acc, item)
                    if new_acc != acc:
                        acc = new_acc
                        # Video is not delivered. Keep the placeholder until the ready notice.
                        if not current["tools_out"].get("create_video"):
                            yield _ndjson({"type": "partial", "text": _visible_text(current, acc)})
                text = _clean_reply_text(acc)
                try:
                    text, media_items = await _finish_model_output(last, text, deadline)
                except TurnBudgetExceeded:
                    abandon = True
                    yield _ndjson(_final_event(current, _timeout_text(current), []))
                    return
                if _needs_text_fallback(current, text, media_items):
                    try:
                        current = await _retry_with_default(current)
                    except Exception:
                        print("[bridge] default-model retry failed")
                        yield _ndjson(_final_event(
                            {**current, "fell_back": True, "use_model": None},
                            _prefix_fallback_note("The default model also failed. Please try again."),
                            [],
                        ))
                        return
                    yield _ndjson(
                        {"type": "notice", "text": FALLBACK_NOTE.strip(), "fallback": True}
                    )
                    continue
                yield _ndjson(_final_event(current, _visible_text(current, text), media_items))
                return
            except TurnBudgetExceeded:
                # Stop this attempt. Do not close the shared client, and do not
                # start another long retry — the turn budget is already spent.
                abandon = True
                yield _ndjson(_final_event(current, _timeout_text(current), []))
                return
            except Exception as e:
                if _can_fallback(current):
                    try:
                        current = await _retry_with_default(current)
                    except Exception as retry_err:
                        print(f"[bridge] default-model retry failed: {type(retry_err).__name__}")
                        yield _ndjson(_final_event(
                            {**current, "fell_back": True, "use_model": None},
                            _prefix_fallback_note("The default model also failed. Please try again."),
                            [],
                        ))
                        return
                    yield _ndjson(
                        {"type": "notice", "text": FALLBACK_NOTE.strip(), "fallback": True}
                    )
                    continue
                if current.get("fell_back"):
                    print(f"[bridge] default-model retry failed: {type(e).__name__}")
                    yield _ndjson(_final_event(
                        current,
                        _prefix_fallback_note("The default model also failed. Please try again."),
                        [],
                    ))
                    return
                yield _ndjson(
                    {
                        "type": "error",
                        "detail": f"Gemini request failed: {e}",
                        "started": last is not None,
                    }
                )
                return
            finally:
                # A cancelled stream is already unwinding. Closing it again can
                # re-enter the generator; leaving it avoids touching the client.
                if not abandon:
                    await _quiet_aclose(agen)

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    return await _run_chat(
        prompt=req.prompt,
        session_id=req.session_id,
        model=req.model,
        tools=req.tools,
        file_paths=None,
        thinking_level=req.thinking_level,
    )


@app.post("/chat_upload", response_model=ChatResponse)
async def chat_upload(
    prompt: str = Form(""),
    session_id: str = Form("default"),
    model: str | None = Form(None),
    tools_json: str | None = Form(None),
    thinking_level: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
):
    tools = None
    if tools_json:
        try:
            tools = json.loads(tools_json)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid tools_json: {e}") from e

    saved: list[Path] = []
    try:
        for f in files or []:
            raw = await f.read()
            if not raw:
                continue
            if len(raw) > 20 * 1024 * 1024:
                raise HTTPException(status_code=400, detail=f"File too large: {f.filename}")
            suffix = Path(f.filename or "upload.bin").suffix or ".bin"
            safe_name = Path(f.filename or "upload.bin").name.replace("/", "_")
            fd, tmp_name = tempfile.mkstemp(prefix="gem_", suffix="_" + safe_name, dir=str(UPLOAD_DIR))
            named = Path(tmp_name)
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
            saved.append(named)

        # Best-effort: for .txt/.md/.csv/.json append text extract into prompt if no images
        text_exts = {".txt", ".md", ".csv", ".json", ".log", ".py", ".js", ".ts", ".html", ".css"}
        extracts = []
        for p in list(saved):
            if p.suffix.lower() in text_exts:
                try:
                    extracts.append(f"\n\n--- file: {p.name} ---\n{p.read_text(errors='replace')[:15000]}")
                except Exception:
                    pass
        final_prompt = (prompt or "").strip()
        if extracts:
            final_prompt = (final_prompt + "".join(extracts)).strip()

        client = await get_client()
        account = _account_info(client)
        image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".pdf"}
        binaryish = [p for p in saved if p.suffix.lower() in image_exts or p.suffix.lower() not in text_exts]
        # Guest / unauthenticated sessions usually cannot upload; keep text extracts only.
        if not account.get("authenticated") and not binaryish:
            for pth in saved:
                try:
                    pth.unlink(missing_ok=True)
                except Exception:
                    pass
            return await _run_chat(
                prompt=final_prompt or "Please review the attached text.",
                session_id=session_id,
                model=model,
                tools=tools,
                file_paths=None,
                thinking_level=thinking_level,
            )

        if not account.get("authenticated") and binaryish:
            for pth in saved:
                try:
                    pth.unlink(missing_ok=True)
                except Exception:
                    pass
            raise HTTPException(
                status_code=401,
                detail=(
                    "Image/file upload needs a signed-in Gemini session (account AVAILABLE). "
                    "Current cookies are UNAUTHENTICATED/guest. Re-login in the box Chrome, "
                    "refresh chrome-cookie-seed.json, run npm run extract-cookies, restart."
                ),
            )

        return await _run_chat(
            prompt=final_prompt,
            session_id=session_id,
            model=model,
            tools=tools,
            file_paths=saved,
            thinking_level=thinking_level,
        )
    except HTTPException:
        for p in saved:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
        raise
    except Exception as e:
        for p in saved:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/reset")
async def reset(session_id: str = "default"):
    _chats.pop(session_id, None)
    return {"ok": True, "session_id": session_id}
