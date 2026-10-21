"""Verify every external agent client exactly as it will launch DeepWhite's MCP server.

Usage (with the canvas running):
    python scripts/verify_agent_clients.py [--url http://127.0.0.1:3848] [--json] [--client hermes]

For each client the script
  1. reads the client's own config file (path reported by the canvas) and extracts
     the `deepwhite-studio` entry the client will really run;
  2. starts that exact command/args/env as an MCP stdio server, performs the
     initialize handshake, lists tools and calls the read-only `studio_status`;
  3. compares installed Skills with the canvas catalog;
  4. when the client's own CLI is available, runs its native check
     (`claude mcp list`, `codex mcp list`, `hermes mcp test deepwhite-studio`).
Nothing is written to any client config and no generation is started.
Doubao has no config file: its copy/paste JSON from the settings page is checked.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib
from urllib.request import ProxyHandler, build_opener

SERVER = "deepwhite-studio"
OPENER = build_opener(ProxyHandler({}))


def fetch(url):
    with OPENER.open(url, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def yaml_entry(text):
    """Parse the block DeepWhite writes under `mcp_servers:` (JSON-quoted scalars)."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(rf"^  {re.escape(SERVER)}\s*:", line)), None)
    if start is None:
        return None
    entry, section = {"args": [], "env": {}}, None
    for line in lines[start + 1:]:
        if line.strip() and not line.startswith("    "):
            break
        stripped = line.strip()
        if stripped.startswith("command:"):
            entry["command"] = json.loads(stripped.split(":", 1)[1].strip())
        elif stripped in ("args:", "env:"):
            section = stripped[:-1]
        elif section == "args" and stripped.startswith("- "):
            entry["args"].append(json.loads(stripped[2:]))
        elif section == "env" and ":" in stripped:
            key, value = stripped.split(":", 1)
            entry["env"][key.strip()] = json.loads(value.strip())
    return entry if entry.get("command") else None


def read_entry(client):
    if client["id"] == "doubao":
        return json.loads(client["manual"]["text"])["mcpServers"][SERVER], "设置页复制的配置"
    path = Path(client["mcp"]["config_path"])
    if not path.is_file():
        return None, f"配置文件不存在：{path}"
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix == ".toml":
        entry = tomllib.loads(raw).get("mcp_servers", {}).get(SERVER)
    elif path.suffix in (".yaml", ".yml"):
        entry = yaml_entry(raw)
    else:
        entry = json.loads(raw or "{}").get("mcpServers", {}).get(SERVER)
    return entry, str(path)


def handshake(entry, timeout=60):
    env = dict(os.environ, **{key: str(value) for key, value in (entry.get("env") or {}).items()})
    process = subprocess.Popen([entry["command"], *entry.get("args", [])], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
         "capabilities": {}, "clientInfo": {"name": "deepwhite-verify", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "studio_status", "arguments": {}}},
    ]
    payload = "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages).encode("utf-8")
    try:
        stdout, stderr = process.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        return {"ok": False, "error": "MCP 进程在超时时间内没有完成握手"}
    replies = {}
    for line in stdout.decode("utf-8", "replace").splitlines():
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict) and "id" in message:
            replies[message["id"]] = message
    if 1 not in replies or "result" not in replies[1]:
        return {"ok": False, "error": "握手失败", "stderr": stderr.decode("utf-8", "replace")[-400:]}
    tools = [tool["name"] for tool in replies.get(2, {}).get("result", {}).get("tools", [])]
    status = replies.get(3, {}).get("result", {}).get("structuredContent") or {}
    return {"ok": bool(tools) and status.get("ok") is True, "server": replies[1]["result"].get("serverInfo"),
            "tool_count": len(tools), "studio_status": status.get("summary", "未返回")}


def native_check(client_id):
    def run(command):
        try:
            result = subprocess.run(command, capture_output=True, timeout=120, encoding="utf-8", errors="replace")
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ran": True, "ok": False, "output": str(exc)}
        text = (result.stdout + result.stderr).strip()
        lines = text.splitlines()
        # claude: "<name>: ... - ✔ Connected"; hermes test: "✓ Connected" + "✓ Tools discovered: N";
        # codex mcp list: a table row with the server name and "enabled".
        hits = [l.strip() for l in lines if re.search(r"[✓✔] (Connected|Tools discovered)", l)
                or (SERVER in l and re.search(r"Connected|enabled", l))]
        healthy = result.returncode == 0 and bool(hits)
        return {"ran": True, "ok": healthy, "output": " / ".join(hits)[:300] or text[-300:]}
    if client_id == "claude_code":
        found = shutil.which("claude") or next(iter(sorted(
            Path(os.environ.get("APPDATA", "")).glob("Claude/claude-code/*/*/claude.exe"))), None)
        return run([str(found), "mcp", "list"]) if found else {"ran": False}
    if client_id == "codex":
        found = shutil.which("codex")
        return run([found, "mcp", "list"]) if found else {"ran": False}
    if client_id == "hermes":
        homes = [Path(os.environ["HERMES_HOME"])] if os.environ.get("HERMES_HOME") else []
        homes.append(Path(os.environ.get("LOCALAPPDATA", "")) / "hermes")
        found = shutil.which("hermes") or next((home / "bin" / "hermes.exe" for home in homes
                                                if (home / "bin" / "hermes.exe").is_file()), None)
        return run([str(found), "mcp", "test", SERVER]) if found else {"ran": False}
    return {"ran": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3848")
    parser.add_argument("--client", action="append")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    data = fetch(args.url.rstrip("/") + "/api/studio/clients")
    report = []
    for client in data["items"]:
        if args.client and client["id"] not in args.client:
            continue
        row = {"client": client["id"], "name": client["name"], "detected": client["detected"],
               "mcp_state": client["mcp"]["state"],
               "skills": {s["id"]: s.get("installed") or s["state"] for s in client["skills"]}}
        entry, source = read_entry(client)
        row["config"] = source
        if entry:
            row["launch"] = handshake(entry)
            row["native"] = native_check(client["id"])
        else:
            row["launch"] = {"ok": False, "error": "客户端配置中没有 deepwhite-studio（尚未连接）"}
            row["native"] = {"ran": False}
        report.append(row)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for row in report:
            launch, native = row["launch"], row["native"]
            print(f"[{row['name']}] 检测到={row['detected']} 状态={row['mcp_state']}")
            print(f"  配置：{row['config']}")
            print("  按客户端配置启动：" + (f"通过（{launch['tool_count']} 个工具；{launch['studio_status']}）"
                                      if launch["ok"] else f"未通过：{launch.get('error') or launch.get('studio_status')}"))
            if native.get("ran"):
                print(f"  客户端自检：{'通过' if native['ok'] else '未通过'}  {native['output']}")
            print("  Skills：" + "，".join(f"{k}={v}" for k, v in row["skills"].items()))
    return 0 if all(r["launch"]["ok"] for r in report if r["mcp_state"] in ("connected", "manual")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
