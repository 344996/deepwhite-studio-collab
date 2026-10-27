"""MCP diagnostics/configuration regression tests; no real credentials or generation."""
import io
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import tomllib
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import studio_mcp as bridge
from studio_mcp_config import client_configuration


class DiagnosticsTests(unittest.TestCase):
    def test_network_failures_have_distinct_safe_codes_and_hints(self):
        cases = [
            (URLError(ConnectionRefusedError(10061, "private detail")), "connection_refused"),
            (URLError(PermissionError(10013, "private detail")), "connection_permission_denied"),
            (TimeoutError("private detail"), "connection_timeout"),
            (URLError(OSError("private detail")), "connection_failed"),
        ]
        for error, expected in cases:
            with self.subTest(code=expected), patch.object(bridge._HTTP, "open", side_effect=error):
                with self.assertRaises(bridge.BridgeError) as result:
                    bridge._request_json("http://127.0.0.1:3848/api/studio/health")
                self.assertEqual(result.exception.code, expected)
                self.assertTrue(result.exception.hint)
                self.assertNotIn("private detail", str(result.exception))

    def test_auth_failure_does_not_echo_server_secret_body(self):
        for status, code in [(401, "control_unauthorized"), (403, "control_forbidden")]:
            error = HTTPError("http://127.0.0.1/", status, "denied", {}, io.BytesIO(
                b'{"detail":"fixture-secret is invalid"}'))
            with patch.object(bridge._HTTP, "open", side_effect=error):
                with self.assertRaises(bridge.BridgeError) as result:
                    bridge._request_json("http://127.0.0.1/")
                self.assertEqual(result.exception.code, code)
                self.assertNotIn("fixture-secret", str(result.exception))

    def test_diagnostic_stops_at_wrong_installation_without_reading_token(self):
        with patch.object(bridge, "_request_json", return_value={
                "app": "DeepWhite Studio", "installation": str(ROOT.parent)}), \
                patch.object(bridge, "_read_control_config") as config:
            report = bridge.preflight("http://127.0.0.1:3848")
        self.assertFalse(report["ok"])
        self.assertEqual(report["checks"][-1]["code"], "wrong_installation")
        config.assert_not_called()

    def test_diagnostic_is_read_only_and_export_does_not_contain_token_or_paths(self):
        with patch.object(bridge, "verify_service", return_value={}), \
                patch.object(bridge, "_read_control_config", return_value=("fixture-control-secret", "private-path")), \
                patch.object(bridge, "_request_json", return_value={"result": {"items": []}}) as request:
            report = bridge.preflight("http://127.0.0.1:3848")
        self.assertTrue(report["ok"])
        self.assertEqual(report["tool_count"], 18)  # + verify_client (U11)
        self.assertEqual(request.call_args.kwargs["payload"], {"name": "list_canvases", "arguments": {}})
        encoded = json.dumps(report)
        self.assertNotIn("fixture-control-secret", encoded)
        self.assertNotIn("private-path", encoded)

    def test_malformed_control_body_becomes_actionable_diagnostic(self):
        with patch.object(bridge, "verify_service", return_value={}), \
                patch.object(bridge, "_read_control_config", return_value=("fixture", "")), \
                patch.object(bridge, "_request_json", return_value={"result": []}):
            result = bridge.preflight("http://127.0.0.1:3848")
        self.assertFalse(result["ok"])
        self.assertEqual(result["checks"][-1]["code"], "invalid_control_response")

    def test_codex_toml_and_json_have_equivalent_commands_without_keys(self):
        config = client_configuration(sys.executable, ROOT, ROOT / "workspace", "http://127.0.0.1:3875")
        toml = tomllib.loads(config["client_configs"]["codex_toml"])["mcp_servers"]["deepwhite-studio"]
        other = config["client_configs"]["claude_json"]["mcpServers"]["deepwhite-studio"]
        for field in ("command", "args", "env"):
            self.assertEqual(toml[field], other[field])
        self.assertNotIn("token", json.dumps(config).lower())
        self.assertFalse(config["stable_launcher"])

    def test_runtime_is_decoupled_from_archived_assistant_modules(self):
        for filename in ("studio_control.py", "studio_graph.py", "studio_canvas_concurrency.py",
                         "studio_canvas_services.py", "studio_models.py"):
            self.assertNotIn("import studio_agent", (ROOT / filename).read_text(encoding="utf-8"))


@unittest.skipUnless(os.name == "nt", "Windows portable bootstrap")
class PortableBridgeTests(unittest.TestCase):
    def test_persistent_bootstrap_flushes_each_request_and_drains_both_outputs(self):
        """A real MCP client keeps stdin open between individual requests."""
        with tempfile.TemporaryDirectory(prefix="dw-mcp-persistent-") as temporary:
            root = Path(temporary) / "客户 & (副本)"
            version = "0.11.0-studio.5"
            app = root / "versions" / version / "app"
            python = app.parent / "python"
            app.mkdir(parents=True)
            python.mkdir()
            runtime = root / "userdata"
            runtime.mkdir()
            shutil.copy2(sys.executable, python / "python.exe")
            (python / "pyvenv.cfg").write_text(
                f"home = {sys.base_prefix}\ninclude-system-site-packages = false\n",
                encoding="utf-8")
            (app / "VERSION").write_text(version, encoding="utf-8")
            shutil.copy2(ROOT / "studio_mcp_bootstrap.ps1", app / "studio_mcp_bootstrap.ps1")
            (app / "studio_mcp.py").write_text(
                "import json,sys\n"
                "for line in sys.stdin.buffer:\n"
                "    request=json.loads(line)\n"
                "    count=request.pop('stderr_bytes',0)\n"
                "    if count:\n"
                "        sys.stderr.buffer.write(b'e'*count)\n"
                "        sys.stderr.buffer.flush()\n"
                "    response=(json.dumps(request,ensure_ascii=False)+'\\n').encode('utf-8')\n"
                "    sys.stdout.buffer.write(response)\n"
                "    sys.stdout.buffer.flush()\n",
                encoding="utf-8")
            (root / "current.json").write_text(json.dumps({"version": version}), encoding="utf-8")
            config = client_configuration(sys.executable, app, runtime,
                                           "http://127.0.0.1:39901", root)
            entry = config["client_config"]["mcpServers"]["deepwhite-studio"]
            process = subprocess.Popen(
                [entry["command"], *entry["args"]], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=dict(os.environ, PSExecutionPolicyPreference="Restricted"))
            replies = queue.Queue()
            errors = []

            def read_replies():
                for line in iter(process.stdout.readline, b""):
                    replies.put(line)

            def read_errors():
                errors.append(process.stderr.read())

            readers = [threading.Thread(target=read_replies, daemon=True),
                       threading.Thread(target=read_errors, daemon=True)]
            for reader in readers:
                reader.start()
            try:
                for index, prompt in enumerate(("你好", "逐条请求", "图片提示词" * 15000)):
                    request = {"id": index, "prompt": prompt}
                    payload = dict(request, stderr_bytes=200000 if index == 2 else 0)
                    process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
                    process.stdin.flush()
                    # Never close stdin to obtain a response: that used to hide buffering.
                    try:
                        response = replies.get(timeout=10)
                    except queue.Empty:
                        self.fail("No response while stdin is open; the bootstrap must flush every request.")
                    self.assertEqual(json.loads(response), request)
                    self.assertIsNone(process.poll())
                process.stdin.close()
                self.assertEqual(process.wait(timeout=10), 0)
                for reader in readers:
                    reader.join(timeout=5)
                    self.assertFalse(reader.is_alive())
                self.assertEqual(b"".join(errors), b"e" * 200000)
            finally:
                if process.poll() is None:
                    # EOF also lets the old, faulty relay exit after a failing assertion.
                    process.stdin.close()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                for reader in readers:
                    reader.join(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_stable_bootstrap_uses_new_version_and_preserves_unicode_stdio(self):
        with tempfile.TemporaryDirectory(prefix="dw-mcp-bootstrap-") as temporary:
            root = Path(temporary) / "中文 & (副本)"
            runtime = root / "userdata"
            runtime.mkdir(parents=True)
            root.joinpath("updates").mkdir()
            version_a, version_b = "0.10.2-studio.16", "0.11.0-studio.1"
            for version in (version_a, version_b):
                app = root / "versions" / version / "app"
                python = app.parent / "python"
                app.mkdir(parents=True)
                python.mkdir()
                # A real Windows venv launcher plus its base interpreter, isolated in a fixture.
                shutil.copy2(sys.executable, python / "python.exe")
                (python / "pyvenv.cfg").write_text(f"home = {sys.base_prefix}\ninclude-system-site-packages = false\n", encoding="utf-8")
                (app / "VERSION").write_text(version, encoding="utf-8")
                shutil.copy2(ROOT / "studio_mcp_bootstrap.ps1", app / "studio_mcp_bootstrap.ps1")
                (app / "studio_mcp.py").write_text(
                    "import json,sys,os\n"
                    "sys.stdout.reconfigure(encoding='utf-8')\n"
                    "request=json.loads(sys.stdin.buffer.readline().decode('utf-8'))\n"
                    f"print(json.dumps({{'version':{version!r},'echo':request,"
                    "'runtime':os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'],'args':sys.argv[1:]},ensure_ascii=False))\n",
                    encoding="utf-8")
            (root / "current.json").write_text(json.dumps({"version": version_a}), encoding="utf-8")
            config = client_configuration(sys.executable, root / "versions" / version_a / "app",
                                           runtime, "http://127.0.0.1:39901", root)
            self.assertTrue(config["stable_launcher"])
            entry = config["client_config"]["mcpServers"]["deepwhite-studio"]
            self.assertEqual(entry["args"][entry["args"].index("-ExecutionPolicy") + 1], "Bypass")
            for version in (version_a, version_b):
                (root / "current.json").write_text(json.dumps({"version": version}), encoding="utf-8")
                (root / "updates" / "server-process.json").write_text(json.dumps({
                    "port": 39901, "version": version}), encoding="utf-8")
                result = subprocess.run([entry["command"], *entry["args"]],
                    input=json.dumps({"prompt": "雨夜，电影光线"}, ensure_ascii=False) + "\n",
                    capture_output=True, text=True, encoding="utf-8", timeout=20,
                    env=dict(os.environ, PSExecutionPolicyPreference="Restricted"))
                self.assertEqual(result.returncode, 0, result.stderr)
                response = json.loads(result.stdout)
                self.assertEqual(response["version"], version)
                self.assertEqual(response["echo"]["prompt"], "雨夜，电影光线")
                self.assertEqual(response["runtime"], str(runtime))
                self.assertIn("http://127.0.0.1:39901", response["args"])
            self.assertNotIn(version_a, str(entry))
            # Invalid pointers do not select another program or print raw path details.
            (root / "current.json").write_text('{"version":"../../untrusted"}', encoding="utf-8")
            invalid = subprocess.run([entry["command"], *entry["args"]],
                input="", capture_output=True, text=True, encoding="utf-8", timeout=20)
            self.assertEqual(invalid.returncode, 2)
            self.assertEqual(invalid.stdout, "")
            self.assertNotIn(str(root), invalid.stderr)


if __name__ == "__main__":
    unittest.main()
