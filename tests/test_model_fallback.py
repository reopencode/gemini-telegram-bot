"""Explicit models fall back once; turn and client timeouts stay bounded.

Generic session ids and placeholder cookie values only.
"""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="gemini-fallback-")
os.environ["GEMINI_PREFS_PATH"] = str(Path(_tmp) / "prefs.json")
os.environ["GEMINI_COOKIES_PATH"] = str(Path(_tmp) / "cookies.json")

import gemini_bridge  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


FALLBACK_PHRASE = "used the default model"
TIMEOUT_PHRASE = "took too long"


class Frame:
    def __init__(self, text="", text_delta=""):
        self.text = text
        self.text_delta = text_delta
        self.candidates = []
        self.chosen = 0

    def __str__(self):
        return self.text or ""


class ScriptedChat:
    def __init__(self, model=None, *, fail="", hang=False, text="ok"):
        self.model = model
        self.fail = fail
        self.hang = hang
        self.text = text
        self.stream_calls = 0
        self.send_calls = 0

    async def send_message_stream(self, prompt, **kwargs):
        self.stream_calls += 1
        if self.hang:
            await asyncio.sleep(2)
        if self.fail == "raise":
            raise RuntimeError("Unknown API error code: 1097")
        if self.fail == "empty":
            return
        if self.fail == "generic":
            yield Frame("Sorry, something went wrong")
            return
        if self.fail == "encountered":
            yield Frame("I encountered an error doing what you asked")
            return
        yield Frame("Hel", "Hel")
        yield Frame(self.text, self.text[3:] if self.text.startswith("Hel") else self.text)

    async def send_message(self, prompt, **kwargs):
        self.send_calls += 1
        if self.hang:
            await asyncio.sleep(2)
        if self.fail == "raise":
            raise RuntimeError("Unknown API error code: 1097")
        if self.fail == "empty":
            return Frame(text="")
        if self.fail == "generic":
            return Frame(text="Sorry, something went wrong")
        if self.fail == "encountered":
            return Frame(text="I encountered an error doing what you asked")
        return Frame(text=self.text)


class ScriptedClient:
    def __init__(
        self,
        *,
        explicit_fail="",
        explicit_hang=False,
        explicit_text="ok",
        default_text="recovered answer",
        default_fail="",
    ):
        self.account_status = SimpleNamespace(name="AVAILABLE", description="")
        self.starts = []
        self.closed = False
        self.explicit_fail = explicit_fail
        self.explicit_hang = explicit_hang
        self.explicit_text = explicit_text
        self.default_text = default_text
        self.default_fail = default_fail
        self.client = object()
        self._running = True

    def start_chat(self, model=None):
        if model:
            chat = ScriptedChat(
                model,
                fail=self.explicit_fail,
                hang=self.explicit_hang,
                text=self.explicit_text,
            )
        else:
            chat = ScriptedChat(None, fail=self.default_fail, text=self.default_text)
        self.starts.append(chat)
        return chat

    async def close(self):
        self.closed = True
        self._running = False
        self.client = None


def _events(response):
    import json

    return [json.loads(ln) for ln in response.text.splitlines() if ln.strip()]


class FallbackEndpointTests(unittest.TestCase):
    def setUp(self):
        gemini_bridge._chats.clear()
        self._client = TestClient(gemini_bridge.app)
        self.http = self._client.__enter__()
        self._env = {}

    def tearDown(self):
        self._client.__exit__(None, None, None)
        gemini_bridge._chats.clear()
        for key, old in self._env.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

    def _set_env(self, key, value):
        if key not in self._env:
            self._env[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def _post_chat(self, client, *, model="gemini-flash", session_id="session-a", path="/chat"):
        with patch.object(gemini_bridge, "get_client", self._getter(client)):
            if path == "/chat_upload":
                return self.http.post(
                    path,
                    data={"prompt": "hello", "session_id": session_id, "model": model or ""},
                    files={"files": ("note.txt", b"hello", "text/plain")},
                )
            body = {"prompt": "hello", "session_id": session_id}
            if model is not None:
                body["model"] = model
            return self.http.post(path, json=body)

    def _getter(self, client):
        async def get_client():
            return client

        return get_client

    def test_explicit_model_error_retries_default_once_and_notes_it(self):
        client = ScriptedClient(explicit_fail="raise")
        res = self._post_chat(client, model="gemini-flash", session_id="session-error")

        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertIn(FALLBACK_PHRASE, body["text"])
        self.assertIn("recovered answer", body["text"])
        self.assertTrue(body.get("fallback"))
        self.assertIsNone(body["model"])
        self.assertEqual(len(client.starts), 2)
        self.assertEqual(client.starts[0].model, "gemini-flash")
        self.assertIsNone(client.starts[1].model)
        self.assertEqual(client.starts[0].send_calls, 1)
        self.assertEqual(client.starts[1].send_calls, 1)
        self.assertFalse(client.closed)
        prefs = gemini_bridge.get_session_prefs("session-error")
        self.assertEqual(prefs["model"], "gemini-flash")

    def test_generic_failure_text_and_empty_reply_fall_back(self):
        for fail in ("generic", "encountered", "empty"):
            with self.subTest(fail=fail):
                gemini_bridge._chats.clear()
                client = ScriptedClient(explicit_fail=fail)
                res = self._post_chat(client, model="gemini-pro", session_id=f"session-{fail}")
                self.assertEqual(res.status_code, 200, res.text)
                self.assertIn(FALLBACK_PHRASE, res.json()["text"])
                self.assertIn("recovered answer", res.json()["text"])
                self.assertEqual(len(client.starts), 2)
                self.assertFalse(client.closed)

    def test_default_model_generic_text_is_not_retried(self):
        client = ScriptedClient(default_fail="generic")

        async def get_client():
            return client

        with patch.object(gemini_bridge, "get_client", get_client):
            res = self.http.post("/chat", json={"prompt": "hello", "session_id": "session-default"})

        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["text"], "Sorry, something went wrong")
        self.assertNotIn(FALLBACK_PHRASE, res.json()["text"])
        self.assertFalse(res.json().get("fallback"))
        self.assertEqual(len(client.starts), 1)
        self.assertEqual(client.starts[0].send_calls, 1)

    def test_successful_explicit_model_does_not_fall_back(self):
        client = ScriptedClient(explicit_text="flash answer")
        res = self._post_chat(client, model="gemini-flash", session_id="session-ok")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["text"], "flash answer")
        self.assertEqual(res.json()["model"], "gemini-flash")
        self.assertFalse(res.json().get("fallback"))
        self.assertEqual(len(client.starts), 1)

    def test_hung_turn_stops_with_a_clear_message_and_does_not_close_the_client(self):
        self._set_env("TURN_TIMEOUT", "0.05")
        client = ScriptedClient(explicit_hang=True, explicit_text="too late")
        res = self._post_chat(client, model="gemini-flash", session_id="session-hang")

        self.assertEqual(res.status_code, 200, res.text)
        self.assertIn(TIMEOUT_PHRASE, res.json()["text"])
        self.assertNotIn("recovered answer", res.json()["text"])
        self.assertEqual(len(client.starts), 1)
        self.assertEqual(client.starts[0].send_calls, 1)
        self.assertFalse(client.closed)

    def test_stream_error_falls_back_and_keeps_streaming(self):
        client = ScriptedClient(explicit_fail="raise", default_text="Hello")
        with patch.object(gemini_bridge, "get_client", self._getter(client)):
            res = self.http.post(
                "/chat_stream",
                json={"prompt": "hello", "session_id": "session-stream", "model": "gemini-flash"},
            )

        self.assertEqual(res.status_code, 200, res.text)
        got = _events(res)
        self.assertTrue(any(e.get("type") == "notice" and e.get("fallback") for e in got))
        partials = [e["text"] for e in got if e["type"] == "partial"]
        self.assertTrue(partials)
        self.assertTrue(any(text.startswith("Hel") or FALLBACK_PHRASE in text for text in partials))
        final = got[-1]
        self.assertEqual(final["type"], "final")
        self.assertIn(FALLBACK_PHRASE, final["text"])
        self.assertIn("Hello", final["text"])
        self.assertTrue(final.get("fallback"))
        self.assertFalse(any(e["type"] == "error" for e in got))
        self.assertEqual(len(client.starts), 2)
        self.assertGreaterEqual(client.starts[1].stream_calls, 1)
        self.assertFalse(client.closed)

    def test_stream_timeout_is_a_final_message_without_closing_the_client(self):
        self._set_env("TURN_TIMEOUT", "0.05")
        client = ScriptedClient(explicit_hang=True)
        with patch.object(gemini_bridge, "get_client", self._getter(client)):
            res = self.http.post(
                "/chat_stream",
                json={"prompt": "hello", "session_id": "session-stream-hang", "model": "gemini-pro"},
            )

        self.assertEqual(res.status_code, 200, res.text)
        got = _events(res)
        self.assertEqual(got[-1]["type"], "final")
        self.assertIn(TIMEOUT_PHRASE, got[-1]["text"])
        self.assertFalse(any(e["type"] == "error" for e in got))
        self.assertEqual(len(client.starts), 1)
        self.assertFalse(client.closed)

    def test_upload_uses_the_same_fallback(self):
        client = ScriptedClient(explicit_fail="generic")
        res = self._post_chat(client, model="gemini-pro", session_id="session-upload", path="/chat_upload")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertIn(FALLBACK_PHRASE, res.json()["text"])
        self.assertIn("recovered answer", res.json()["text"])
        self.assertEqual(len(client.starts), 2)
        self.assertFalse(client.closed)


class ClientTimeoutTests(unittest.TestCase):
    def setUp(self):
        self._old_client = gemini_bridge._client
        self._old_lock = gemini_bridge._client_lock
        self._old_timeout = os.environ.get("GEMINI_TIMEOUT")
        gemini_bridge._client = None

    def tearDown(self):
        gemini_bridge._client = self._old_client
        gemini_bridge._client_lock = self._old_lock
        if self._old_timeout is None:
            os.environ.pop("GEMINI_TIMEOUT", None)
        else:
            os.environ["GEMINI_TIMEOUT"] = self._old_timeout

    def test_init_timeout_comes_from_gemini_timeout_and_closed_client_is_replaced(self):
        os.environ["GEMINI_TIMEOUT"] = "181"
        cookies = gemini_bridge.COOKIES_PATH
        cookies.parent.mkdir(parents=True, exist_ok=True)
        cookies.write_text('{"__Secure-1PSID": "test-psid", "__Secure-1PSIDTS": "test-psidts"}')

        class Dead:
            def __init__(self):
                self._running = False
                self.client = None
                self.close_called = False

            async def close(self):
                self.close_called = True

        dead = Dead()
        seen = {}

        class FakeGemini:
            def __init__(self, psid, psidts):
                seen["psid"] = psid
                seen["psidts"] = psidts
                self.client = None
                self._running = False

            async def init(self, timeout, auto_refresh, auto_close):
                seen["timeout"] = timeout
                seen["auto_refresh"] = auto_refresh
                seen["auto_close"] = auto_close
                self._running = True
                self.client = object()

        gemini_bridge._client = dead

        async def run():
            gemini_bridge._client_lock = asyncio.Lock()
            with patch.object(gemini_bridge, "GeminiClient", FakeGemini):
                return await gemini_bridge.get_client()

        try:
            client = asyncio.run(run())
        finally:
            cookies.unlink(missing_ok=True)

        self.assertIsNot(client, dead)
        self.assertFalse(dead.close_called)
        self.assertEqual(seen["timeout"], 181.0)
        self.assertTrue(seen["auto_refresh"])
        self.assertFalse(seen["auto_close"])
        self.assertEqual(seen["psid"], "test-psid")
        self.assertEqual(gemini_bridge._turn_timeout(), 240.0)
        os.environ["TURN_TIMEOUT"] = "90"
        try:
            self.assertEqual(gemini_bridge._turn_timeout(), 90.0)
            os.environ["TURN_TIMEOUT"] = "nope"
            self.assertEqual(gemini_bridge._turn_timeout(), 240.0)
        finally:
            os.environ.pop("TURN_TIMEOUT", None)


if __name__ == "__main__":
    unittest.main()
