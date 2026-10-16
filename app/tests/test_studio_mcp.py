import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "studio_mcp.py"


class MockHandler(BaseHTTPRequestHandler):
    installation = str(ROOT)
    control_status = 200
    redirect_to = None
    last_call = None

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != "/api/studio/health":
            self.send_error(404)
            return
        body = json.dumps({"app": "DeepWhite Studio", "installation": self.installation}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).last_call = (self.headers.get("Authorization"), json.loads(body))
        if type(self).redirect_to:
            payload = b'{"detail":"redirect"}'
            self.send_response(302)
            self.send_header("Location", type(self).redirect_to)
        elif type(self).control_status != 200:
            payload = json.dumps({"detail": "409 conflict: canvas revision is stale; token=local-secret "
                                             "{\"api_key\":\"platform-secret\"} " + "x" * 1500}).encode()
            self.send_response(type(self).control_status)
        else:
            payload = json.dumps({"result": {"ok": True, "echo": json.loads(body), "token": "do-not-leak"}}).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class CaptureHandler(BaseHTTPRequestHandler):
    authorization_values = []

    def log_message(self, *_args):
        pass

    def _capture(self):
        type(self).authorization_values.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = _capture
    do_POST = _capture


class StudioMCPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}"
        cls.capture_httpd = ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
        cls.capture_thread = threading.Thread(target=cls.capture_httpd.serve_forever, daemon=True)
        cls.capture_thread.start()
        cls.capture_url = f"http://127.0.0.1:{cls.capture_httpd.server_port}/capture"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        cls.capture_httpd.shutdown()
        cls.capture_httpd.server_close()
        cls.capture_thread.join(timeout=3)

    def runtime(self, enabled=True, token="local-secret"):
        temp = tempfile.TemporaryDirectory()
        data = Path(temp.name) / "data"
        data.mkdir()
        (data / "studio_control.json").write_text(
            json.dumps({"enabled": enabled, "token": token}), encoding="utf-8")
        self.addCleanup(temp.cleanup)
        return temp.name

    def run_bridge(self, messages, *, url=None, runtime=None):
        env = os.environ.copy()
        if runtime:
            env["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime
        args = [sys.executable, str(SCRIPT), "--url", url or self.url]
        return subprocess.run(args, input=messages, text=True, encoding="utf-8", errors="replace",
                              capture_output=True, env=env, timeout=10)

    @staticmethod
    def rpc(method, request_id, params=None):
        value = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            value["params"] = params
        return json.dumps(value, ensure_ascii=False)

    @staticmethod
    def initialized_notification():
        return json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def test_stdio_handshake_list_notifications_and_malformed_input(self):
        initialize = self.rpc("initialize", 1, {"protocolVersion": "2025-06-18", "capabilities": {},
                                                  "clientInfo": {"name": "test", "version": "1"}})
        messages = "{broken\n" + initialize + "\n" + self.initialized_notification() + "\n" + self.rpc("tools/list", 2) + "\n"
        result = self.run_bridge(messages)
        self.assertEqual(result.returncode, 0, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(replies[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(replies[1]["result"]["serverInfo"]["name"], "deepwhite-studio")
        self.assertEqual(replies[1]["result"]["serverInfo"]["version"],
                         (ROOT / "VERSION").read_text(encoding="utf-8").strip())
        listed = replies[2]["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, {
            "list_canvases", "get_canvas", "list_models", "list_assets", "apply_nodes",
            "undo_edit", "generate_node", "get_generation", "resume_generation"})
        self.assertTrue(next(t for t in listed if t["name"] == "apply_nodes")["annotations"]["idempotentHint"])

    def test_tools_call_posts_local_control_and_redacts_secrets(self):
        runtime = self.runtime()
        init = self.rpc("initialize", 1, {"protocolVersion": "2024-11-05", "capabilities": {},
                                            "clientInfo": {"name": "test", "version": "1"}})
        call = self.rpc("tools/call", 2, {"name": "get_canvas", "arguments": {"canvas_id": "c-1"}})
        result = self.run_bridge(init + "\n" + self.initialized_notification() + "\n" + call + "\n", runtime=runtime)
        self.assertEqual(result.returncode, 0, result.stderr)
        reply = [json.loads(line) for line in result.stdout.splitlines()][1]["result"]
        self.assertFalse(reply["isError"])
        self.assertNotIn("token", reply["structuredContent"])
        self.assertEqual(MockHandler.last_call, ("Bearer local-secret", {
            "name": "get_canvas", "arguments": {"canvas_id": "c-1"}}))
        self.assertNotIn("local-secret", result.stdout)

    def test_missing_or_disabled_control_returns_tool_error(self):
        init = self.rpc("initialize", 1, {"protocolVersion": "2025-03-26", "capabilities": {},
                                            "clientInfo": {"name": "test", "version": "1"}})
        call = self.rpc("tools/call", 2, {"name": "list_canvases", "arguments": {}})
        for runtime in (self.runtime(enabled=False), self.runtime(enabled=True, token="")):
            result = self.run_bridge(init + "\n" + self.initialized_notification() + "\n" + call + "\n", runtime=runtime)
            reply = [json.loads(line) for line in result.stdout.splitlines()][1]["result"]
            self.assertTrue(reply["isError"])
            self.assertNotIn("local-secret", result.stdout)

    def test_invalid_arguments_and_http_failure_are_tool_errors(self):
        init = self.rpc("initialize", 1, {"protocolVersion": "2025-06-18", "capabilities": {},
                                            "clientInfo": {"name": "test", "version": "1"}})
        invalid = self.rpc("tools/call", 2, {"name": "get_canvas", "arguments": {"wrong": 1}})
        runtime = self.runtime()
        result = self.run_bridge(init + "\n" + self.initialized_notification() + "\n" + invalid + "\n", runtime=runtime)
        self.assertTrue(json.loads(result.stdout.splitlines()[1])["result"]["isError"])
        MockHandler.control_status = 409
        try:
            call = self.rpc("tools/call", 3, {"name": "list_canvases", "arguments": {}})
            result = self.run_bridge(init + "\n" + self.initialized_notification() + "\n" + call + "\n", runtime=runtime)
            reply = json.loads(result.stdout.splitlines()[1])["result"]
            self.assertTrue(reply["isError"])
            text = reply["content"][0]["text"]
            self.assertIn("409", text)
            self.assertIn("revision is stale", text)
            self.assertIn("token=[redacted]", text)
            self.assertIn('"api_key":"[redacted]"', text)
            self.assertEqual(len(text.split("：", 1)[1]), 1200)
            self.assertNotIn("local-secret", result.stdout)
            self.assertNotIn("platform-secret", result.stdout)
        finally:
            MockHandler.control_status = 200

    def test_rejects_redirect_without_forwarding_bearer(self):
        runtime = self.runtime()
        MockHandler.redirect_to = self.capture_url
        CaptureHandler.authorization_values.clear()
        try:
            init = self.rpc("initialize", 1, {"protocolVersion": "2025-11-25", "capabilities": {},
                                                "clientInfo": {"name": "future-client", "version": "1"}})
            call = self.rpc("tools/call", 2, {"name": "list_canvases", "arguments": {}})
            result = self.run_bridge(init + "\n" + self.initialized_notification() + "\n" + call + "\n",
                                     runtime=runtime)
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(replies[0]["result"]["protocolVersion"], "2025-06-18")
            tool_result = replies[1]["result"]
            self.assertTrue(tool_result["isError"])
            self.assertIn("已拒绝重定向", tool_result["content"][0]["text"])
            self.assertEqual(CaptureHandler.authorization_values, [])
        finally:
            MockHandler.redirect_to = None

    def test_rejects_remote_url_and_wrong_installation(self):
        remote = self.run_bridge("", url="http://example.com:3848")
        self.assertEqual(remote.returncode, 2)
        self.assertEqual(remote.stdout, "")
        self.assertIn("loopback", remote.stderr)
        MockHandler.installation = str(ROOT.parent)
        try:
            wrong = self.run_bridge("")
            self.assertEqual(wrong.returncode, 2)
            self.assertEqual(wrong.stdout, "")
            self.assertIn("不是此项目", wrong.stderr)
        finally:
            MockHandler.installation = str(ROOT)


if __name__ == "__main__":
    unittest.main()
