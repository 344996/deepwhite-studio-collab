"""Customer configuration must never use the developer's real Codex home."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tomlkit
import studio_codex_setup as setup


class CustomerSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dw-customer-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "客户's 用户 & (测试)" / ".codex"
        self.environment = patch.dict(os.environ, {"CODEX_HOME": str(self.home)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = self.home / "config.toml"
        self.configuration = {
            "stable_launcher": True,
            "client_configs": {"codex_toml":
                '[mcp_servers.deepwhite-studio]\ncommand = "powershell.exe"\n'
                'args = ["-File", "E:/客户 软件/deepwhite-mcp.ps1"]\n'
                'startup_timeout_sec = 30\ntool_timeout_sec = 60\n'},
        }

    def write(self, text):
        self.home.mkdir(parents=True, exist_ok=True)
        self.config.write_bytes(text.encode("utf-8"))

    def action(self, action="install", replace=False, revision=None):
        return setup.configure(self.configuration, {
            "action": action, "expected_revision": revision or setup.status(self.configuration)["revision"],
            "replace_existing": replace,
        })

    def test_status_is_read_only_and_uses_customer_home(self):
        status = setup.status(self.configuration)
        self.assertEqual(status["state"], "missing")
        self.assertEqual(status["config_path"], str(self.config))
        self.assertFalse(self.home.exists())
        self.assertNotIn("Technopreneurship", json.dumps(status))

    def test_install_idempotent_and_undo_new_config(self):
        installed = self.action()
        self.assertEqual(installed["state"], "installed")
        self.assertTrue(installed["changed"])
        original = self.config.read_bytes()
        self.assertFalse(self.action()["changed"])
        self.assertEqual(original, self.config.read_bytes())
        self.assertTrue(setup.status(self.configuration)["can_undo"])
        self.assertEqual(self.action("undo")["state"], "missing")
        self.assertNotIn("deepwhite-studio", self.config.read_text(encoding="utf-8"))

    def test_preserves_comments_providers_and_other_servers_with_backup(self):
        content = '# 我的设置\r\nmodel = "fixture"\r\n[model_providers.fixture]\r\nname = "Test"\r\n' \
            'base_url = "https://example.invalid/v1"\r\n[mcp_servers.other]\r\ncommand = "other.exe" # 保留\r\n'
        self.write(content)
        self.action()
        parsed = tomlkit.parse(self.config.read_text(encoding="utf-8"))
        self.assertEqual(parsed["mcp_servers"]["other"]["command"], "other.exe")
        self.assertEqual(parsed["model_providers"]["fixture"]["name"], "Test")
        self.assertIn("# 保留", self.config.read_text(encoding="utf-8"))
        backups = list((self.home / "deepwhite-backups").glob("*.toml"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), content.encode())
        self.action("undo")
        self.assertEqual(self.config.read_bytes(), content.encode())

    def test_existing_connection_requires_explicit_replace_and_keeps_policies(self):
        self.write('[mcp_servers."deepwhite-studio"]\nurl="https://old.invalid/mcp"\n'
                   'enabled=false\ndisabled_tools=["generate_node"]\n'
                   '[mcp_servers."deepwhite-studio".tools.get_canvas]\napproval_mode="prompt"\n')
        before = self.config.read_bytes()
        self.assertEqual(setup.status(self.configuration)["state"], "different")
        with self.assertRaises(setup.SetupError):
            self.action()
        self.assertEqual(self.config.read_bytes(), before)
        self.action(replace=True)
        entry = tomlkit.parse(self.config.read_text(encoding="utf-8"))["mcp_servers"]["deepwhite-studio"]
        self.assertNotIn("url", entry)
        self.assertTrue(entry["enabled"])
        self.assertEqual(entry["disabled_tools"], ["generate_node"])
        self.assertEqual(entry["tools"]["get_canvas"]["approval_mode"], "prompt")

    def test_undo_keeps_subsequent_unrelated_changes(self):
        self.write('model = "first"\n')
        self.action()
        self.config.write_text(self.config.read_text(encoding="utf-8").replace('"first"', '"later"'), encoding="utf-8")
        self.assertTrue(setup.status(self.configuration)["can_undo"])
        self.action("undo")
        self.assertEqual(tomlkit.parse(self.config.read_text(encoding="utf-8"))["model"], "later")

    def test_undo_refuses_edited_connection_and_stale_install_revision(self):
        old_revision = setup.status(self.configuration)["revision"]
        self.write('model = "externally changed"\n')
        with self.assertRaises(setup.SetupError):
            self.action(revision=old_revision)
        self.action()
        self.config.write_text(self.config.read_text(encoding="utf-8").replace("powershell.exe", "custom.exe"), encoding="utf-8")
        self.assertFalse(setup.status(self.configuration)["can_undo"])
        with self.assertRaises(setup.SetupError):
            self.action("undo")

    def test_bad_toml_and_shapes_are_blocked_without_input_echo(self):
        for text in ('secret="DO_NOT_ECHO', 'mcp_servers = "DO_NOT_ECHO"',
                     '[mcp_servers]\ndeepwhite-studio = "DO_NOT_ECHO"'):
            self.write(text)
            status = setup.status(self.configuration)
            self.assertEqual(status["state"], "blocked")
            self.assertNotIn("DO_NOT_ECHO", json.dumps(status))
            with self.assertRaises(setup.SetupError):
                self.action()
            self.assertEqual(self.config.read_text(encoding="utf-8"), text)

    def test_write_failure_does_not_corrupt_existing_config(self):
        self.write('model="keep"\n')
        before = self.config.read_bytes()
        original_replace = os.replace
        def fail_config(source, target):
            if Path(target) == self.config:
                raise PermissionError("synthetic failure")
            return original_replace(source, target)
        with patch.object(setup.os, "replace", side_effect=fail_config):
            with self.assertRaises(setup.SetupError):
                self.action()
        self.assertEqual(before, self.config.read_bytes())
        self.assertEqual(setup.status(self.configuration)["state"], "missing")
        self.assertTrue(self.action()["changed"])

    def test_change_between_backup_and_replace_is_not_overwritten(self):
        self.write('model="first"\n')
        original_backup = setup._backup
        def concurrent_edit(*args, **kwargs):
            result = original_backup(*args, **kwargs)
            self.config.write_text('model="changed while backing up"\n', encoding="utf-8")
            return result
        with patch.object(setup, "_backup", side_effect=concurrent_edit):
            with self.assertRaises(setup.SetupError):
                self.action()
        self.assertEqual(tomlkit.parse(self.config.read_text(encoding="utf-8"))["model"], "changed while backing up")

    def test_multiline_strings_inline_tables_and_dotted_keys_are_preserved(self):
        texts = [
            'instructions = """\n[mcp_servers.deepwhite-studio]\nnot a real table\n"""\n',
            'mcp_servers = { other={command="foo"}, deepwhite-studio={command="old"} }\n',
            'mcp_servers.deepwhite-studio.command = "old"\nmodel="stay"\n',
        ]
        for text in texts:
            self.write(text)
            original = tomlkit.parse(text).unwrap()
            self.action(replace=True)
            parsed = tomlkit.parse(self.config.read_text(encoding="utf-8")).unwrap()
            for value in (original, parsed):
                value.get("mcp_servers", {}).pop("deepwhite-studio", None)
                if not value.get("mcp_servers"):
                    value.pop("mcp_servers", None)
            self.assertEqual(parsed, original)

    def test_broken_portable_launcher_and_relative_home_fail_safely(self):
        broken = copy.deepcopy(self.configuration)
        broken["launcher_warning"] = "broken"
        self.assertEqual(setup.status(broken)["state"], "blocked")
        with patch.dict(os.environ, {"CODEX_HOME": "relative-home"}):
            self.assertEqual(setup.status(self.configuration)["state"], "blocked")
        self.assertFalse(self.home.exists())

    def test_hardlinked_file_is_not_replaced(self):
        self.write('model="private"\n')
        os.link(self.config, self.home / "linked.toml")
        self.assertEqual(setup.status(self.configuration)["state"], "blocked")
        with self.assertRaises(setup.SetupError):
            self.action()

    def test_out_of_order_tables_install_and_selective_undo(self):
        text = '[mcp_servers.deepwhite-studio.env]\nOLD="thing"\n[thing]\nx=4 # stay\n' \
               '[mcp_servers.deepwhite-studio]\ncommand="old.exe"\nargs=[]\n'
        self.write(text)
        self.action(replace=True)
        self.config.write_text(self.config.read_text(encoding="utf-8").replace("x=4", "x=5"), encoding="utf-8")
        self.action("undo")
        document = tomlkit.parse(self.config.read_text(encoding="utf-8"))
        self.assertEqual(document["thing"]["x"], 5)
        self.assertEqual(document["mcp_servers"]["deepwhite-studio"]["env"]["OLD"], "thing")
        self.assertEqual(document["mcp_servers"]["deepwhite-studio"]["command"], "old.exe")

    def test_damaged_undo_receipt_does_not_break_status_or_config(self):
        self.action()
        receipt_path = self.home / setup.RECEIPT
        valid = json.loads(receipt_path.read_bytes())
        malformed = [[], True, 1, None, {key: value for key, value in valid.items() if key != "after_hash"},
                     dict(valid, backup="../outside.toml"), dict(valid, after_entry=1)]
        before = self.config.read_bytes()
        for value in malformed:
            receipt_path.write_text(json.dumps(value), encoding="utf-8")
            status = setup.status(self.configuration)
            self.assertEqual(status["state"], "installed")
            self.assertFalse(status["can_undo"])
            with self.assertRaises(setup.SetupError):
                self.action("undo")
            self.assertEqual(self.config.read_bytes(), before)

    def test_interruption_after_config_replace_keeps_undo_receipt(self):
        self.write('model="keep"\n')
        before = self.config.read_bytes()
        original_write = setup._atomic_write
        def interrupted(path, raw):
            original_write(path, raw)
            if path == self.config:
                raise InterruptedError("synthetic interruption after commit")
        with patch.object(setup, "_atomic_write", side_effect=interrupted):
            with self.assertRaises(setup.SetupError):
                self.action()
        self.assertEqual(setup.status(self.configuration)["state"], "installed")
        self.assertTrue(setup.status(self.configuration)["can_undo"])
        self.action("undo")
        self.assertEqual(self.config.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
