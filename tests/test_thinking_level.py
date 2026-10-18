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
        gemini_bridge.set_session_prefs("s1", tools={"extended_thinking": True})
        self.assertEqual(gemini_bridge.get_session_prefs("s1")["thinking_level"], "low")

    def test_tools_catalog_advertises_levels(self):
        entry = next(t for t in gemini_bridge.SUPPORTED_TOOLS if t["id"] == "extended_thinking")
        self.assertEqual(entry["levels"], ["low", "medium", "high"])
        self.assertEqual(entry["default_level"], "medium")


class SteerPromptTests(unittest.TestCase):
    def test_low_and_high_add_prefix_when_thinking_on(self):
        tools = {"extended_thinking": True}
        low = gemini_bridge._steer_prompt("why?", tools, "low")
        high = gemini_bridge._steer_prompt("why?", tools, "high")
        self.assertTrue(low.endswith("why?") and low != "why?")
        self.assertTrue(high.endswith("why?") and high != "why?")
        self.assertNotEqual(low, high)

    def test_medium_adds_no_prefix(self):
        self.assertEqual(gemini_bridge._steer_prompt("why?", {"extended_thinking": True}, "medium"), "why?")

    def test_no_prefix_when_thinking_off(self):
        self.assertEqual(gemini_bridge._steer_prompt("why?", {"extended_thinking": False}, "high"), "why?")

    def test_media_steering_wins_over_thinking_prefix(self):
        out = gemini_bridge._steer_prompt(
            "a cat", {"extended_thinking": True, "create_image": True}, "high"
        )
        self.assertTrue(out.startswith(gemini_bridge.MEDIA_PROMPT_PREFIX["create_image"]))
        self.assertNotIn(gemini_bridge.THINKING_PROMPT_PREFIX["high"], out)


class PrepareTurnTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        gemini_bridge.PREFS_PATH.unlink(missing_ok=True)
        gemini_bridge._chats.clear()

    async def _prepare(self, **kw):
        async def get_client():
            return FakeClient()

        with patch.object(gemini_bridge, "get_client", get_client):
            return await gemini_bridge._prepare_turn(
                prompt="why?", session_id="s2", model=None, **kw
            )

    async def test_high_level_steers_prompt_and_is_reported(self):
        out = await self._prepare(tools={"extended_thinking": True}, thinking_level="high")
        self.assertEqual(out["thinking_level"], "high")
        self.assertTrue(out["kwargs"]["extended_thinking"])
        self.assertIn(gemini_bridge.THINKING_PROMPT_PREFIX["high"], out["prompt"])

    async def test_stored_level_is_used_when_request_omits_it(self):
        gemini_bridge.set_session_prefs("s2", thinking_level="low")
        out = await self._prepare(tools={"extended_thinking": True})
        self.assertEqual(out["thinking_level"], "low")
        self.assertIn(gemini_bridge.THINKING_PROMPT_PREFIX["low"], out["prompt"])

    async def test_default_medium_leaves_prompt_unchanged(self):
        out = await self._prepare(tools={"extended_thinking": True})
        self.assertEqual(out["thinking_level"], "medium")
        self.assertEqual(out["prompt"], "why?")


if __name__ == "__main__":
    unittest.main()
