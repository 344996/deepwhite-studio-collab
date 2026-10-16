"""Agent API tests with isolated persistence and mocked model transport only."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI

TEST_RUNTIME = tempfile.TemporaryDirectory(prefix="dw-agent-runtime-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = TEST_RUNTIME.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as main_core
import studio_agent


CHAT_MODELS = [{"provider_id": "test", "model": "gpt-4o", "label": "GPT 4o"}]
TARGETS = [
    {"provider_id": "test", "model": "image-model", "label": "Test image", "kind": "image"},
    {"provider_id": "test", "model": "video-model", "label": "Test video", "kind": "video"},
]


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "data"
        self.data.mkdir()
        self.app = FastAPI()
        self.old_agent_core = studio_agent.core
        self.providers = [{"id": "test", "name": "Test API", "base_url": "https://api.example.test/v1",
                           "enabled": True, "protocol": "openai", "chat_models": ["gpt-4o"], "model_names": {}}]
        self.core = SimpleNamespace(app=self.app, DATA_DIR=str(self.data), load_api_providers=lambda: self.providers,
                                    provider_env_key_value=lambda provider_id: "test-secret",
                                    output_file_from_url=self.resolve)
        self.context_assets = []
        self.context_nodes = []

        def context(canvas_id, node_ids=None, asset_version_ids=None):
            return {"canvas_id": canvas_id, "project_id": "project-a", "base_updated_at": 10,
                    "base_revision": "revision", "nodes": list(self.context_nodes),
                    "assets": list(self.context_assets), "models": []}

        self.patches = [
            patch.object(main_core, "DATA_DIR", str(self.data)),
            patch.object(studio_agent, "_get_context", side_effect=context),
            patch.object(studio_agent, "_catalog_data", return_value=(CHAT_MODELS, TARGETS)),
            patch.object(studio_agent, "_plan_api", return_value=SimpleNamespace(
                validate_plan=lambda raw, ctx, targets: {"id": "plan-1", "nodes": raw["nodes"], "context_revision": ctx["base_revision"]},
                project_assets=lambda project_id: [])),
        ]
        for item in self.patches:
            item.start()
        studio_agent.install(self.core)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://testserver")

    async def asyncTearDown(self):
        await self.client.aclose()
        studio_agent.core = self.old_agent_core
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def resolve(self, url):
        if isinstance(url, str) and url.startswith("/api/studio/assets/"):
            version_id = url.split("/")[4]
            p = self.data / "studio-assets" / "candidates" / "project-a" / f"{version_id}.png"
            return str(p) if p.is_file() else None
        return None

    async def create_session(self):
        response = await self.client.post("/api/studio/agent/sessions", json={"canvas_id": "canvas-a"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["session"]

    async def wait_for_status(self, sid, wanted="completed"):
        for _ in range(200):
            response = await self.client.get(f"/api/studio/agent/sessions/{sid}")
            self.assertEqual(response.status_code, 200, response.text)
            session = response.json()["session"]
            if session["status"] in (wanted, "failed", "interrupted"):
                return session
            await asyncio.sleep(0.01)
        self.fail("Agent session did not finish in time")

    async def test_bootstrap_session_idempotency_tool_loop_and_plan_snapshot(self):
        skill_root = self.data / "studio_skills"
        skill_root.mkdir()
        sid_skill = "a" * 32
        (skill_root / f"{sid_skill}.json").write_text(json.dumps({"id": sid_skill, "name": "Scene helper", "files": {
            "SKILL.md": "Write concise scenes.", "references/camera.md": "Use an eye-level medium shot."}}, ensure_ascii=False), encoding="utf-8")
        bootstrap = await self.client.get("/api/studio/agent/bootstrap", params={"canvas_id": "canvas-a"})
        self.assertEqual(bootstrap.status_code, 200, bootstrap.text)
        self.assertEqual(bootstrap.json()["models"], CHAT_MODELS)
        self.assertEqual(bootstrap.json()["skills"], [{"id": sid_skill, "name": "Scene helper"}])
        session = await self.create_session()

        calls = []
        def handler(request):
            calls.append(request)
            body = json.loads(request.content)
            self.assertEqual(request.headers["authorization"], "Bearer test-secret")
            if len(calls) == 1:
                return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "tool_calls": [{
                    "id": "call-1", "type": "function", "function": {"name": "read_skill_reference",
                    "arguments": json.dumps({"skill_id": sid_skill, "path": "references/camera.md"})}}]}}],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}})
            tool_result = next(m for m in body["messages"] if m["role"] == "tool")
            self.assertIn("eye-level", tool_result["content"])
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": json.dumps({
                "reply": "Draft ready.", "plan": {"nodes": [{"key": "shot1", "kind": "image", "title": "Shot", "prompt": "A quiet room", "references": []}]}
            })}}], "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6}})

        real_client = httpx.AsyncClient
        with patch.object(studio_agent.httpx, "AsyncClient", side_effect=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})):
            accepted = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "request-0001", "message": "Plan one image.", "provider_id": "test", "model": "gpt-4o",
                "skill_ids": [sid_skill], "image_model": {"provider_id": "test", "model": "image-model"}})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            completed = await self.wait_for_status(session["id"])
            self.assertEqual(completed["turns"][0]["status"], "completed")
            self.assertEqual(completed["turns"][0]["plan"]["id"], "plan-1")
            self.assertEqual(completed["turns"][0]["usage"]["total_tokens"], 9)
            self.assertEqual(len(calls), 2)
            duplicate = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "request-0001", "message": "Do not submit twice", "provider_id": "test", "model": "gpt-4o"})
            self.assertEqual(duplicate.status_code, 200, duplicate.text)
            self.assertEqual(len(calls), 2)

    async def test_text_and_docx_attachments_are_session_bound(self):
        session = await self.create_session()
        text = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/attachments",
                                      files={"file": ("notes.md", "Scene notes".encode(), "text/markdown")})
        self.assertEqual(text.status_code, 200, text.text)
        self.assertEqual(text.json()["name"], "notes.md")
        bad = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/attachments",
                                     files={"file": ("script.py", b"print(1)", "text/plain")})
        self.assertEqual(bad.status_code, 415)
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("word/document.xml", "<w:document xmlns:w='urn:w'><w:body><w:p><w:r><w:t>DOCX text</w:t></w:r></w:p></w:body></w:document>")
        docx = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/attachments",
                                      files={"file": ("brief.docx", buffer.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
        self.assertEqual(docx.status_code, 200, docx.text)
        saved = studio_agent.read_session(session["id"])
        self.assertEqual(saved["attachments"][0]["text"], "Scene notes")
        self.assertEqual(saved["attachments"][1]["text"], "DOCX text")

        calls = []
        def handler(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                return httpx.Response(200, json={"choices": [{"message": {"content": "I read both documents."}}]})
            prior_user = next(m["content"] for m in calls[1]["messages"] if m["role"] == "user")
            self.assertIn("DOCX text", prior_user)
            self.assertIn("Scene notes", prior_user)
            return httpx.Response(200, json={"choices": [{"message": {"content": "I remember the documents."}}]})
        real_client = httpx.AsyncClient
        with patch.object(studio_agent.httpx, "AsyncClient", side_effect=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})):
            first_turn = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "docs-0001", "message": "Read these.", "provider_id": "test", "model": "gpt-4o",
                "attachment_ids": [text.json()["id"], docx.json()["id"]]})
            self.assertEqual(first_turn.status_code, 200, first_turn.text)
            await self.wait_for_status(session["id"])
            second_turn = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "docs-0002", "message": "What did the files say?", "provider_id": "test", "model": "gpt-4o"})
            self.assertEqual(second_turn.status_code, 200, second_turn.text)
            completed = await self.wait_for_status(session["id"])
        self.assertEqual(completed["turns"][-1]["reply"], "I remember the documents.")

    async def test_unknown_tool_is_refused_and_interrupted_session_is_not_retried(self):
        session = await self.create_session()
        hits = []
        def handler(request):
            hits.append(json.loads(request.content))
            if len(hits) == 1:
                return httpx.Response(200, json={"choices": [{"message": {"tool_calls": [{"id": "x", "type": "function",
                    "function": {"name": "delete_canvas", "arguments": "{}"}}]}}]})
            tool_result = next(m for m in hits[1]["messages"] if m["role"] == "tool")
            self.assertIn("未提供", tool_result["content"])
            return httpx.Response(200, json={"choices": [{"message": {"content": "The unknown tool was ignored."}}]})
        real_client = httpx.AsyncClient
        with patch.object(studio_agent.httpx, "AsyncClient", side_effect=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})):
            response = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "unknown-0001", "message": "Delete the canvas.", "provider_id": "test", "model": "gpt-4o"})
            self.assertEqual(response.status_code, 200, response.text)
            complete = await self.wait_for_status(session["id"])
        self.assertEqual(complete["turns"][0]["reply"], "The unknown tool was ignored.")
        self.assertEqual(len(hits), 2)

        other = await self.create_session()
        saved = studio_agent.read_session(other["id"])
        saved["status"] = "running"
        saved["turns"].append({"request_id": "interrupted-01", "status": "running"})
        studio_agent.save_session(saved)
        interrupted = await self.client.get(f"/api/studio/agent/sessions/{other['id']}")
        self.assertEqual(interrupted.json()["session"]["status"], "interrupted")
        self.assertEqual(interrupted.json()["session"]["turns"][0]["status"], "interrupted")

    async def test_failed_revised_plan_clears_active_plan_but_keeps_history(self):
        session = await self.create_session()
        replies = [json.dumps({"reply": "Plan ready.", "plan": {"nodes": [{"key": "a", "kind": "image"}]}}),
                   '{"reply":"unfinished","plan":{"nodes":[]}']
        def handler(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": replies.pop(0)}}]})
        real_client = httpx.AsyncClient
        with patch.object(studio_agent.httpx, "AsyncClient", side_effect=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})):
            first = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "plan-0001", "message": "Draft it.", "provider_id": "test", "model": "gpt-4o",
                "image_model": {"provider_id": "test", "model": "image-model"}})
            self.assertEqual(first.status_code, 200, first.text)
            await self.wait_for_status(session["id"])
            second = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "plan-0002", "message": "Revise it.", "provider_id": "test", "model": "gpt-4o"})
            self.assertEqual(second.status_code, 200, second.text)
            failed = await self.wait_for_status(session["id"], "failed")
        self.assertIsNone(failed["plan"])
        self.assertEqual(failed["turns"][0]["plan"]["id"], "plan-1")
        self.assertEqual(failed["turns"][1]["status"], "failed")

    async def test_vision_is_opt_in_and_uses_only_local_context_images(self):
        version = "b" * 32
        image = self.data / "studio-assets" / "candidates" / "project-a" / f"{version}.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"PNG test bytes")
        self.context_assets.append({"version_id": version, "asset_id": "c" * 32, "name": "portrait", "kind": "image",
                                    "url": f"/api/studio/assets/{version}/file", "missing": False})
        session = await self.create_session()
        bodies = []
        def handler(request):
            body = json.loads(request.content)
            bodies.append(body)
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"reply": "I viewed the selected image.", "plan": None})}}],
                                             "usage": {"total_tokens": 2}})
        real_client = httpx.AsyncClient
        with patch.object(studio_agent.httpx, "AsyncClient", side_effect=lambda **kw: real_client(
                transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"})):
            response = await self.client.post(f"/api/studio/agent/sessions/{session['id']}/messages", json={
                "request_id": "vision-0001", "message": "Describe this picture.", "provider_id": "test", "model": "gpt-4o",
                "asset_version_ids": [version], "vision": True})
            self.assertEqual(response.status_code, 200, response.text)
            finished = await self.wait_for_status(session["id"])
        user_content = bodies[0]["messages"][-1]["content"]
        self.assertTrue(any(part.get("type") == "text" and version in part.get("text", "") for part in user_content))
        self.assertTrue(any(part.get("type") == "image_url" and part["image_url"]["url"].startswith("data:image/png;base64,") for part in user_content))
        self.assertEqual(finished["turns"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
