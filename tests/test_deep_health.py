"""Deep health hits Google with a cheap quota RPC and never logs cookies."""
import asyncio
import io
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="gemini-deep-health-")
os.environ["GEMINI_PREFS_PATH"] = str(Path(_tmp) / "prefs.json")
os.environ["GEMINI_COOKIES_PATH"] = str(Path(_tmp) / "cookies.json")
os.environ["GEMINI_DEEP_HEALTH_TIMEOUT"] = "0.2"

import gemini_bridge  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from gemini_webapi.constants import GRPC  # noqa: E402


class FakeProbeClient:
    def __init__(self, *, status="AVAILABLE", batch=None, error=None):
        self.account_status = SimpleNamespace(name=status, description="")
        self.batch_calls = []
        self.chat_calls = []
        self.error = error
        self._batch = batch

    def start_chat(self, **kwargs):
        self.chat_calls.append(kwargs)
        raise AssertionError("deep health must not start a chat")

    async def _batch_execute(self, payloads, **kwargs):
        self.batch_calls.append((payloads, kwargs))
        if self._batch is not None:
            return await self._batch(self, payloads, kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(text="", status_code=200)


class DeepHealthTests(unittest.TestCase):
    def setUp(self):
        self._prev_client = gemini_bridge._client
        gemini_bridge._client = None
        self._http = TestClient(gemini_bridge.app)
        self.http = self._http.__enter__()

    def tearDown(self):
        self._http.__exit__(None, None, None)
        gemini_bridge._client = self._prev_client

    def test_deep_health_uses_quota_rpc_and_does_not_chat(self):
        fake = FakeProbeClient()
        gemini_bridge._client = fake

        res = self.http.get("/health/deep")

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["reason"], "ok")
        self.assertEqual(fake.chat_calls, [])
        self.assertEqual(len(fake.batch_calls), 1)
        payloads, kwargs = fake.batch_calls[0]
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0].payload, "[]")
        self.assertEqual(payloads[0].rpcid, GRPC.CHECK_QUOTA)
        self.assertLessEqual(float(kwargs["timeout"]), 1)
        self.assertNotIn("cookie", res.text.lower())

    def test_shallow_health_does_not_call_google(self):
        fake = FakeProbeClient()
        gemini_bridge._client = fake

        res = self.http.get("/health")

        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["ok"])
        self.assertEqual(fake.batch_calls, [])

    def test_deep_health_timeout_is_not_ok(self):
        async def hang(_self, _payloads, _kwargs):
            await asyncio.sleep(5)

        gemini_bridge._client = FakeProbeClient(batch=hang)

        res = self.http.get("/health/deep")

        self.assertEqual(res.status_code, 503)
        body = res.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["reason"], "timeout")

    def test_unauthenticated_is_not_a_stale_failure(self):
        async def mark_unauth(client, _payloads, _kwargs):
            client.account_status = SimpleNamespace(name="UNAUTHENTICATED", description="")
            return SimpleNamespace(text="", status_code=200)

        fake = FakeProbeClient(batch=mark_unauth)
        gemini_bridge._client = fake

        res = self.http.get("/health/deep")

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["reason"], "unauthenticated")
        self.assertFalse(body["stale"])
        self.assertEqual(body["account"]["status"], "UNAUTHENTICATED")
        self.assertEqual(len(fake.batch_calls), 1)

    def test_probe_failure_does_not_log_cookie_values(self):
        secret = "super-secret-psid-value"
        gemini_bridge._client = FakeProbeClient(
            error=RuntimeError(f"Cookie __Secure-1PSID={secret}")
        )
        stdout, stderr = io.StringIO(), io.StringIO()

        with patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            res = self.http.get("/health/deep")

        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json()["reason"], "probe_failed")
        self.assertNotIn(secret, res.text)
        self.assertNotIn(secret, stdout.getvalue())
        self.assertNotIn(secret, stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
