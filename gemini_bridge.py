"""
HTTP bridge to unofficial gemini_webapi using browser session cookies.
Personal / research use only — fragile and may violate Google ToS.
"""
from __future__ import annotations

import json
import mimetypes
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
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

# Tools gemini_webapi actually exposes as request flags
SUPPORTED_TOOLS = [
    {
        "id": "extended_thinking",
        "label": "Thinking",
        "description": "Extended thinking / deeper reasoning (library flag + level steering).",
        "supported": True,
        "kind": "flag",
        "levels": ["low", "medium", "high"],
        "default_level": "medium",
    },
    {
        "id": "deep_research",
        "label": "Deep Research",
        "description": "Deep research plan mode (library flag; needs full auth).",
        "supported": True,
        "kind": "flag",
    },
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
    {
        "id": "google_search",
        "label": "Google Search",
        "description": "Android-style Search toggle — not separately controllable in gemini_webapi.",
        "supported": False,
        "kind": "stub",
    },
    {
        "id": "code_execution",
        "label": "Code execution",
        "description": "Android-style code tool — not exposed as a toggle in gemini_webapi.",
        "supported": False,
        "kind": "stub",
    },
    {
        "id": "canvas",
        "label": "Canvas",
        "description": "Android Canvas — not supported by gemini_webapi.",
        "supported": False,
        "kind": "stub",
    },
]

THINKING_LEVELS = ["low", "medium", "high"]
DEFAULT_THINKING_LEVEL = "medium"

# gemini_webapi only has an on/off `extended_thinking` flag (payload index 80).
# While Thinking is on: Low sends the standard flag, Medium and High send extended.
# High also adds a step-by-step prefix. Medium adds none. Low adds a brief prefix.
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
    "tools": {
        "extended_thinking": False,
        "deep_research": False,
        "create_image": False,
        "create_video": False,
        "create_music": False,
        "google_search": False,
        "code_execution": False,
        "canvas": False,
    },
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
_chats: dict[str, Any] = {}


def _load_prefs() -> dict:
    if PREFS_PATH.exists():
        try:
            return json.loads(PREFS_PATH.read_text())
        except Exception:
            return {}
    return {}


def _save_prefs(data: dict) -> None:
    PREFS_PATH.write_text(json.dumps(data, indent=2))


def get_session_prefs(session_id: str) -> dict:
    all_prefs = _load_prefs()
    prefs = all_prefs.get(session_id) or {}
    merged = {
        "model": prefs.get("model", DEFAULT_PREFS["model"]),
        "thinking_level": normalize_thinking_level(prefs.get("thinking_level")),
        "tools": {**DEFAULT_PREFS["tools"], **(prefs.get("tools") or {})},
    }
    return merged


def set_session_prefs(
    session_id: str,
    *,
    model: str | None = None,
    tools: dict | None = None,
    thinking_level: str | None = None,
) -> dict:
    all_prefs = _load_prefs()
    cur = get_session_prefs(session_id)
    if model is not None:
        cur["model"] = model or None
    if thinking_level is not None:
        cur["thinking_level"] = normalize_thinking_level(thinking_level)
    if tools is not None:
        cur["tools"] = {**cur["tools"], **tools}
    all_prefs[session_id] = cur
    _save_prefs(all_prefs)
    return cur


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


async def get_client() -> GeminiClient:
    global _client
    if _client is not None:
        return _client
    psid, psidts = _load_cookies()
    client = GeminiClient(psid, psidts or None)
    await client.init(timeout=60, auto_refresh=True, auto_close=False)
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


@app.on_event("startup")
async def startup():
    # Lazy-init on first request so 429 / transient auth issues don't block the HTTP server.
    app.state.startup_error = None
    try:
        await get_client()
    except Exception as e:
        app.state.startup_error = str(e)


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


@app.get("/models")
async def models():
    try:
        client = await get_client()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Gemini client unavailable: {e}") from e
    return {"models": _serialize_models(client), "account": _account_info(client)}


@app.get("/tools")
async def tools():
    return {"tools": SUPPORTED_TOOLS}


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

    When extended thinking is on, the thinking level adds a reasoning prefix
    (medium adds none).
    """
    p = (prompt or "").strip()
    if tools.get("extended_thinking") and not any(
        tools.get(k) for k in ("create_image", "create_video", "create_music")
    ):
        prefix = THINKING_PROMPT_PREFIX.get(normalize_thinking_level(thinking_level), "")
        if prefix and p:
            return prefix + p
    # Priority if multiple media tools on: image > video > music
    for key in ("create_image", "create_video", "create_music"):
        if tools.get(key):
            prefix = MEDIA_PROMPT_PREFIX[key]
            # Avoid double-prefixing
            if p.lower().startswith("generate an image") or p.lower().startswith("generate a short video") or p.lower().startswith("generate a piece of music"):
                return p
            return prefix + (p or "a creative result")
    return p


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

    prefs = get_session_prefs(session_id)
    if model is not None:
        prefs = set_session_prefs(session_id, model=model)
    if tools is not None:
        prefs = set_session_prefs(session_id, tools=tools)
    if thinking_level is not None:
        prefs = set_session_prefs(session_id, thinking_level=thinking_level)

    use_model = prefs.get("model") or None
    t = prefs.get("tools") or {}
    tool_thinking = bool(t.get("extended_thinking"))
    deep_research = bool(t.get("deep_research"))

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
    # On/off library flag. Thinking off ignores the level. Low is standard; Medium and High are extended.
    request_thinking = tool_thinking and thinking_level_out != "low"

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
        "deep_research": deep_research,
        "extended_thinking": request_thinking,
    }
    if files_arg:
        kwargs["files"] = files_arg

    tools_out = {
        "extended_thinking": tool_thinking,
        "deep_research": deep_research,
        "create_image": bool(t.get("create_image")),
        "create_video": bool(t.get("create_video")),
        "create_music": bool(t.get("create_music")),
    }
    return {
        "chat": chat,
        "prompt": prompt,
        "kwargs": kwargs,
        "use_model": use_model,
        "session_id": session_id,
        "tools_out": tools_out,
        "thinking_level": thinking_level_out,
    }


async def _run_chat(
    *,
    prompt: str,
    session_id: str,
    model: str | None,
    tools: dict[str, bool] | None,
    file_paths: list[Path] | None = None,
    thinking_level: str | None = None,
) -> ChatResponse:
    try:
        prepared = await _prepare_turn(
            prompt=prompt,
            session_id=session_id,
            model=model,
            tools=tools,
            file_paths=file_paths,
            thinking_level=thinking_level,
        )
        result = await prepared["chat"].send_message(prepared["prompt"], **prepared["kwargs"])
        text = _clean_reply_text(getattr(result, "text", None) or str(result))
        media_items = await _collect_media(result)
        if not text and media_items:
            text = f"(generated {len(media_items)} media file(s))"
        text, media_items = _withhold_videos(text, media_items)
        return ChatResponse(
            text=text or "",
            session_id=prepared["session_id"],
            model=prepared["use_model"],
            tools=prepared["tools_out"],
            thinking_level=prepared["thinking_level"],
            media=media_items,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini request failed: {e}") from e
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
      {"type":"final","text":"...","media":[...],"session_id","model","tools"}
      {"type":"error","detail":"...","started":bool}

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

    async def gen():
        acc = ""
        last = None
        try:
            async for output in prepared["chat"].send_message_stream(
                prepared["prompt"], **prepared["kwargs"]
            ):
                last = output
                new_acc = merge_stream_text(acc, output)
                if new_acc != acc:
                    acc = new_acc
                    # Video is not delivered. Keep the placeholder until the ready notice.
                    if not prepared["tools_out"].get("create_video"):
                        yield _ndjson({"type": "partial", "text": acc})
            text = _clean_reply_text(acc)
            try:
                media_items = await _collect_media(last)
            except Exception as media_err:
                print(f"[bridge] stream media collect failed: {media_err}")
                media_items = []
            if not text and media_items:
                text = f"(generated {len(media_items)} media file(s))"
            text, media_items = _withhold_videos(text, media_items)
            yield _ndjson(
                {
                    "type": "final",
                    "text": text or "",
                    "session_id": prepared["session_id"],
                    "model": prepared["use_model"],
                    "tools": prepared["tools_out"],
                    "thinking_level": prepared["thinking_level"],
                    "media": [m.model_dump() for m in media_items],
                }
            )
        except Exception as e:
            yield _ndjson(
                {
                    "type": "error",
                    "detail": f"Gemini request failed: {e}",
                    "started": last is not None,
                }
            )

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
            named = Path(tempfile.mktemp(prefix="gem_", suffix="_" + safe_name, dir=str(UPLOAD_DIR)))
            named.write_bytes(raw)
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
