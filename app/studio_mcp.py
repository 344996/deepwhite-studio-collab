"""Small stdlib-only MCP stdio bridge for this DeepWhite Studio installation."""
from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
MAX_MESSAGE_BYTES = 1024 * 1024
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "deepwhite-studio", "title": "深白片场",
               "version": (ROOT / "VERSION").read_text(encoding="utf-8").strip()}
SENSITIVE_KEY_PARTS = ("token", "api_key", "apikey", "platform_key", "platformkey", "access_key",
                       "accesskey", "consumer_key", "consumerkey", "private_key", "privatekey",
                       "client_secret", "clientsecret", "password", "credential", "authorization")


class BridgeError(Exception):
    pass


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == "localhost"


def validate_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise BridgeError("服务地址无效。") from exc
    if (parsed.scheme != "http" or not _is_loopback(parsed.hostname) or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in ("", "/")):
        raise BridgeError("只允许连接本机 HTTP 地址（loopback）。")
    if port is None:
        port = 80
    if not (1 <= port <= 65535):
        raise BridgeError("服务端口无效。")
    return f"http://{parsed.netloc}"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_HTTP = build_opener(ProxyHandler({}), _NoRedirect())


def _request_json(url: str, method: str = "GET", payload=None, headers=None, *, timeout=5, sensitive_values=()):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json"}
    if data is not None:
        request_headers["Content-Type"] = "application/json; charset=utf-8"
    if headers:
        request_headers.update(headers)
    req = Request(url, data=data, headers=request_headers, method=method)
    try:
        with _HTTP.open(req, timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise BridgeError("DeepWhite Studio 响应过大。")
        return json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        if 300 <= exc.code < 400:
            raise BridgeError(f"DeepWhite Studio 请求失败（HTTP {exc.code}，已拒绝重定向）。") from None
        detail = ""
        try:
            raw_error = exc.read(128 * 1024)
            error_body = json.loads(raw_error.decode("utf-8"))
            detail_value = error_body.get("detail") if isinstance(error_body, dict) else None
            if isinstance(detail_value, (dict, list)):
                detail = json.dumps(_sanitize(detail_value), ensure_ascii=False, separators=(",", ":"))
            elif isinstance(detail_value, str):
                detail = detail_value
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass
        detail = re.sub(
            r"(?i)(token|api[_-]?key|platform[_-]?key|access[_-]?key|consumer[_-]?key|"
            r"private[_-]?key|client[_-]?secret|password|authorization)([\"']?)(\s*[:=]\s*[\"']?)[^,\s\"'&}]+",
            r"\1\2\3[redacted]", detail)
        for secret in sensitive_values:
            if secret:
                detail = detail.replace(secret, "[redacted]")
        detail = detail[:1200]
        suffix = f"：{detail}" if detail else "。"
        raise BridgeError(f"DeepWhite Studio 请求失败（HTTP {exc.code}）{suffix}") from None
    except (URLError, TimeoutError, OSError, UnicodeError, json.JSONDecodeError):
        raise BridgeError("无法读取 DeepWhite Studio 本机服务响应。") from None


def _same_installation(actual: str) -> bool:
    try:
        return os.path.normcase(os.path.realpath(actual)) == os.path.normcase(os.path.realpath(ROOT))
    except (OSError, TypeError):
        return False


def verify_service(base_url: str) -> None:
    health = _request_json(base_url + "/api/studio/health")
    app_name = " ".join(str(health.get("app", "")).split()).casefold() if isinstance(health, dict) else ""
    if app_name != "deepwhite studio" or not _same_installation(health.get("installation", "")):
        raise BridgeError("本机服务不是此项目的 DeepWhite Studio 安装。")


def _runtime_dir() -> Path:
    configured = os.environ.get("DEEPWHITE_STUDIO_RUNTIME_DIR")
    return Path(configured).expanduser() if configured else ROOT / "workspace"


def _read_control_config() -> tuple[str, str]:
    path = _runtime_dir() / "data" / "studio_control.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BridgeError("MCP 控制未启用：找不到 studio_control.json。") from None
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise BridgeError("MCP 控制配置不可读或格式无效。") from None
    if not isinstance(config, dict) or config.get("enabled") is not True:
        raise BridgeError("MCP 控制未启用；请在 DeepWhite Studio 设置中启用。")
    token = config.get("token")
    if not isinstance(token, str) or not token.strip():
        raise BridgeError("MCP 控制已启用，但本机控制 token 尚未配置。")
    return token, str(path)


def _sanitize(value):
    if isinstance(value, dict):
        return {key: _sanitize(item) for key, item in value.items()
                if str(key).casefold() not in ('key', 'secret') and
                not any(part in str(key).casefold() for part in SENSITIVE_KEY_PARTS)}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    return value


def _validate(value, schema, path="$args"):
    if "oneOf" in schema:
        matches = 0
        for option in schema["oneOf"]:
            try:
                _validate(value, option, path)
                matches += 1
            except BridgeError:
                pass
        if matches != 1:
            raise BridgeError(f"{path} 操作格式无效，请按 get_node_schema 提供的结构调用。")
        return
    if "const" in schema and value != schema["const"]:
        raise BridgeError(f"{path} 操作类型无效。")
    expected = schema.get("type")
    types = expected if isinstance(expected, list) else [expected]
    checks = {"object": lambda x: isinstance(x, dict), "array": lambda x: isinstance(x, list),
              "string": lambda x: isinstance(x, str), "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
              "number": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
              "boolean": lambda x: isinstance(x, bool), "null": lambda x: x is None}
    if expected and not any(checks[t](value) for t in types if t in checks):
        raise BridgeError(f"{path} 类型无效；需要 {', '.join(types)}。")
    if "enum" in schema and value not in schema["enum"]:
        raise BridgeError(f"{path} 的值无效。")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        raise BridgeError(f"{path} 不能为空。")
    if isinstance(value, str):
        if len(value) > schema.get("maxLength", len(value)):
            raise BridgeError(f"{path} 超出长度限制。")
        if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
            raise BridgeError(f"{path} 格式无效。")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if (isinstance(value, float) and not math.isfinite(value)) or value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise BridgeError(f"{path} 数值超出范围。")
    if isinstance(value, list) and not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", len(value)):
        raise BridgeError(f"{path} 数量超出范围。")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                raise BridgeError(f"{path}.{key} 为必填项。")
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(properties)
            if extra:
                raise BridgeError(f"{path} 含有未支持字段。")
        for key, item in value.items():
            if key in properties:
                _validate(item, properties[key], f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            _validate(item, schema["items"], f"{path}[{i}]")


def load_tools():
    try:
        tools = json.loads((ROOT / "studio_mcp_tools.json").read_text(encoding="utf-8"))
        tools += json.loads((ROOT / "studio_graph_tools.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BridgeError("MCP 工具定义文件不可用。") from exc
    if not isinstance(tools, list):
        raise BridgeError("MCP 工具定义格式无效。")
    return tools


class Bridge:
    def __init__(self, base_url: str):
        self.base_url = validate_url(base_url)
        verify_service(self.base_url)
        self.tools = load_tools()
        self.by_name = {tool["name"]: tool for tool in self.tools}
        self.initializing = False
        self.initialized = False

    def call_tool(self, name, arguments):
        if name not in self.by_name:
            return {"content": [{"type": "text", "text": f"未知工具：{name}"}], "isError": True}
        if not isinstance(arguments, dict):
            return {"content": [{"type": "text", "text": "arguments 必须是 JSON 对象。"}], "isError": True}
        try:
            _validate(arguments, self.by_name[name]["inputSchema"])
            token, _ = _read_control_config()
            response = _request_json(self.base_url + "/api/studio/control/call", method="POST", timeout=30,
                                     payload={"name": name, "arguments": arguments},
                                     headers={"Authorization": "Bearer " + token}, sensitive_values=(token,))
            if not isinstance(response, dict) or not isinstance(response.get("result"), dict):
                raise BridgeError("DeepWhite Studio 返回了无效的控制结果。")
            result = _sanitize(response["result"])
            if name == "get_node_schema":
                # These are static schema property names (including `key`), not
                # credential-bearing canvas fields. Publish the exact contract.
                result["input_schemas"] = {tool["name"]: tool["inputSchema"] for tool in self.tools}
            if name in ("apply_nodes", "edit_canvas") and isinstance(response["result"].get("node_ids"), dict):
                # User aliases such as `token` must still map to the saved node.
                result["node_ids"] = response["result"]["node_ids"]
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}],
                    "structuredContent": result, "isError": False}
        except BridgeError as exc:
            return {"content": [{"type": "text", "text": str(exc)}], "isError": True}

    def handle(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return self._error(None, -32600, "Invalid Request")
        if "id" in message and type(message["id"]) not in (str, int):
            return self._error(None, -32600, "Invalid Request")
        method = message["method"]
        request_id = message.get("id")
        notification = "id" not in message
        if notification:
            if method == "notifications/initialized" and self.initializing:
                self.initialized = True
                return None
            return None
        if method == "server/discover":
            # 2026-07-28 dual-era stdio clients probe first. An ordinary method
            # error explicitly selects their documented legacy initialize path.
            # Do not advertise a modern revision without its metadata semantics.
            return self._error(request_id, -32601,
                "Legacy MCP server; use initialize (supports " + ", ".join(PROTOCOL_VERSIONS) + ")")
        if method == "ping":
            return {"jsonrpc": "2.0", "id": request_id, "result": {}}
        if method == "initialize":
            params = message.get("params")
            if self.initializing or self.initialized or not isinstance(params, dict):
                return self._error(request_id, -32602, "Invalid params")
            requested = params.get("protocolVersion")
            client = params.get("clientInfo")
            if (not isinstance(requested, str) or not isinstance(params.get("capabilities"), dict) or
                    not isinstance(client, dict) or not isinstance(client.get("name"), str) or
                    not isinstance(client.get("version"), str)):
                return self._error(request_id, -32602, "Invalid initialize params")
            negotiated_version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            self.initializing = True
            return {"jsonrpc": "2.0", "id": request_id,
                    "result": {"protocolVersion": negotiated_version, "capabilities": {"tools": {"listChanged": False}},
                               "serverInfo": SERVER_INFO}}
        if not self.initialized:
            return self._error(request_id, -32002, "Server not initialized")
        if method == "tools/list":
            params = message.get("params", {})
            if (not isinstance(params, dict) or set(params) - {"cursor", "_meta"} or
                    ("cursor" in params and not isinstance(params["cursor"], str)) or
                    params.get("cursor") or
                    ("_meta" in params and not isinstance(params["_meta"], dict))):
                return self._error(request_id, -32602, "Invalid params")
            return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": self.tools}}
        if method == "tools/call":
            params = message.get("params")
            if (not isinstance(params, dict) or set(params) - {"name", "arguments", "_meta"} or
                    not isinstance(params.get("name"), str) or
                    ("_meta" in params and not isinstance(params["_meta"], dict))):
                return self._error(request_id, -32602, "Invalid params")
            return {"jsonrpc": "2.0", "id": request_id,
                    "result": self.call_tool(params["name"], params.get("arguments", {}))}
        return self._error(request_id, -32601, "Method not found")

    @staticmethod
    def _error(request_id, code, message):
        return {"jsonrpc": "2.0", "id": request_id,
                "error": {"code": code, "message": message}}


def serve(base_url: str) -> int:
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        bridge = Bridge(base_url)
    except BridgeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    source = sys.stdin.buffer
    destination = sys.stdout
    if hasattr(destination, "reconfigure"):
        destination.reconfigure(encoding="utf-8", errors="strict")
    while True:
        raw = source.readline(MAX_MESSAGE_BYTES + 1)
        if not raw:
            return 0
        if len(raw) > MAX_MESSAGE_BYTES:
            if not raw.endswith(b"\n"):
                while True:
                    remainder = source.readline(MAX_MESSAGE_BYTES + 1)
                    if not remainder or remainder.endswith(b"\n"):
                        break
            destination.write(json.dumps(bridge._error(None, -32600, "Message too large"), separators=(",", ":")) + "\n")
            destination.flush()
            continue
        try:
            text = raw.decode("utf-8").strip()
            def reject_constant(_value):
                raise ValueError("Non-finite JSON number")
            message = json.loads(text, parse_constant=reject_constant)
        except (UnicodeDecodeError, ValueError):
            reply = bridge._error(None, -32700, "Parse error")
        else:
            reply = bridge.handle(message)
        if reply is not None:
            destination.write(json.dumps(reply, ensure_ascii=False, separators=(",", ":")) + "\n")
            destination.flush()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="DeepWhite Studio MCP stdio bridge")
    parser.add_argument("--url", default="http://127.0.0.1:3848")
    args = parser.parse_args(argv)
    return serve(args.url)


if __name__ == "__main__":
    raise SystemExit(main())
