"""Text generation request mapping and receipts, against a mocked upstream only.

LIVE-LLM-01 (handover issue 24): the output limit reaches the request body.
LIVE-LLM-02 (issue 25): the receipt keeps upstream identifiers and marks unknown cost as pending.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-generation-llm-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server  # noqa: F401  (installs the generation routes and compatibility layer)
import main as core
import studio_generation as generation

BASE = "https://api.deepwhiteai.com/v1"


class LlmTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.reply = httpx.Response(200, headers={"x-request-id": "req-abc-123"}, json={
            "id": "chatcmpl-123", "choices": [{"message": {"content": "好的"}}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11}})
        self.model = "gpt-4o-mini"
        original = httpx.AsyncClient

        def upstream(request):
            if request.url.path.endswith("/files/upload"):
                return httpx.Response(200, json={"data": {"url": "https://cdn.example.com/f/ref-1.png?X-Signature=secret-sig", "expires_in": 3600}})
            self.sent.append(json.loads(request.content or b"{}"))
            return self.reply
        for item in (
            patch.object(generation, "connection", side_effect=lambda pid, expected=None: (BASE, {"Authorization": "Bearer dummy-key"}, "https://api.deepwhiteai.com")),
            patch.object(generation.catalog, "resolve_model", side_effect=lambda *a, **k: self.model),
            patch.object(generation.httpx, "AsyncClient", side_effect=lambda *a, **kw: original(*a, **{**kw, "transport": httpx.MockTransport(upstream)})),
            patch.object(core, "native_before_submit", side_effect=lambda: None),
        ):
            item.start()
            self.addCleanup(item.stop)

    def payload(self, **params):
        return generation.Generation(request_id="llm-" + uuid.uuid4().hex[:12], provider_id="deepwhite", model=self.model,
                                     kind="chat", prompt="用一句话描述雨夜", params=params)

    def run_job(self, payload):
        async def go():
            job = await generation.submit(payload)
            await generation.WORKERS[job["id"]]
            return generation.read(job["id"])
        return asyncio.run(go())

    def test_output_limit_and_temperature_reach_the_request_body(self):
        data, _, _ = generation.checked(self.payload(max_tokens=16, temperature=0))
        self.assertEqual(data["params"], {"max_tokens": 16, "temperature": 0})
        job = self.run_job(self.payload(max_tokens=16, temperature=0))
        self.assertEqual(job["status"], "succeeded", job.get("error"))
        self.assertEqual(self.sent[-1]["max_tokens"], 16)
        self.assertEqual(self.sent[-1]["temperature"], 0)
        self.assertNotIn("max_completion_tokens", self.sent[-1])

    def test_reasoning_models_use_the_completion_limit_that_includes_thinking(self):
        self.model = "gpt-5-mini"
        job = self.run_job(self.payload(max_tokens=16))
        self.assertEqual(self.sent[-1]["max_completion_tokens"], 16)
        self.assertNotIn("max_tokens", self.sent[-1])
        self.assertEqual(job["children"][0]["output_limit"], {"field": "max_completion_tokens", "value": 16, "includes_reasoning": True})

    def test_invalid_limits_are_rejected_not_dropped(self):
        for params in ({"max_tokens": 0}, {"max_tokens": "多"}, {"max_tokens": 10 ** 7}, {"temperature": 3}):
            with self.subTest(params=params):
                with self.assertRaises(HTTPException) as caught:
                    generation.checked(self.payload(**params))
                self.assertEqual(caught.exception.status_code, 400)

    def test_reasoning_model_rejects_temperature_explicitly(self):
        self.model = "gpt-5-mini"
        with self.assertRaises(HTTPException) as caught:
            generation.checked(self.payload(temperature=0))
        self.assertIn("温度", caught.exception.detail)

    def test_success_receipt_keeps_upstream_ids_and_marks_unknown_cost_pending(self):
        job = self.run_job(self.payload())
        child = job["children"][0]
        self.assertEqual(child["upstream_response_id"], "chatcmpl-123")
        self.assertEqual(child["platform_request_id"], "req-abc-123")
        self.assertEqual(child["billing"], {"status": "pending", "note": "平台未返回金额，待与账单核对；不是 0 元。"})
        self.assertNotIn("dummy-key", json.dumps(job, ensure_ascii=False))

    def test_reported_amount_is_kept_apart_from_estimates(self):
        self.reply = httpx.Response(200, headers={"request-id": "req-xyz"}, json={
            "id": "chatcmpl-9", "choices": [{"message": {"content": "好"}}], "usage": {"total_tokens": 3, "amount": 0.0012, "currency": "CNY"}})
        child = self.run_job(self.payload())["children"][0]
        self.assertEqual(child["billing"], {"status": "reported", "amount": 0.0012, "currency": "CNY"})

    def test_redacted_submission_snapshot_links_job_model_files_and_order(self):
        # REF-03: recorded locally before the POST; no key or signature is stored.
        import hashlib
        folder = Path(core.storage_kind_dir("upload")); folder.mkdir(parents=True, exist_ok=True)
        (folder / "ref-person.png").write_bytes(b"person-bytes")
        payload = generation.Generation(request_id="llm-" + uuid.uuid4().hex[:12], provider_id="deepwhite", model=self.model, kind="chat",
                                        prompt="描述参考1", references=[
                                            {"url": "/api/storage-files/upload/ref-person.png", "kind": "image", "label": "参考1"},
                                            {"url": "https://public.example.com/scene.png?token=abc", "kind": "image"}])
        job = self.run_job(payload)
        snap = job["children"][0]["submission"]
        self.assertEqual(snap["recorded"], "local_before_send")
        self.assertEqual((snap["job_id"], snap["model"], snap["request_version"]), (job["id"], self.model, generation.SUBMISSION_VERSION))
        first, second = snap["references"]
        self.assertEqual((first["position"], first["source"], first["label"]), (1, "/api/storage-files/upload/ref-person.png", "参考1"))
        self.assertEqual(first["sha256"], hashlib.sha256(b"person-bytes").hexdigest())
        self.assertEqual(first["uploaded_as"], "https://cdn.example.com/f/ref-1.png")
        self.assertEqual((second["position"], second["uploaded_as"], second["sha256"]), (2, "https://public.example.com/scene.png", ""))
        self.assertEqual(snap["body_sha256"], hashlib.sha256(json.dumps(self.sent[-1], ensure_ascii=False, sort_keys=True).encode()).hexdigest())
        # The request keeps the caller's own URL (needed to run); the receipt records none of the secrets.
        stored = json.dumps(job["children"], ensure_ascii=False)
        for secret in ("secret-sig", "X-Signature", "dummy-key", "token=abc"):
            self.assertNotIn(secret, stored)
        self.assertNotIn("dummy-key", json.dumps(job, ensure_ascii=False))

    def test_failed_reply_keeps_its_identifiers(self):
        self.reply = httpx.Response(400, headers={"x-request-id": "req-fail-1"}, json={"id": "err-77", "error": {"message": "bad"}})
        job = self.run_job(self.payload())
        child = job["children"][0]
        self.assertEqual(job["status"], "failed")
        self.assertEqual(child["platform_request_id"], "req-fail-1")
        self.assertEqual(child["upstream_response_id"], "err-77")


if __name__ == "__main__":
    unittest.main()
