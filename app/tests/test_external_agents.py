"""External agents: client setup, Skills, packages, wider graph edits, feedback, lazy bridge.

All client files live in a temporary home; the real user profile is never touched.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-external-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import httpx
import studio_server
import main as core
import studio_canvas_services as plans
import studio_clients
import studio_control as control
import studio_feedback
import studio_mcp
from fastapi.testclient import TestClient

ORIGIN = "http://testserver"


class Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        state = control._load()
        state["enabled"] = True
        control._save(state)
        self.token = state["token"]
        self.project = core.new_project("外接测试")

    def call(self, name, arguments=None, status=200):
        response = self.client.post("/api/studio/control/call", json={"name": name, "arguments": arguments or {}},
                                    headers={"Authorization": "Bearer " + self.token})
        self.assertEqual(response.status_code, status, response.text)
        return response.json().get("result", response.json())


class PackageTests(Base):
    def test_list_and_import_is_idempotent_with_variables(self):
        items = {item["id"]: item for item in self.call("list_canvas_packages")["items"]}
        self.assertIn("film-short", items)
        self.assertIn("主题", items["film-short"]["variables"])
        args = {"package_id": "film-short", "project_id": self.project["id"],
                "expected_revision": self.call("list_projects")["revision"],
                "operation_id": uuid.uuid4().hex, "variables": {"主题": "雨夜侦探", "风格": "黑色电影"}}
        first = self.call("import_canvas_package", args)
        again = self.call("import_canvas_package", args)
        self.assertEqual(first["canvas_id"], again["canvas_id"])
        self.assertEqual(first["node_ids"], again["node_ids"])
        canvas = core.load_canvas(first["canvas_id"])
        self.assertEqual(canvas["title"], "全自动影视 · 雨夜侦探")
        self.assertEqual(len(canvas["nodes"]), items["film-short"]["node_count"])
        titles = {node.get("studioTitle") for node in canvas["nodes"]}
        self.assertTrue({"剧本", "分镜表", "镜头 1"} <= titles)
        self.assertIn("雨夜侦探", json.dumps(canvas, ensure_ascii=False))
        self.assertTrue(all(node["type"] == "prompt" for node in canvas["nodes"]))

    def test_unknown_package_is_rejected(self):
        self.call("import_canvas_package", {"package_id": "missing", "project_id": self.project["id"],
                  "expected_revision": self.call("list_projects")["revision"], "operation_id": uuid.uuid4().hex}, 404)


class GraphRuleTests(Base):
    def setUp(self):
        super().setUp()
        canvas = core.new_canvas("rules", project=self.project["id"])
        canvas = core.load_canvas(canvas["id"])
        canvas["nodes"] = [{"id": "img", "type": "image", "x": 0, "y": 0},
                           {"id": "gen1", "type": "generator", "x": 300, "y": 0},
                           {"id": "gen2", "type": "video", "x": 600, "y": 0},
                           {"id": "out", "type": "output", "x": 900, "y": 0}]
        core.save_canvas(canvas)
        self.cid = canvas["id"]

    def edit(self, operations, status=200):
        return self.call("edit_canvas", {"canvas_id": self.cid, "operation_id": uuid.uuid4().hex,
            "expected_revision": plans.revision(core.load_canvas(self.cid)), "operations": operations}, status)

    def test_canvas_connection_rules_rename_and_delete_any_node(self):
        self.edit([{"op": "connect", "from": "img", "to": "gen1"}, {"op": "connect", "from": "gen1", "to": "gen2"},
                   {"op": "connect", "from": "gen2", "to": "out"}, {"op": "rename_node", "node_id": "gen1", "title": "关键帧"}])
        canvas = core.load_canvas(self.cid)
        self.assertEqual(len(canvas["connections"]), 3)
        self.assertEqual(next(n for n in canvas["nodes"] if n["id"] == "gen1")["studioTitle"], "关键帧")
        self.edit([{"op": "connect", "from": "gen2", "to": "gen1"}], 400)  # cycle
        self.edit([{"op": "add_prompt", "key": "a", "text": "x", "x": 0, "y": 0, "title": "说明"},
                   {"op": "connect", "from": "$a", "to": "img"}], 400)  # prompt -> image is not a canvas link
        self.edit([{"op": "delete_node", "node_id": "gen1"}])
        canvas = core.load_canvas(self.cid)
        self.assertNotIn("gen1", [n["id"] for n in canvas["nodes"]])
        self.assertEqual([(c["from"], c["to"]) for c in canvas["connections"]], [("gen2", "out")])


class FeedbackTests(Base):
    def test_agent_feedback_falls_back_to_github_issue_link(self):
        with patch.dict(os.environ, {"DEEPWHITE_FEEDBACK_WEBHOOK": ""}):
            result = self.call("submit_feedback", {"category": "suggestion", "title": "希望支持批量导入",
                                                   "description": "希望一次导入多个分镜脚本。"})
        self.assertEqual(result["channel"], "github")
        self.assertTrue(result["issue_url"].startswith("https://github.com/344996/deepwhite-studio-collab/issues/new?"))
        self.assertEqual(result["source"], "mcp")
        self.assertFalse(result["sent"])

    def test_webhook_delivery_marks_feedback_sent(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"code": 0})
        with patch.object(studio_feedback, "TRANSPORT", httpx.MockTransport(handler)), \
                patch.dict(os.environ, {"DEEPWHITE_FEEDBACK_WEBHOOK": "feishu|https://open.feishu.cn/hook/x"}):
            result = self.call("submit_feedback", {"category": "bug", "title": "导出失败",
                                                   "description": "点击导出后没有反应。", "contact": "qq 123"})
        self.assertTrue(result["sent"])
        self.assertEqual(result["channel"], "webhook")
        self.assertEqual(seen[0]["msg_type"], "text")
        self.assertIn("导出失败", seen[0]["content"]["text"])


class ClientTests(Base):
    def setUp(self):
        super().setUp()
        self.home = tempfile.TemporaryDirectory(prefix="dw-home-")
        home = Path(self.home.name)
        self.env = patch.dict(os.environ, {"USERPROFILE": str(home), "HOME": str(home),
            "APPDATA": str(home / "Roaming"), "LOCALAPPDATA": str(home / "Local"),
            "CODEX_HOME": str(home / ".codex"), "CLAUDE_CONFIG_DIR": "", "HERMES_HOME": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.home.cleanup)
        self.root = home
        for folder in (".codex", ".claude", ".workbuddy", "Local/hermes", "Roaming/Claude"):
            (home / folder).mkdir(parents=True, exist_ok=True)

    def act(self, client_id, action, status=200, origin=ORIGIN):
        response = self.client.post(f"/api/studio/clients/{client_id}", json={"action": action},
                                    headers={"Origin": origin})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def listing(self):
        return {item["id"]: item for item in self.client.get("/api/studio/clients").json()["items"]}

    def test_claude_code_connect_preserves_settings_and_disconnects(self):
        config = self.root / ".claude.json"
        config.write_text(json.dumps({"theme": "dark", "mcpServers": {"other": {"command": "x"}}}), encoding="utf-8")
        result = self.act("claude_code", "connect")
        self.assertTrue(result["changed"])
        data = json.loads(config.read_text(encoding="utf-8"))
        self.assertEqual(data["theme"], "dark")
        self.assertIn("other", data["mcpServers"])
        self.assertEqual(data["mcpServers"]["deepwhite-studio"]["type"], "stdio")
        self.assertTrue(Path(result["backup"]).is_file())
        self.assertEqual(self.listing()["claude_code"]["mcp"]["state"], "connected")
        self.assertFalse(self.act("claude_code", "connect")["changed"])
        self.act("claude_code", "disconnect")
        self.assertNotIn("deepwhite-studio", json.loads(config.read_text(encoding="utf-8"))["mcpServers"])

    def test_workbuddy_and_desktop_json_and_codex_toml(self):
        self.act("workbuddy", "connect")
        self.assertIn("deepwhite-studio", json.loads((self.root / ".workbuddy/mcp.json").read_text(encoding="utf-8"))["mcpServers"])
        self.act("claude_desktop", "connect")
        self.assertTrue((self.root / "Roaming/Claude/claude_desktop_config.json").is_file())
        (self.root / ".codex/config.toml").write_text('model = "x"\n', encoding="utf-8")
        self.act("codex", "connect")
        text = (self.root / ".codex/config.toml").read_text(encoding="utf-8")
        self.assertIn('model = "x"', text)
        self.assertIn("[mcp_servers.deepwhite-studio]", text)
        self.assertEqual(self.listing()["codex"]["mcp"]["state"], "connected")
        self.act("codex", "disconnect")
        self.assertNotIn("deepwhite-studio", (self.root / ".codex/config.toml").read_text(encoding="utf-8"))

    def test_hermes_yaml_keeps_other_servers(self):
        config = self.root / "Local/hermes/config.yaml"
        config.write_text("model: hermes-4\nmcp_servers:\n  other:\n    command: \"x\"\nterminal:\n  backend: local\n", encoding="utf-8")
        self.act("hermes", "connect")
        text = config.read_text(encoding="utf-8")
        self.assertIn("  other:\n    command: \"x\"", text)
        self.assertIn("  deepwhite-studio:", text)
        self.assertIn("terminal:\n  backend: local", text)
        self.assertEqual(self.listing()["hermes"]["mcp"]["state"], "connected")
        self.act("hermes", "disconnect")
        self.assertNotIn("deepwhite-studio", config.read_text(encoding="utf-8"))
        self.assertIn("  other:", config.read_text(encoding="utf-8"))

    def test_skills_install_upgrade_with_backup_and_manual_clients(self):
        result = self.act("claude_code", "install_skills")
        installed = {row["id"]: row for row in result["client"]["skills"]}
        self.assertTrue(all(row["state"] == "latest" for row in installed.values()))
        marker = self.root / ".claude/skills/deepwhite-canvas/.deepwhite-skill.json"
        data = json.loads(marker.read_text(encoding="utf-8"))
        data["version"] = "0.9.0"
        marker.write_text(json.dumps(data), encoding="utf-8")
        (self.root / ".claude/skills/deepwhite-canvas/SKILL.md").write_text("用户改过", encoding="utf-8")
        self.assertEqual({r["id"]: r for r in self.listing()["claude_code"]["skills"]}["deepwhite-canvas"]["state"], "upgrade")
        result = self.act("claude_code", "install_skills")
        upgraded = next(row for row in result["skills"] if row["id"] == "deepwhite-canvas")
        self.assertTrue(upgraded["changed"])
        self.assertEqual((Path(upgraded["backup"]) / "SKILL.md").read_text(encoding="utf-8"), "用户改过")
        self.assertIn("version: \"1.1.0\"", (self.root / ".claude/skills/deepwhite-canvas/SKILL.md").read_text(encoding="utf-8"))
        self.act("doubao", "connect", 409)
        self.act("claude_desktop", "install_skills", 409)
        archive = self.client.get("/api/studio/clients/skills/deepwhite-film.zip")
        self.assertEqual(archive.status_code, 200)
        self.assertEqual(archive.headers["content-type"], "application/zip")

    def test_doubao_leftover_user_data_is_not_an_installation(self):
        (self.root / "Local/Doubao/User Data").mkdir(parents=True)
        (self.root / "Local/Doubao/Application").mkdir(parents=True)
        self.assertFalse(self.listing()["doubao"]["detected"])
        (self.root / "Local/Doubao/Application/Doubao.exe").write_bytes(b"")
        self.assertTrue(self.listing()["doubao"]["detected"])

    def test_writes_require_local_settings_page(self):
        self.act("claude_code", "connect", 403, origin="http://evil.example")
        self.assertFalse((self.root / ".claude.json").exists())


class LazyBridgeTests(unittest.TestCase):
    def test_bridge_starts_and_lists_tools_without_running_canvas(self):
        bridge = studio_mcp.Bridge("http://127.0.0.1:9")
        self.assertIsNone(bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        reply = bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
        self.assertIn("result", reply)
        bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        names = [tool["name"] for tool in bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]]
        self.assertIn("studio_status", names)
        self.assertIn("import_canvas_package", names)
        failed = bridge.call_tool("list_canvases", {})
        self.assertTrue(failed["isError"])
        self.assertIn("未监听", failed["content"][0]["text"])
        status = bridge.call_tool("studio_status", {})
        self.assertFalse(status["isError"])
        self.assertFalse(status["structuredContent"]["ok"])
        self.assertIn("未通过", status["structuredContent"]["summary"])


if __name__ == "__main__":
    unittest.main()
