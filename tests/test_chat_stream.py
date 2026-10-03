"""Streaming bridge: cumulative snapshots, shared chat setup, and pre-text errors."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="gemini-stream-")
os.environ["GEMINI_PREFS_PATH"] = str(Path(_tmp) / "prefs.json")
os.environ["GEMINI_COOKIES_PATH"] = str(Path(_tmp) / "cookies.json")

import gemini_bridge  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class Frame:
    def __init__(self, text="", text_delta=""):
        self.text = text
        self.text_delta = text_delta
        self.candidates = []
        self.chosen = 0


class FakeChat:
    def __init__(self, frames=None, error=None, reply=None):
        self.frames = list(frames or [])
        self.error = error
        self.reply = reply
        self.model = None
        self.stream_calls = []
        self.send_calls = []

    def start_as(self, model=None):
        self.model = model
        return self

    async def send_message_stream(self, prompt, **kwargs):
        self.stream_calls.append((prompt, kwargs))
        if self.error and not self.frames:
            raise self.error
        for frame in self.frames:
            yield frame
        if self.error:
            raise self.error

    async def send_message(self, prompt, **kwargs):
        self.send_calls.append((prompt, kwargs))
        if self.error and self.reply is None:
            raise self.error
        if self.reply is not None:
            return self.reply
        return self.frames[-1] if self.frames else Frame(text="ok")


class FakeClient:
    def __init__(self, chat):
        self.chat = chat
        self.account_status = type("Status", (), {"name": "AVAILABLE", "description": ""})()

    def start_chat(self, model=None):
        self.chat.model = model
        return self.chat


def events(response):
    lines = [ln for ln in response.text.splitlines() if ln.strip()]
    import json

    return [json.loads(ln) for ln in lines]


class MergeStreamTextTests(unittest.TestCase):
    def test_snapshot_is_cumulative_and_delta_is_not_appended_again(self):
        first = gemini_bridge.merge_stream_text("", Frame("Hel", "Hel"))
        second = gemini_bridge.merge_stream_text(first, Frame("Hello", "lo"))
        self.assertEqual(first, "Hel")
        self.assertEqual(second, "Hello")

    def test_delta_only_frames_fold_into_one_string(self):
        acc = gemini_bridge.merge_stream_text("", Frame("", "Hel"))
        acc = gemini_bridge.merge_stream_text(acc, Frame("", "lo"))
        self.assertEqual(acc, "Hello")

    def test_shorter_snapshot_replaces_flicker(self):
        acc = gemini_bridge.merge_stream_text("", Frame("Hello world!", "Hello world!"))
        acc = gemini_bridge.merge_stream_text(acc, Frame("Hello world", ""))
        self.assertEqual(acc, "Hello world")

    def test_identical_snapshot_stays_put(self):
        acc = "Hello"
        self.assertEqual(gemini_bridge.merge_stream_text(acc, Frame("Hello", "")), acc)


class ChatStreamEndpointTests(unittest.TestCase):
    def setUp(self):
        gemini_bridge._chats.clear()
        self._client = TestClient(gemini_bridge.app)
        self.http = self._client.__enter__()

    def tearDown(self):
        self._client.__exit__(None, None, None)
        gemini_bridge._chats.clear()

    def test_stream_yields_cumulative_partials_then_final_with_media(self):
        chat = FakeChat(
            frames=[
                Frame("Hel", "Hel"),
                Frame("Hello", "lo"),
                Frame("Hello", ""),
            ]
        )

        async def get_client():
            return FakeClient(chat)

        async def collect_media(_result):
            return [
                gemini_bridge.MediaItem(
                    type="image",
                    filename="a.png",
                    url="/media/a.png",
                    path="/tmp/a.png",
                    title="pic",
                    mime="image/png",
                )
            ]

        with (
            patch.object(gemini_bridge, "get_client", get_client),
            patch.object(gemini_bridge, "_collect_media", collect_media),
        ):
            res = self.http.post(
                "/chat_stream",
                json={
                    "prompt": "draw something",
                    "session_id": "tg-1",
                    "model": "gemini-flash",
                    "tools": {"extended_thinking": True, "create_image": True},
                },
            )

        self.assertEqual(res.status_code, 200, res.text)
        self.assertIn("application/x-ndjson", res.headers["content-type"])
        got = events(res)
        self.assertEqual([e["type"] for e in got], ["partial", "partial", "final"])
        self.assertEqual([e["text"] for e in got[:2]], ["Hel", "Hello"])
        final = got[-1]
        self.assertEqual(final["text"], "Hello")
        self.assertEqual(final["session_id"], "tg-1")
        self.assertEqual(final["model"], "gemini-flash")
        self.assertTrue(final["tools"]["extended_thinking"])
        self.assertTrue(final["tools"]["create_image"])
        self.assertEqual(final["media"][0]["type"], "image")
        self.assertEqual(final["media"][0]["filename"], "a.png")
        prompt, kwargs = chat.stream_calls[0]
        self.assertTrue(prompt.startswith("GENERATE an image"))
        self.assertEqual(kwargs["extended_thinking"], True)
        self.assertEqual(kwargs["deep_research"], False)
        self.assertEqual(kwargs["temporary"], False)
        self.assertNotIn("files", kwargs)

    def test_delta_only_stream_is_one_cumulative_string(self):
        chat = FakeChat(frames=[Frame("", "Hel"), Frame("", "lo world")])

        async def get_client():
            return FakeClient(chat)

        with patch.object(gemini_bridge, "get_client", get_client):
            res = self.http.post("/chat_stream", json={"prompt": "hi", "session_id": "s"})

        self.assertEqual(res.status_code, 200, res.text)
        got = events(res)
        self.assertEqual([e["text"] for e in got if e["type"] == "partial"], ["Hel", "Hello world"])
        self.assertEqual(got[-1]["type"], "final")
        self.assertEqual(got[-1]["text"], "Hello world")

    def test_error_before_any_text_sets_started_false(self):
        chat = FakeChat(error=RuntimeError("upstream down"))

        async def get_client():
            return FakeClient(chat)

        with patch.object(gemini_bridge, "get_client", get_client):
            res = self.http.post("/chat_stream", json={"prompt": "hi", "session_id": "s"})

        self.assertEqual(res.status_code, 200, res.text)
        got = events(res)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["type"], "error")
        self.assertFalse(got[0]["started"])
        self.assertIn("upstream down", got[0]["detail"])

    def test_prepare_failure_is_http_error_before_the_body(self):
        async def get_client():
            raise RuntimeError("no cookies")

        with patch.object(gemini_bridge, "get_client", get_client):
            res = self.http.post("/chat_stream", json={"prompt": "hi", "session_id": "s"})

        self.assertEqual(res.status_code, 503)
        self.assertIn("no cookies", res.text)

    def test_one_shot_chat_uses_the_same_session_setup(self):
        chat = FakeChat(reply=Frame(text="one shot"))

        async def get_client():
            return FakeClient(chat)

        body = {
            "prompt": "hello",
            "session_id": "shared",
            "model": "gemini-flash",
            "tools": {"extended_thinking": True, "deep_research": True},
        }
        with patch.object(gemini_bridge, "get_client", get_client):
            streamed = self.http.post("/chat_stream", json=body)
            chat.frames = []
            chat.error = None
            once = self.http.post("/chat", json=body)

        self.assertEqual(streamed.status_code, 200, streamed.text)
        self.assertEqual(once.status_code, 200, once.text)
        self.assertEqual(once.json()["text"], "one shot")
        self.assertEqual(once.json()["model"], "gemini-flash")
        self.assertTrue(once.json()["tools"]["deep_research"])
        self.assertEqual(len(chat.stream_calls), 1)
        self.assertEqual(len(chat.send_calls), 1)
        self.assertEqual(chat.stream_calls[0][0], chat.send_calls[0][0])
        self.assertEqual(chat.stream_calls[0][1], chat.send_calls[0][1])
        self.assertIs(gemini_bridge._chats["shared"], chat)


if __name__ == "__main__":
    unittest.main()
