"""Loopback Streamable-HTTP MCP transport: guards and protocol, no canvas required."""
import http.client
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-mcp-http-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_mcp_http as transport


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HttpTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        # Canvas URL points at a closed port: the bridge must still serve MCP.
        cls.server = transport.Server(cls.port, f"http://127.0.0.1:{free_port()}", transport.DEFAULT_ORIGINS)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path="/mcp", body=None, headers=None, host=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        data = None if body is None else json.dumps(body).encode("utf-8")
        merged = {"Content-Type": "application/json", "Authorization": "Bearer " + self.server.token}
        merged.update(headers or {})
        if host:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader("Host", host)
            for key, value in merged.items():
                connection.putheader(key, value)
            connection.putheader("Content-Length", str(len(data or b"")))
            connection.endheaders(data)
        else:
            connection.request(method, path, body=data, headers=merged)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response, (json.loads(raw) if raw else None)

    def initialize(self):
        response, body = self.request("POST", body={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
        self.assertEqual(response.status, 200)
        session = response.getheader("Mcp-Session-Id")
        self.assertTrue(session)
        response, _ = self.request("POST", body={"jsonrpc": "2.0", "method": "notifications/initialized"},
                                   headers={"Mcp-Session-Id": session})
        self.assertEqual(response.status, 202)
        return session, body

    def test_full_session_lists_tools_and_self_checks(self):
        session, body = self.initialize()
        self.assertEqual(body["result"]["serverInfo"]["name"], "deepwhite-studio")
        _, listed = self.request("POST", body={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                                 headers={"Mcp-Session-Id": session})
        names = [tool["name"] for tool in listed["result"]["tools"]]
        self.assertIn("studio_status", names)
        self.assertEqual(len(names), 17)
        _, called = self.request("POST", body={"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                               "params": {"name": "studio_status", "arguments": {}}},
                                 headers={"Mcp-Session-Id": session})
        self.assertFalse(called["result"]["isError"])
        self.assertFalse(called["result"]["structuredContent"]["ok"])  # canvas intentionally down

    def test_requires_token_session_and_loopback_host(self):
        response, _ = self.request("POST", body={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                   headers={"Authorization": "Bearer wrong"})
        self.assertEqual(response.status, 401)
        response, _ = self.request("POST", body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(response.status, 400)  # no session and not initialize
        response, _ = self.request("POST", body={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                   host="attacker.example:%d" % self.port)
        self.assertEqual(response.status, 403)  # DNS rebinding guard

    def test_cors_only_for_listed_origins_with_private_network_preflight(self):
        response, _ = self.request("OPTIONS", headers={"Origin": "https://www.doubao.com",
                                                       "Access-Control-Request-Method": "POST",
                                                       "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "https://www.doubao.com")
        self.assertEqual(response.getheader("Access-Control-Allow-Private-Network"), "true")
        response, _ = self.request("OPTIONS", headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)
        response, _ = self.request("POST", body={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                   headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)

    def raw(self, method, origin=None, body=None, extra=""):
        """Send one request on a plain socket and return the exact response head lines."""
        data = b"" if body is None else json.dumps(body).encode("utf-8")
        head = (f"{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nConnection: close\r\n"
                f"Authorization: Bearer {self.server.token}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(data)}\r\n" + (f"Origin: {origin}\r\n" if origin else "") + extra + "\r\n")
        with socket.create_connection(("127.0.0.1", self.port), timeout=30) as conn:
            conn.sendall(head.encode("ascii") + data)
            chunks = []
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        return b"".join(chunks).split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")

    def assert_valid_head(self, lines, status):
        # MCP-01: the status line comes first, every following line is one well-formed header.
        self.assertRegex(lines[0], r"^HTTP/1\.1 %d " % status, "\n".join(lines))
        for line in lines[1:]:
            self.assertRegex(line, r"^[A-Za-z0-9-]+: ", "\n".join(lines))

    def test_allowed_origin_gets_valid_response_with_one_cors_header(self):
        initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
        lines = self.raw("POST", "https://www.doubao.com", initialize)
        self.assert_valid_head(lines, 200)
        allow = [line for line in lines if line.lower().startswith("access-control-allow-origin:")]
        self.assertEqual(allow, ["Access-Control-Allow-Origin: https://www.doubao.com"])
        self.assertEqual(sum(line.lower().startswith("vary:") for line in lines), 1)

    def test_rejected_origin_and_preflights_have_valid_heads(self):
        lines = self.raw("POST", "https://evil.example", {"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assert_valid_head(lines, 403)
        self.assertFalse(any(line.lower().startswith("access-control-allow-origin:") for line in lines))
        lines = self.raw("OPTIONS", "https://www.doubao.com", extra="Access-Control-Request-Method: POST\r\n")
        self.assert_valid_head(lines, 204)
        self.assertIn("Access-Control-Allow-Origin: https://www.doubao.com", lines)
        lines = self.raw("OPTIONS", "https://evil.example", extra="Access-Control-Request-Method: POST\r\n")
        self.assert_valid_head(lines, 403)
        self.assertFalse(any(line.lower().startswith("access-control-allow-origin:") for line in lines))

    def test_token_is_separate_and_rotatable(self):
        first = transport.http_token()
        self.assertEqual(first, transport.http_token())
        rotated = transport.http_token(rotate=True)
        self.assertNotEqual(first, rotated)
        self.assertGreaterEqual(len(rotated), 32)


if __name__ == "__main__":
    unittest.main()
