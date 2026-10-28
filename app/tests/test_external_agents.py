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


class SmartCanvasTests(Base):
    def setUp(self):
        super().setUp()
        canvas = core.load_canvas(core.new_canvas("smart", kind="smart", project=self.project["id"])["id"])
        canvas["nodes"] = [{"id": "img", "type": "smart-image", "x": 0, "y": 0, "images": []},
                           {"id": "loop", "type": "smart-loop", "x": 400, "y": 0, "showPrompt": False, "imageInput": False}]
        canvas["connections"] = []
        core.save_canvas(canvas)
        self.cid = canvas["id"]

    def edit(self, operations, status=200, operation_id=None):
        return self.call("edit_canvas", {"canvas_id": self.cid, "operation_id": operation_id or uuid.uuid4().hex,
            "expected_revision": plans.revision(core.load_canvas(self.cid)), "operations": operations}, status)

    def test_list_and_read_smart_canvas(self):
        items = {item["id"]: item for item in self.call("list_canvases", {"project_id": self.project["id"]})["items"]}
        self.assertEqual(items[self.cid]["kind"], "smart")
        read = self.call("get_canvas", {"canvas_id": self.cid})
        self.assertEqual(read["kind"], "smart")
        self.assertEqual(len(read["canvas"]["nodes"]), 2)

    def test_prompt_nodes_loop_inputs_disconnect_delete_and_undo(self):
        result = self.edit([{"op": "add_prompt", "key": "p", "text": "雨夜街道", "x": 0, "y": 300, "title": "分镜一"},
                            {"op": "connect", "from": "$p", "to": "loop"},
                            {"op": "connect", "from": "img", "to": "loop"},
                            {"op": "rename_node", "node_id": "img", "title": "参考图"}])
        canvas = core.load_canvas(self.cid)
        prompt = next(n for n in canvas["nodes"] if n["id"] == result["node_ids"]["p"])
        self.assertEqual((prompt["type"], prompt["title"], prompt["text"]), ("smart-prompt", "分镜一", "雨夜街道"))
        loop = next(n for n in canvas["nodes"] if n["id"] == "loop")
        self.assertTrue(loop["showPrompt"] and loop["imageInput"])
        self.assertEqual(set(loop["inputNodeIds"]), {prompt["id"], "img"})
        self.assertTrue(all(c["kind"] == "input" for c in canvas["connections"]))
        self.assertEqual(next(n for n in canvas["nodes"] if n["id"] == "img")["title"], "参考图")
        self.edit([{"op": "disconnect_nodes", "from": "img", "to": "loop"}, {"op": "delete_node", "node_id": prompt["id"]}])
        canvas = core.load_canvas(self.cid)
        loop = next(n for n in canvas["nodes"] if n["id"] == "loop")
        self.assertEqual(loop["inputNodeIds"], [])
        self.assertEqual(canvas["connections"], [])
        operation = uuid.uuid4().hex
        receipt = self.edit([{"op": "update_prompt", "node_id": "img", "text": "x"}], 400, operation)
        self.assertIn("smart-prompt", json.dumps(receipt, ensure_ascii=False))
        undo_op = uuid.uuid4().hex
        done = self.edit([{"op": "move_node", "node_id": "loop", "x": 900, "y": 10}], operation_id=undo_op)
        self.call("undo_edit", {"canvas_id": self.cid, "operation_id": undo_op, "expected_revision": done["revision"]})
        self.assertEqual(next(n for n in core.load_canvas(self.cid)["nodes"] if n["id"] == "loop")["x"], 400)

    def test_smart_canvases_can_no_longer_be_created(self):
        # U10 (handover 2026-10-26): smart canvases are retired; agents create classic ones only.
        before = len(core.list_canvases())
        self.call("create_canvas", {"project_id": self.project["id"], "title": "智能分镜", "kind": "smart",
                                    "expected_revision": self.call("list_projects")["revision"],
                                    "operation_id": uuid.uuid4().hex}, 400)
        self.assertEqual(len(core.list_canvases()), before)

    def test_generation_tools_stay_ordinary_only(self):
        self.call("apply_nodes", {"canvas_id": self.cid, "operation_id": uuid.uuid4().hex,
                                  "expected_revision": plans.revision(core.load_canvas(self.cid)),
                                  "nodes": [{"key": "a", "kind": "image", "title": "t", "prompt": "p",
                                             "provider_id": "x", "model": "y"}]}, 400)


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
        studio_clients._verification_path().unlink(missing_ok=True)

    def act(self, client_id, action, status=200, origin=ORIGIN):
        response = self.client.post(f"/api/studio/clients/{client_id}", json={"action": action},
                                    headers={"Origin": origin})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def listing(self):
        return {item["id"]: item for item in self.client.get("/api/studio/clients").json()["items"]}

    def test_page_lists_exactly_the_five_agents_with_a_verification_command(self):
        # U11 (handover 2026-10-26): Codex, Claude Code, WorkBuddy, 豆包工作, DeepSeek Harness only.
        items = self.client.get("/api/studio/clients").json()["items"]
        self.assertEqual([(i["id"], i["name"]) for i in items], [
            ("codex", "Codex"), ("claude_code", "Claude Code"), ("workbuddy", "WorkBuddy"),
            ("doubao", "豆包工作"), ("deepseek_harness", "DeepSeek Harness")])
        for item in items:
            self.assertRegex(item["verification"]["code"], r"^DW-[0-9A-F]{6}$")
            self.assertIn(item["verification"]["code"], item["verification"]["command"])
            self.assertEqual(item["verification"]["verified_at"], 0)
            self.assertNotIn("Key", item["verification"]["command"])
        harness = items[-1]
        self.assertEqual((harness["detected"], harness["detectable"], harness["mcp"]["state"]), (False, False, "manual"))
        self.assertIn("mcpServers", harness["manual"]["text"])

    def test_only_the_real_agent_call_marks_a_client_verified_and_reconnect_resets_it(self):
        self.act("claude_code", "connect")
        listed = self.listing()["claude_code"]
        self.assertEqual(listed["mcp"]["state"], "connected")
        self.assertEqual(listed["verification"]["verified_at"], 0, "written config must not count as verified")
        canvas = core.new_canvas("验证用画布", project=self.project["id"])
        result = self.call("verify_client", {"code": listed["verification"]["code"]})
        self.assertEqual((result["verified"], result["client"]), (True, "Claude Code"))
        self.assertEqual(result["canvas"], {"title": "验证用画布", "node_count": len(core.load_canvas(canvas["id"])["nodes"])})
        self.assertGreater(self.listing()["claude_code"]["verification"]["verified_at"], 0)
        self.assertEqual(self.listing()["codex"]["verification"]["verified_at"], 0, "another client was marked")
        self.act("claude_code", "connect")
        self.assertEqual(self.listing()["claude_code"]["verification"]["verified_at"], 0)
        self.call("verify_client", {"code": "DW-000000"}, 404)

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
        # Hermes is no longer listed on the page (U11) but stays connectable through the API.
        self.assertEqual(self.act("hermes", "connect")["client"]["mcp"]["state"], "connected")
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
        # Clients load every subfolder of skills/; backups and staging must stay outside it.
        skills = self.root / ".claude/skills"
        self.assertNotEqual(Path(upgraded["backup"]).parent, skills)
        self.assertEqual(sorted(p.name for p in skills.iterdir()), ["deepwhite-avatar", "deepwhite-canvas", "deepwhite-film"])
        latest = next(s["version"] for s in studio_clients.catalog() if s["id"] == "deepwhite-canvas")
        self.assertIn(f"version: \"{latest}\"", (self.root / ".claude/skills/deepwhite-canvas/SKILL.md").read_text(encoding="utf-8"))
        self.act("doubao", "connect", 409)
        self.act("claude_desktop", "install_skills", 409)
        archive = self.client.get("/api/studio/clients/skills/deepwhite-film.zip")
        self.assertEqual(archive.status_code, 200)
        self.assertEqual(archive.headers["content-type"], "application/zip")

    def test_failed_upgrade_restores_the_previous_skill(self):
        # SKILL-ROLLBACK (2026-10-26 review, R4): the old copy was moved to a backup first, so a
        # failing final move left no active Skill at all.
        self.act("claude_code", "install_skills")
        folder = self.root / ".claude/skills/deepwhite-canvas"
        (folder / "SKILL.md").write_text("用户改过", encoding="utf-8")
        original_move = studio_clients.shutil.move
        def move(source, target):
            if Path(target) == folder and ".deepwhite-skill-staging-" in str(source):
                raise OSError("disk full while activating")
            return original_move(source, target)
        with patch.object(studio_clients.shutil, "move", side_effect=move):
            detail = self.act("claude_code", "install_skills", 409)["detail"]
        self.assertTrue((folder / "SKILL.md").is_file(), "the active Skill folder is gone after the failed upgrade")
        self.assertEqual((folder / "SKILL.md").read_text(encoding="utf-8"), "用户改过")
        self.assertIn("已恢复", detail)
        skills = self.root / ".claude/skills"
        self.assertEqual(sorted(p.name for p in skills.iterdir()), ["deepwhite-avatar", "deepwhite-canvas", "deepwhite-film"])
        self.assertFalse(any(p.name.startswith(".deepwhite-skill-staging-") for p in skills.parent.iterdir()))

    def test_skill_with_missing_entry_is_damaged_and_install_repairs_it(self):
        # CLIENT-01: a version marker alone must not count as "latest".
        self.act("claude_code", "install_skills")
        folder = self.root / ".claude/skills/deepwhite-canvas"
        (folder / "SKILL.md").unlink()
        (self.root / ".claude/skills/deepwhite-film/SKILL.md").write_text("用户改过", encoding="utf-8")
        rows = {r["id"]: r for r in self.listing()["claude_code"]["skills"]}
        self.assertEqual(rows["deepwhite-canvas"]["state"], "damaged")
        self.assertEqual(rows["deepwhite-film"]["state"], "modified")
        self.assertEqual(rows["deepwhite-avatar"]["state"], "latest")
        result = self.act("claude_code", "install_skills")
        changed = {row["id"]: row["changed"] for row in result["skills"]}
        self.assertEqual(changed, {"deepwhite-canvas": True, "deepwhite-film": True, "deepwhite-avatar": False})
        marker = json.loads((folder / ".deepwhite-skill.json").read_text(encoding="utf-8"))
        content = (folder / "SKILL.md").read_bytes()
        self.assertEqual(marker["sha256"]["SKILL.md"], __import__("hashlib").sha256(content).hexdigest())
        self.assertTrue(all(row["state"] == "latest" for row in result["client"]["skills"]))

    def test_failed_connect_leaves_mcp_switch_unchanged(self):
        # CLIENT-02: the MCP switch turns on only after the client file was written.
        state = control._load(); state["enabled"] = False; control._save(state)
        config = self.root / ".claude.json"
        config.write_bytes(b'{"mcpServers": {broken')
        self.act("claude_code", "connect", 409)
        self.assertFalse(control._load()["enabled"])
        self.assertEqual(config.read_bytes(), b'{"mcpServers": {broken')
        config.write_text("{}", encoding="utf-8")
        self.act("claude_code", "connect")
        self.assertTrue(control._load()["enabled"])

    def test_bad_hermes_encoding_only_blocks_hermes(self):
        # CLIENT-03: one unreadable client must not break the whole list.
        config = self.root / ".workbuddy/mcp.json"
        config.write_bytes(b"{\"model\": \"\xff\xfe\x80 broken\"}")
        self.act("claude_code", "connect")
        response = self.client.get("/api/studio/clients")
        self.assertEqual(response.status_code, 200, response.text)
        items = {item["id"]: item for item in response.json()["items"]}
        self.assertEqual(items["claude_code"]["mcp"]["state"], "connected")
        self.assertEqual(items["workbuddy"]["mcp"]["state"], "blocked")
        self.assertIn("JSON", items["workbuddy"]["mcp"]["message"])
        self.act("workbuddy", "connect", 409)
        self.assertEqual(config.read_bytes(), b"{\"model\": \"\xff\xfe\x80 broken\"}")

    def test_relative_codex_home_resolves_to_one_absolute_target(self):
        # CLIENT-04: a relative CODEX_HOME is resolved once; it is shown and is the only place written.
        work = self.root / "work"
        (work / "rel-codex").mkdir(parents=True)
        previous = os.getcwd()
        os.chdir(work)
        self.addCleanup(os.chdir, previous)
        with patch.dict(os.environ, {"CODEX_HOME": "rel-codex"}):
            target = (work / "rel-codex").resolve()
            item = self.listing()["codex"]
            self.assertEqual(Path(item["skills_path"]), target / "skills")
            self.assertTrue(Path(item["skills_path"]).is_absolute())
            self.assertEqual(Path(item["mcp"]["config_path"]), target / "config.toml")
            result = self.act("codex", "install_skills")
            self.assertIn(str(target / "skills"), result["message"])
            self.assertTrue((target / "skills/deepwhite-canvas/SKILL.md").is_file())
            os.chdir(self.root)  # a later working directory must not move the target
            self.assertFalse((self.root / "rel-codex").exists())
            self.assertFalse((self.root / ".codex/skills").exists())

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
