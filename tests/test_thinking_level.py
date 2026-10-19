"""Thinking level: pref default/validation and prompt steering."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="gemini-thinking-")
os.environ["GEMINI_PREFS_PATH"] = str(Path(_tmp) / "prefs.json")
os.environ["GEMINI_COOKIES_PATH"] = str(Path(_tmp) / "cookies.json")

import gemini_bridge  # noqa: E402


class FakeChat:
    model = None

    def __init__(self):
        self.model = None


class FakeClient:
    def __init__(self):
        self.chat = FakeChat()
        self.account_status = type("Status", (), {"name": "AVAILABLE", "description": ""})()

    def start_chat(self, model=None):
        self.chat.model = model
        return self.chat


class ThinkingPrefsTests(unittest.TestCase):
    def setUp(self):
        gemini_bridge.PREFS_PATH.unlink(missing_ok=True)

    def test_default_level_is_medium(self):
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "medium")

    def test_set_valid_level_is_persisted(self):
        gemini_bridge.set_session_prefs("s1", thinking_level="High")
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "high")

    def test_invalid_level_falls_back_to_medium(self):
        gemini_bridge.set_session_prefs("s1", thinking_level="low")
        gemini_bridge.set_session_prefs("s1", thinking_level="extreme")
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "medium")

    def test_unrelated_prefs_update_keeps_level(self):
        gemini_bridge.set_session_prefs("s1", thinking_level="low")
        gemini_bridge.set_session_prefs("s1", tools={"create_image": True})
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "low")

    def test_tools_catalog_is_only_media_tools(self):
        ids = [t["id"] for t in gemini_bridge.SUPPORTED_TOOLS]
        self.assertEqual(ids, ["create_image", "create_video", "create_music"])
        self.assertEqual(list(gemini_bridge.DEFAULT_PREFS["tools"]), ids)

    def test_legacy_and_unknown_tool_keys_are_dropped(self):
        gemini_bridge.set_session_prefs(
            "s1", tools={"extended_thinking": True, "deep_research": True, "create_video": True}
        )
        tools = gemini_bridge.get_session_prefs("s1")["tools"]
        self.assertEqual(tools, {"create_image": False, "create_video": True, "create_music": False})

    def test_prefs_are_written_once_and_not_when_unchanged(self):
        writes = []
        real = gemini_bridge._save_prefs
        with patch.object(gemini_bridge, "_save_prefs", lambda d: (writes.append(1), real(d))[1]):
            gemini_bridge.set_session_prefs("s1", model="m", tools={"create_image": True}, thinking_level="high")
            self.assertEqual(len(writes), 1)
            gemini_bridge.set_session_prefs("s1", model="m", tools={"create_image": True}, thinking_level="high")
            self.assertEqual(len(writes), 1)

    def test_prefs_cache_follows_file_changes(self):
        gemini_bridge.set_session_prefs("s1", thinking_level="high")
        gemini_bridge.PREFS_PATH.unlink()
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "medium")


class SteerPromptTests(unittest.TestCase):
    def test_low_and_high_add_prefix(self):
        low = gemini_bridge._steer_prompt("why?", {}, "low")
        high = gemini_bridge._steer_prompt("why?", {}, "high")
        self.assertTrue(low.endswith("why?") and low != "why?")
        self.assertTrue(high.endswith("why?") and high != "why?")
        self.assertNotEqual(low, high)

    def test_medium_adds_no_prefix(self):
        self.assertEqual(gemini_bridge._steer_prompt("why?", {}, "medium"), "why?")

    def test_media_steering_replaces_thinking_prefix(self):
        out = gemini_bridge._steer_prompt("a cat", {"create_image": True}, "high")
        self.assertTrue(out.startswith(gemini_bridge.MEDIA_PROMPT_PREFIX["create_image"]))
        self.assertNotIn(gemini_bridge.THINKING_PROMPT_PREFIX["high"], out)


class PrepareTurnTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        gemini_bridge.PREFS_PATH.unlink(missing_ok=True)
        gemini_bridge._chats.clear()

    async def _prepare(self, **kw):
        async def get_client():
            return FakeClient()

        kw.setdefault("tools", None)
        with patch.object(gemini_bridge, "get_client", get_client):
            return await gemini_bridge._prepare_turn(
                prompt="why?", session_id="s2", model=None, **kw
            )

    async def test_level_applies_without_any_tool(self):
        out = await self._prepare(thinking_level="high")
        self.assertEqual(out["thinking_level"], "high")
        self.assertTrue(out["kwargs"]["extended_thinking"])
        self.assertIn(gemini_bridge.THINKING_PROMPT_PREFIX["high"], out["prompt"])

    async def test_low_level_uses_standard_mode_with_brief_prefix(self):
        out = await self._prepare(thinking_level="low")
        self.assertEqual(out["thinking_level"], "low")
        self.assertFalse(out["kwargs"]["extended_thinking"])
        self.assertIn(gemini_bridge.THINKING_PROMPT_PREFIX["low"], out["prompt"])

    async def test_default_medium_is_extended_without_prefix(self):
        out = await self._prepare()
        self.assertEqual(out["thinking_level"], "medium")
        self.assertTrue(out["kwargs"]["extended_thinking"])
        self.assertEqual(out["prompt"], "why?")

    async def test_stored_level_is_used_when_request_omits_it(self):
        gemini_bridge.set_session_prefs("s2", thinking_level="low")
        out = await self._prepare()
        self.assertEqual(out["thinking_level"], "low")
        self.assertFalse(out["kwargs"]["extended_thinking"])

    async def test_media_tool_keeps_level_flag_but_not_prefix(self):
        out = await self._prepare(tools={"create_image": True}, thinking_level="high")
        self.assertTrue(out["kwargs"]["extended_thinking"])
        self.assertTrue(out["prompt"].startswith(gemini_bridge.MEDIA_PROMPT_PREFIX["create_image"]))
        self.assertNotIn(gemini_bridge.THINKING_PROMPT_PREFIX["high"], out["prompt"])
        self.assertEqual(out["tools_out"], {"create_image": True, "create_video": False, "create_music": False})

    async def test_turn_persists_prefs_with_a_single_write(self):
        writes = []
        real = gemini_bridge._save_prefs
        with patch.object(gemini_bridge, "_save_prefs", lambda d: (writes.append(1), real(d))[1]):
            await self._prepare(tools={"create_music": True}, thinking_level="high")
        self.assertEqual(len(writes), 1)


class ToolsEndpointTests(unittest.TestCase):
    def test_tools_endpoint_advertises_levels(self):
        from fastapi.testclient import TestClient

        body = TestClient(gemini_bridge.app).get("/tools").json()
        self.assertEqual([t["id"] for t in body["tools"]], ["create_image", "create_video", "create_music"])
        self.assertEqual(body["thinking"], {"levels": ["low", "medium", "high"], "default": "medium"})


if __name__ == "__main__":
    unittest.main()
