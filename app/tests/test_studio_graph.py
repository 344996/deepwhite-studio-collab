"""Graph editing contracts; temporary local data, no model execution."""
import importlib
import copy
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
runtime = tempfile.TemporaryDirectory(prefix="dw-graph-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server
import main as core
import studio_control as control
import studio_canvas_services as plans
from fastapi.testclient import TestClient


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(studio_server.app)
        self.project = core.new_project("MCP 测试")
        self.canvas = core.new_canvas("graph", project=self.project["id"])
        state = control._load()
        state["enabled"] = True
        control._save(state)
        self.token = state["token"]

    def call(self, name, arguments=None, status=200):
        response = self.client.post("/api/studio/control/call",
            json={"name": name, "arguments": arguments or {}},
            headers={"Authorization": "Bearer " + self.token})
        self.assertEqual(response.status_code, status, response.text)
        return response.json().get("result", response.json())

    def edit(self, operations, operation_id=None, revision=None, status=200):
        return self.call("edit_canvas", {
            "canvas_id": self.canvas["id"],
            "expected_revision": revision or plans.revision(core.load_canvas(self.canvas["id"])),
            "operation_id": operation_id or uuid.uuid4().hex,
            "operations": operations}, status)

    def add(self):
        return dict(op="add_prompt", key="text", text="故事内容", x=10, y=20)

    def test_projects_schema_and_no_secret_or_journal_exposure(self):
        projects = self.call("list_projects")
        self.assertIn(self.project["id"], [p["id"] for p in projects["items"]])
        self.assertIn("prompt", self.call("get_node_schema")["creatable_types"])
        self.edit([self.add()])
        result = self.call("get_canvas", {"canvas_id": self.canvas["id"]})
        self.assertNotIn("_studio_graph", result["canvas"])
        self.assertNotIn(self.token, json.dumps(result))

    def test_create_is_idempotent_after_module_reload(self):
        args = {"project_id": self.project["id"], "title": "新故事",
            "expected_revision": self.call("list_projects")["revision"],
            "operation_id": uuid.uuid4().hex}
        first = self.call("create_canvas", args)
        import studio_graph
        importlib.reload(studio_graph)
        self.assertEqual(first, self.call("create_canvas", args))
        self.call("create_canvas", dict(args, title="另一份"), 409)
        self.assertEqual(core.load_canvas(first["canvas_id"])["project"], self.project["id"])
        self.assertEqual(len([c for c in core.list_canvases() if c["id"] == first["canvas_id"]]), 1)

    def test_create_rejects_stale_revision_and_unknown_project(self):
        args = {"project_id": self.project["id"], "title": "safe",
            "expected_revision": self.call("list_projects")["revision"], "operation_id": uuid.uuid4().hex}
        core.new_project("other")
        self.call("create_canvas", args, 409)
        args.update(project_id="missing", expected_revision=self.call("list_projects")["revision"])
        self.call("create_canvas", args, 404)

    def test_edit_update_move_connect_disconnect_delete_and_undo(self):
        canvas = core.load_canvas(self.canvas["id"])
        canvas["nodes"] = [{"id": "g", "type": "generator", "x": 500, "y": 50}]
        core.save_canvas(canvas)
        first = self.edit([self.add(), {"op": "connect", "from": "$text", "to": "g"}])
        nid = first["node_ids"]["text"]
        saved = core.load_canvas(self.canvas["id"])
        self.assertEqual(saved["connections"][0]["from"], nid)
        change_id = uuid.uuid4().hex
        second = self.edit([{"op": "update_prompt", "node_id": nid, "text": "新版"},
            {"op": "move_node", "node_id": "g", "x": -50, "y": 30},
            {"op": "disconnect", "connection_id": saved["connections"][0]["id"]}], change_id)
        result = self.call("undo_edit", {"canvas_id": self.canvas["id"],
            "operation_id": change_id, "expected_revision": second["revision"]})
        undone = core.load_canvas(self.canvas["id"])
        self.assertEqual(undone["nodes"], saved["nodes"])
        self.assertEqual(undone["connections"], saved["connections"])
        self.call("undo_edit", {"canvas_id": self.canvas["id"],
            "operation_id": change_id, "expected_revision": result["revision"]}, 409)
        self.edit([{"op": "delete_prompt", "node_id": nid}])
        self.assertEqual(len(core.load_canvas(self.canvas["id"])["nodes"]), 1)
        self.assertEqual(core.load_canvas(self.canvas["id"])["connections"], [])

    def test_edit_replay_never_reapplies_after_undo(self):
        op = uuid.uuid4().hex
        initial = plans.revision(core.load_canvas(self.canvas["id"]))
        result = self.edit([self.add()], op, initial)
        self.assertEqual(self.edit([self.add()], op, initial), result)
        self.call("undo_edit", {"canvas_id": self.canvas["id"], "operation_id": op,
            "expected_revision": result["revision"]})
        self.assertEqual(self.edit([self.add()], op, initial), result)
        self.assertEqual(core.load_canvas(self.canvas["id"])["nodes"], [])

    def test_conflict_and_invalid_batch_do_not_partially_apply(self):
        before = Path(core.canvas_path(self.canvas["id"])).read_bytes()
        self.edit([self.add()], revision="0" * 64, status=409)
        self.edit([self.add(), {"op": "connect", "from": "$text", "to": "missing"}], status=404)
        self.assertEqual(Path(core.canvas_path(self.canvas["id"])).read_bytes(), before)

    def test_server_rejects_unknown_fields_and_limits(self):
        for operations in [
            [dict(self.add(), api_key="forbidden")],
            [dict(self.add(), x=True)], [dict(self.add(), x=100001)],
            [dict(self.add(), text="x" * 20001)], [self.add()] * 41,
            [{"op": "move_node", "node_id": "../a", "x": 1, "y": 1}],
        ]:
            with self.subTest(operations=str(operations)[:70]):
                self.edit(operations, status=400)

    def test_active_jobs_and_smart_canvas_cannot_be_edited(self):
        canvas = core.load_canvas(self.canvas["id"])
        canvas["nodes"] = [{"id": "g", "type": "generator", "studioJobState": "polling"}]
        core.save_canvas(canvas)
        self.edit([self.add()], status=409)
        canvas["nodes"] = []
        canvas["kind"] = "smart"
        core.save_canvas(canvas)
        self.edit([self.add()], status=400)

    def test_failed_atomic_replace_keeps_canvas_and_retry_creates_once(self):
        import studio_asset_integration
        before = Path(core.canvas_path(self.canvas["id"])).read_bytes()
        operation = uuid.uuid4().hex
        with patch.object(studio_asset_integration.os, "replace", side_effect=OSError("disk failure")):
            self.edit([self.add()], operation, status=507)
        self.assertEqual(Path(core.canvas_path(self.canvas["id"])).read_bytes(), before)
        first = self.edit([self.add()], operation)
        self.assertEqual(first, self.edit([self.add()], operation))
        self.assertEqual(len(core.load_canvas(self.canvas["id"])["nodes"]), 1)

    def test_browser_save_preserves_ledger_and_stale_save_is_rejected(self):
        old = core.load_canvas(self.canvas["id"])
        op = uuid.uuid4().hex
        added = self.edit([self.add()], op)
        url = "/api/canvases/" + self.canvas["id"]
        response = self.client.put(url, json={**old, "base_updated_at": old["updated_at"]})
        self.assertEqual(response.status_code, 409)
        fresh = core.load_canvas(self.canvas["id"])
        response = self.client.put(url, json={**fresh, "base_updated_at": fresh["updated_at"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(added, self.edit([self.add()], op))

    def test_disabled_control_and_wrong_token_reject_new_tools(self):
        for name in ["list_projects", "get_node_schema", "create_canvas", "edit_canvas"]:
            response = self.client.post("/api/studio/control/call",
                json={"name": name, "arguments": {}}, headers={"Authorization": "Bearer wrong"})
            self.assertEqual(response.status_code, 401)
        state = control._load()
        state["enabled"] = False
        control._save(state)
        self.call("list_projects", status=403)

    def test_failed_creation_retries_but_permanent_delete_never_recreates(self):
        args = {"project_id": self.project["id"], "title": "创建失败重试",
            "expected_revision": self.call("list_projects")["revision"],
            "operation_id": uuid.uuid4().hex}
        with patch.object(core, "save_canvas", side_effect=OSError("disk unavailable")):
            self.call("create_canvas", args, 507)
        result = self.call("create_canvas", args)
        self.assertEqual(result, self.call("create_canvas", args))
        Path(core.canvas_path(result["canvas_id"])).unlink()
        self.call("create_canvas", args, 409)
        self.assertFalse(Path(core.canvas_path(result["canvas_id"])).exists())

    def test_unknown_creation_outcome_requires_checking_before_another_attempt(self):
        args = {"project_id": self.project["id"], "title": "进程突然中止",
            "expected_revision": self.call("list_projects")["revision"],
            "operation_id": uuid.uuid4().hex}
        # A crash before commit does not mean that replay is safe: another client
        # might have permanently deleted a completed canvas before this retry.
        with patch.object(core, "save_canvas", side_effect=RuntimeError("simulated crash")):
            with self.assertRaises(RuntimeError):
                self.call("create_canvas", args)
        self.call("create_canvas", args, 409)

    def test_copied_canvas_does_not_inherit_source_replay_or_undo(self):
        op = uuid.uuid4().hex
        first = self.edit([self.add()], op)
        copied = copy.deepcopy(core.load_canvas(self.canvas["id"]))
        copied["id"] = uuid.uuid4().hex
        core.save_canvas(copied)
        self.call("undo_edit", {"canvas_id": copied["id"], "operation_id": op,
            "expected_revision": first["revision"]}, 404)
        # Existing model-node API must not report a false id collision from source.
        with patch.object(control, "_models", return_value=[]):
            result = self.client.post("/api/studio/control/call",
                json={"name": "apply_nodes", "arguments": {"canvas_id": copied["id"],
                    "operation_id": op, "expected_revision": first["revision"], "nodes": []}},
                headers={"Authorization": "Bearer " + self.token})
        self.assertEqual(result.status_code, 400, result.text)
        self.canvas = copied
        second = self.edit([self.add()], op)
        self.assertNotEqual(second["node_ids"], first["node_ids"])
        self.assertEqual(len(core.load_canvas(copied["id"])["nodes"]), 2)

    def test_conflicting_replay_duplicate_connections_and_unsupported_targets(self):
        op = uuid.uuid4().hex
        self.edit([self.add()], op)
        self.edit([dict(self.add(), text="changed")], op, status=409)
        canvas = core.load_canvas(self.canvas["id"])
        nid = canvas["nodes"][0]["id"]
        self.edit([{"op": "connect", "from": nid, "to": nid}], status=400)
        self.edit([{"op": "delete_prompt", "node_id": "missing"}], status=404)
        canvas["nodes"].append({"id": "g", "type": "generator"})
        core.save_canvas(canvas)
        self.edit([{"op": "connect", "from": nid, "to": "g"}])
        self.edit([{"op": "connect", "from": nid, "to": "g"}], status=409)

    def test_undo_refuses_later_manual_changes_and_group_references_are_cleaned(self):
        added = self.edit([self.add()])
        canvas = core.load_canvas(self.canvas["id"])
        nid = added["node_ids"]["text"]
        canvas["nodes"].append({"id": "group", "type": "group", "items": [nid]})
        canvas["nodes"].append({"id": "prompt-group", "type": "promptGroup", "items": [nid]})
        core.save_canvas(canvas)
        deleted = self.edit([{"op": "delete_prompt", "node_id": nid}], "delete-group-ref")
        saved = core.load_canvas(self.canvas["id"])
        self.assertEqual(saved["nodes"][0]["items"], [])
        self.assertEqual(saved["nodes"][1]["items"], [])
        saved["nodes"].append({"id": "manual", "type": "prompt", "text": "keep"})
        core.save_canvas(saved)
        self.call("undo_edit", {"canvas_id": saved["id"], "operation_id": "delete-group-ref",
            "expected_revision": plans.revision(saved)}, 409)
        self.assertEqual(core.load_canvas(saved["id"])["nodes"][-1]["text"], "keep")


if __name__ == "__main__":
    unittest.main()
