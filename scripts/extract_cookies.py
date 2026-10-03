#!/usr/bin/env python3
"""Extract Google/Gemini cookies for gemini_webapi.

Order of preference:
1) Live Chrome jar via scripts/export_live_cookies.mjs (includes __Secure-1PSIDTS)
2) GEMINI_COOKIES_JSON env path
3) GEMINI_COOKIE_SEED (default: box chrome-cookie-seed.json; seed omits rotating PSIDTS → guest)
4) Best-effort decrypt from Cookies SQLite (usually fails on this box)

Never prints cookie values.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from envfile import load_dotenv

load_dotenv(ROOT / ".env")

OUT = Path(os.environ.get("GEMINI_COOKIES_PATH", ROOT / ".cookies.json"))
SEED = Path(os.environ.get("GEMINI_COOKIE_SEED", "/home/box/sand-data/chrome-cookie-seed.json"))
EXPORT_JS = ROOT / "scripts" / "export_live_cookies.mjs"
EXEC_NODE = Path(os.environ.get("EXEC_NODE", "/exec-daemon/node"))
NEEDED = ("__Secure-1PSID",)


def chrome_cookie_dbs() -> list[Path]:
    raw = os.environ.get("CHROME_COOKIE_DBS", "").strip()
    if raw:
        return [Path(part) for part in raw.split(os.pathsep) if part.strip()]
    return [
        Path("/home/box/chrome-profile/Fork-4/Default/Cookies"),
        Path("/home/box/chrome-profile/Fork-3/Default/Cookies"),
        Path("/home/box/chrome-profile/Default/Cookies"),
    ]


def from_seed(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    cookies = data.get("cookies", data if isinstance(data, list) else [])
    if isinstance(data, dict) and not cookies and "__Secure-1PSID" in data:
        return {k: v for k, v in data.items() if not k.startswith("_")}
    out: dict[str, str] = {}
    dom: dict[str, str] = {}
    for c in cookies:
        if not isinstance(c, dict):
            continue
        domain = c.get("domain") or ""
        if "google.com" not in domain and "gemini" not in domain:
            continue
        if "youtube" in domain:
            continue
        name = c.get("name")
        value = c.get("value")
        if not name or not value:
            continue
        out[name] = value
        dom[name] = domain
    return out or None


def try_live_export() -> dict[str, str] | None:
    if not EXPORT_JS.exists():
        return None
    node = str(EXEC_NODE if EXEC_NODE.exists() else shutil.which("node") or "node")
    env = {**os.environ, "GEMINI_COOKIES_PATH": str(OUT)}
    try:
        proc = subprocess.run(
            [node, str(EXPORT_JS)],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as e:
        print(f"live export failed to start: {e}", file=sys.stderr)
        return None
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        return None
    print(proc.stdout.strip())
    if OUT.exists():
        return json.loads(OUT.read_text())
    return None


def try_decrypt_db(db_path: Path) -> dict[str, str] | None:
    try:
        from Crypto.Cipher import AES
        from Crypto.Protocol.KDF import PBKDF2
    except ImportError:
        return None
    src = db_path.resolve() if db_path.is_symlink() else db_path
    if not src.exists():
        return None

    def decrypt(blob: bytes) -> str | None:
        if not blob or blob[:3] not in (b"v10", b"v11"):
            return None
        key = PBKDF2(b"peanuts", b"saltysalt", dkLen=16, count=1)
        plain = AES.new(key, AES.MODE_CBC, IV=b" " * 16).decrypt(blob[3:])
        pad = plain[-1]
        if not (1 <= pad <= 16) or not plain.endswith(bytes([pad]) * pad):
            return None
        try:
            text = plain[:-pad].decode("utf-8")
        except UnicodeDecodeError:
            return None
        if not text or text.startswith("g.") or text.startswith("sidts-") or len(text) > 8:
            if text and all(32 <= ord(ch) < 127 or ch in "\t\n\r" for ch in text[:12]):
                return text
        return None

    tmp = tempfile.mktemp(suffix=".db")
    try:
        shutil.copy2(src, tmp)
        con = sqlite3.connect(tmp)
        rows = con.execute(
            """
            SELECT host_key, name, encrypted_value FROM cookies
            WHERE host_key LIKE '%google%' OR host_key LIKE '%gemini%'
            """
        ).fetchall()
        con.close()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    out: dict[str, str] = {}
    for host, name, enc in rows:
        if "youtube" in host:
            continue
        val = decrypt(enc or b"")
        if val:
            out[name] = val
    return out or None


def main() -> int:
    cookies = None
    source = None

    cookies = try_live_export()
    if cookies and "__Secure-1PSID" in cookies:
        source = "live-chrome-cdp-jar"
    else:
        cookies = None

    if cookies is None:
        env_path = os.environ.get("GEMINI_COOKIES_JSON")
        if env_path:
            cookies = from_seed(Path(env_path))
            source = f"GEMINI_COOKIES_JSON={env_path}"

    if cookies is None and SEED.exists():
        cookies = from_seed(SEED)
        source = str(SEED)

    if cookies is None:
        for cand in chrome_cookie_dbs():
            cookies = try_decrypt_db(cand)
            if cookies:
                source = f"decrypt:{cand}"
                break

    if not cookies or not all(k in cookies for k in NEEDED):
        print(
            "ERROR: Could not extract usable Google cookies with __Secure-1PSID.\n"
            f"Try: {EXEC_NODE} scripts/export_live_cookies.mjs\n"
            "while signed in at gemini.google.com/app on a box Chrome fork.\n",
            file=sys.stderr,
        )
        return 1

    OUT.write_text(json.dumps(cookies, indent=2))
    os.chmod(OUT, 0o600)
    print(f"Wrote {OUT} ({len(cookies)} cookies) from {source}")
    print("Names:", ", ".join(sorted(cookies)))
    print("Has __Secure-1PSIDTS:", "__Secure-1PSIDTS" in cookies)
    if "__Secure-1PSIDTS" not in cookies:
        print(
            "WARNING: without __Secure-1PSIDTS gemini_webapi often stays UNAUTHENTICATED/guest.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
