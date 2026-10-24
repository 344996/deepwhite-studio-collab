"""Loopback Streamable-HTTP transport for the DeepWhite MCP bridge.

For clients that only accept an MCP *URL* (for example web chat "custom
connectors") instead of launching a local command. Protocol and tool logic are
the stdio Bridge's; this file only adds HTTP framing and its own guards:

* binds 127.0.0.1 only and rejects any Host header that is not loopback
  (DNS-rebinding protection);
* every request needs ``Authorization: Bearer <http token>``. The token is a
  separate secret in the runtime data dir (not the canvas control token) and
  can be rotated with ``--rotate-token``;
* browser cross-origin calls are allowed only for explicitly listed origins
  (default: the Doubao web app), including Chrome's Private Network Access
  preflight.

Usage:  python studio_mcp_http.py [--port 3849] [--url http://127.0.0.1:3848]
        python studio_mcp_http.py --print-token | --rotate-token
"""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import sys
import threading
import uuid

from studio_mcp import MAX_MESSAGE_BYTES, Bridge, BridgeError, _runtime_dir

DEFAULT_PORT = 3849
DEFAULT_ORIGINS = ("https://www.doubao.com", "https://doubao.com")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")
MAX_SESSIONS = 32


def _token_path():
    return _runtime_dir() / "data" / "studio_mcp_http.json"


def http_token(rotate: bool = False) -> str:
    path = _token_path()
    if not rotate:
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("token")
            if isinstance(value, str) and len(value) >= 32:
                return value
        except (OSError, ValueError, AttributeError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(32)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"token": value}), encoding="utf-8")
    temporary.replace(path)
    return value


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, base_url, origins):
        super().__init__(("127.0.0.1", port), Handler)
        self.base_url = base_url
        self.origins = tuple(origins)
        self.token = http_token()
        self.sessions: dict[str, Bridge] = {}
        self.lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server: Server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep tokens/bodies out of logs
        sys.stderr.write("[mcp-http] %s %s\n" % (self.command, self.path.split("?")[0]))

    # ------------------------------------------------------------ guards
    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        return host in LOOPBACK_HOSTS

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in self.server.origins

    def _cors(self):
        # Only after send_response(): headers written earlier would precede the status line.
        origin = self.headers.get("Origin")
        if origin and origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Mcp-Session-Id")

    def _reply(self, status, body=None, extra=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        if body is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        return header.startswith("Bearer ") and secrets.compare_digest(header[7:].strip(), self.server.token)

    # ------------------------------------------------------------ methods
    def do_OPTIONS(self):
        if not self._host_ok():
            return self._reply(403, {"error": "host not allowed"})
        origin = self.headers.get("Origin")
        if origin not in self.server.origins:
            return self._reply(403, {"error": "origin not allowed"})
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept")
        self.send_header("Access-Control-Max-Age", "600")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._host_ok():
            return self._reply(403, {"error": "host not allowed"})
        if self.path.split("?")[0] == "/health":
            return self._reply(200, {"ok": True, "transport": "streamable-http", "endpoint": "/mcp"})
        # No server-initiated stream: this server only answers requests.
        return self._reply(405, {"error": "use POST /mcp"}, {"Allow": "POST, DELETE, OPTIONS"})

    def do_DELETE(self):
        if not self._host_ok() or not self._authorized():
            return self._reply(403 if not self._host_ok() else 401, {"error": "unauthorized"})
        with self.server.lock:
            self.server.sessions.pop(self.headers.get("Mcp-Session-Id", ""), None)
        return self._reply(204)

    def do_POST(self):
        if not self._host_ok():
            return self._reply(403, {"error": "host not allowed"})
        if not self._origin_ok():
            return self._reply(403, {"error": "origin not allowed"})
        if self.path.split("?")[0] != "/mcp":
            return self._reply(404, {"error": "endpoint is /mcp"})
        if not self._authorized():
            return self._reply(401, {"error": "missing or invalid bearer token"},
                               {"WWW-Authenticate": 'Bearer realm="deepwhite-studio"'})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_MESSAGE_BYTES:
            return self._reply(413 if length > 0 else 400, Bridge._error(None, -32600, "Invalid request size"))
        try:
            message = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._reply(400, Bridge._error(None, -32700, "Parse error"))
        batch = isinstance(message, list)
        messages = message if batch else [message]
        session_id = self.headers.get("Mcp-Session-Id", "")
        headers = {}
        with self.server.lock:
            bridge = self.server.sessions.get(session_id)
            is_init = any(isinstance(m, dict) and m.get("method") == "initialize" for m in messages)
            if bridge is None:
                if not is_init:
                    return self._reply(404 if session_id else 400,
                                       Bridge._error(None, -32000, "Unknown or missing Mcp-Session-Id; initialize first"))
                if len(self.server.sessions) >= MAX_SESSIONS:
                    self.server.sessions.pop(next(iter(self.server.sessions)))
                bridge = Bridge(self.server.base_url)
                session_id = uuid.uuid4().hex
                self.server.sessions[session_id] = bridge
            headers["Mcp-Session-Id"] = session_id
        replies = [reply for reply in (bridge.handle(m) for m in messages) if reply is not None]
        if not replies:
            return self._reply(202, None, headers)
        return self._reply(200, replies if batch else replies[0], headers)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="DeepWhite Studio MCP over loopback HTTP")
    parser.add_argument("--url", default="http://127.0.0.1:3848", help="canvas service (loopback)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--allow-origin", action="append", default=None,
                        help="browser origin allowed to call cross-origin (repeatable)")
    parser.add_argument("--print-token", action="store_true")
    parser.add_argument("--rotate-token", action="store_true")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if args.print_token or args.rotate_token:
        print(http_token(rotate=args.rotate_token))
        return 0
    try:
        Bridge(args.url)  # validates the loopback canvas URL up front
    except BridgeError as exc:
        print(f"[{exc.code}] {exc}", file=sys.stderr)
        return 2
    if not 1024 <= args.port <= 65535:
        print("port must be 1024-65535", file=sys.stderr)
        return 2
    server = Server(args.port, args.url, args.allow_origin or DEFAULT_ORIGINS)
    print(f"DeepWhite MCP (HTTP) listening on http://127.0.0.1:{args.port}/mcp — "
          f"send header Authorization: Bearer <token>; token: --print-token", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
