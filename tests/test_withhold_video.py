"""Generated videos are not saved for the Mini App; images and audio still are."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="gemini-video-")
os.environ["GEMINI_PREFS_PATH"] = str(Path(_tmp) / "prefs.json")
os.environ["GEMINI_COOKIES_PATH"] = str(Path(_tmp) / "cookies.json")

import gemini_bridge  # noqa: E402


class Saveable:
    def __init__(self, kind):
        self.kind = kind
        self.title = "clip"
        self.saved = None
        self.mp3_url = "http://127.0.0.1:1/nope.mp3" if kind == "audio" else None
        self.url = None

    async def save(self, path, filename, verbose=False):
        dest = Path(path) / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"fake-media")
        self.saved = dest
        return str(dest)


class Candidate:
    def __init__(self, images=None, videos=None, media=None):
        self.generated_images = images or []
        self.generated_videos = videos or []
        self.generated_media = media or []


class ModelOutput:
    def __init__(self, text, candidate):
        self.text = text
        self.candidates = [candidate]
        self.chosen = 0


class FakeChat:
    def __init__(self, output):
        self.output = output
        self.model = None

    async def send_message(self, prompt, **kwargs):
        self.prompt = prompt
        return self.output


class FakeClient:
    def __init__(self, chat):
        self.chat = chat
        self.account_status = type("Status", (), {"name": "AVAILABLE", "description": ""})()

    def start_chat(self, model=None):
        self.chat.model = model
        return self.chat


def _cleanup(paths):
    for path in paths:
        if path is None:
            continue
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass


class VideoWithholdTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        gemini_bridge._chats.clear()

    async def _run(self, output, tools, session_id):
        chat = FakeChat(output)
        client = FakeClient(chat)

        async def get_client():
            return client

        with patch("gemini_bridge.get_client", get_client):
            return await gemini_bridge._run_chat(
                prompt="make something",
                session_id=session_id,
                model=None,
                tools=tools,
                file_paths=None,
            )

    async def test_generated_video_becomes_ready_message_and_file_is_not_public(self):
        video = Saveable("video")
        image = Saveable("image")
        output = ModelOutput(
            "Here is the ocean clip I rendered for you.",
            Candidate(images=[image], videos=[video]),
        )
        try:
            resp = await self._run(output, {"create_video": True}, "video-1")
            self.assertEqual(resp.text, "Your video is ready!")
            self.assertEqual(resp.media, [])
            self.assertIsNotNone(video.saved)
            self.assertFalse(video.saved.exists())
            self.assertFalse(any(gemini_bridge.MEDIA_DIR.glob("*.mp4")))
        finally:
            _cleanup([video.saved, image.saved])

    async def test_create_video_without_a_video_keeps_the_text_reply(self):
        output = ModelOutput("I could not make a video.", Candidate())
        resp = await self._run(output, {"create_video": True}, "video-text")
        self.assertEqual(resp.text, "I could not make a video.")
        self.assertEqual(resp.media, [])

    async def test_image_is_still_saved_for_the_mini_app(self):
        image = Saveable("image")
        output = ModelOutput("A painting.", Candidate(images=[image]))
        try:
            resp = await self._run(output, {"create_image": True}, "image-1")
            self.assertEqual(resp.text, "A painting.")
            self.assertEqual(len(resp.media), 1)
            self.assertEqual(resp.media[0].type, "image")
            self.assertTrue(resp.media[0].url.startswith("/media/"))
            self.assertTrue(Path(resp.media[0].path).exists())
            self.assertTrue(str(Path(resp.media[0].path).resolve()).startswith(str(gemini_bridge.MEDIA_DIR.resolve())))
        finally:
            _cleanup([image.saved])

    async def test_audio_is_still_saved_for_the_mini_app(self):
        audio = Saveable("audio")
        output = ModelOutput("A short tune.", Candidate(media=[audio]))
        try:
            resp = await self._run(output, {"create_music": True}, "audio-1")
            self.assertEqual(resp.text, "A short tune.")
            self.assertEqual(len(resp.media), 1)
            self.assertEqual(resp.media[0].type, "audio")
            self.assertTrue(resp.media[0].url.startswith("/media/"))
            self.assertTrue(Path(resp.media[0].path).exists())
        finally:
            _cleanup([audio.saved])


class CreateVideoStreamTests(unittest.TestCase):
    def setUp(self):
        gemini_bridge._chats.clear()
        from fastapi.testclient import TestClient

        self._client = TestClient(gemini_bridge.app)
        self.http = self._client.__enter__()

    def tearDown(self):
        self._client.__exit__(None, None, None)
        gemini_bridge._chats.clear()

    def _events(self, response):
        import json

        return [json.loads(ln) for ln in response.text.splitlines() if ln.strip()]

    def test_create_video_stream_keeps_partials_until_the_ready_message(self):
        video = Saveable("video")
        output = ModelOutput(
            "Here is the ocean clip I rendered for you.",
            Candidate(videos=[video]),
        )

        class StreamChat(FakeChat):
            async def send_message_stream(self, prompt, **kwargs):
                yield type("Frame", (), {"text": "Rendering", "text_delta": "Rendering", "candidates": [], "chosen": 0})()
                yield output

        chat = StreamChat(output)
        client = FakeClient(chat)

        async def get_client():
            return client

        try:
            with patch("gemini_bridge.get_client", get_client):
                res = self.http.post(
                    "/chat_stream",
                    json={
                        "prompt": "make a video",
                        "session_id": "stream-video",
                        "tools": {"create_video": True},
                    },
                )
            self.assertEqual(res.status_code, 200, res.text)
            got = self._events(res)
            self.assertEqual([e["type"] for e in got], ["final"])
            self.assertEqual(got[0]["text"], "Your video is ready!")
            self.assertEqual(got[0]["media"], [])
            self.assertIsNotNone(video.saved)
            self.assertFalse(video.saved.exists())
            self.assertNotIn("Rendering", res.text)
            self.assertNotIn("ocean clip", res.text)
        finally:
            _cleanup([video.saved])


if __name__ == "__main__":
    unittest.main()
