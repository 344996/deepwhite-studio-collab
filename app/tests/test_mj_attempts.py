"""F01 (handover 2026-10-26): an MJ attempt is linked to its remote task on the server.

The page sends its attempt ID with the paid POST. After a reload the page asks the server what
happened to that attempt instead of guessing, and the same attempt is never POSTed upstream twice.
The upstream is mocked; nothing is submitted or billed.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-mj-attempts-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server
import main as core
import studio_midjourney as mj

PROVIDER = {"id": "mjfake", "name": "MJ fixture", "base_url": "https://mj.invalid", "enabled": True}


class AttemptTests(unittest.TestCase):
    def setUp(self):
        self.posts = []
        self.fail_next = False
        original = core.get_api_provider

        async def upstream(provider_id, method, suffix, data=None, action=""):
            if method == "POST":
                self.posts.append(suffix)
                if self.fail_next:
                    self.fail_next = False
                    raise HTTPException(502, "MJ 网络响应异常。")
                return mj.normalize({"data": {"task_id": "mj-%d" % len(self.posts), "status": "IN_PROGRESS"}}, action)
            return mj.normalize({"data": {"task_id": suffix.rsplit("/", 1)[-1], "status": "IN_PROGRESS"}}, action)

        for item in (
            patch.object(mj, "upstream", side_effect=upstream),
            patch.object(mj, "require_action", side_effect=lambda p, a: dict(PROVIDER)),
            patch.object(core, "get_api_provider", side_effect=lambda pid: dict(PROVIDER) if pid == "mjfake" else original(pid)),
        ):
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)

    def submit(self, attempt, status=200):
        response = self.client.post("/api/studio/mj/submit", json={
            "provider_id": "mjfake", "action": "imagine", "params": {"prompt": "雨夜站台"},
            "canvas_id": "c1", "node_id": "n1", "attempt_id": attempt})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def attempt(self, attempt):
        response = self.client.get("/api/studio/mj/attempts/" + attempt)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_attempt_lookup_returns_the_remote_task(self):
        first = self.submit("mj-attempt-aaa111")
        found = self.attempt("mj-attempt-aaa111")
        self.assertTrue(found["found"])
        self.assertEqual(found["task_id"], first["task_id"])
        self.assertEqual(found["history_id"], first["history_id"])
        self.assertEqual((found["canvas_id"], found["node_id"]), ("c1", "n1"))

    def test_repeated_attempt_is_not_posted_again(self):
        first = self.submit("mj-attempt-bbb222")
        again = self.submit("mj-attempt-bbb222")
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(again["task_id"], first["task_id"])
        self.assertEqual(again["history_id"], first["history_id"])

    def test_unknown_attempt_is_reported_as_not_received(self):
        self.assertEqual(self.attempt("mj-attempt-never"), {"found": False})

    def test_uncertain_attempt_is_never_resubmitted(self):
        self.fail_next = True
        self.client.post("/api/studio/mj/submit", json={
            "provider_id": "mjfake", "action": "imagine", "params": {"prompt": "雨夜"}, "attempt_id": "mj-attempt-ccc333"})
        found = self.attempt("mj-attempt-ccc333")
        self.assertEqual((found["found"], found["status"], found["task_id"]), (True, "uncertain", ""))
        response = self.submit("mj-attempt-ccc333", status=409)
        self.assertIn("勿重复提交", response["detail"])
        self.assertEqual(len(self.posts), 1)

    def test_attempt_ids_are_validated(self):
        response = self.client.get("/api/studio/mj/attempts/" + "x" * 300)
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
