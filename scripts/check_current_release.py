"""Verify an actual built portable ZIP in a new isolated Windows installation.

Keeps fixture data and evidence. Never edits the user's Codex configuration or
calls a generation provider. Uses the shipped runtime with system Python removed
from PATH. The existing rehearsal helper checks process ownership before stopping.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import zipfile

import build_windows_release as build
from check_portable_release import Rehearsal, read, wait_for
from sign_release import canonical


def verify(output, workspace):
    output, workspace = output.resolve(), workspace.resolve()
    workspace.mkdir(parents=True, exist_ok=False)
    built = read(output / "build-report.json")
    version = built["version"]
    report = {"version": version, "commit": built["commit"], "checks": [],
              "provider_generation_used": False, "published_release_verified": False}
    installation = workspace / "深白 发布验收 & 测试"
    rehearsal = Rehearsal(installation, workspace, report)
    for name, metadata in built["files"].items():
        artifact = output / name
        assert artifact.stat().st_size == metadata["size"]
        assert build.sha256(artifact) == metadata["sha256"]
    rehearsal.record("Every artifact matches its recorded size and SHA-256")

    package = next(output.glob("*-portable.zip"))
    version_package = next(output.glob("*-version.zip"))
    with zipfile.ZipFile(version_package) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert not any(build.forbidden(name) for name in names)
        assert "app/studio_mcp_bootstrap.ps1" in names
        assert "references/integrations/skills/deepwhite-canvas/SKILL.md" in names
        assert "references/docs/ACCOUNT_API_CONNECT.md" in names
        assert archive.read("app/VERSION").decode().strip() == version
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        assert "userdata/" in archive.namelist()
        assert "updates/" in archive.namelist()
        # This is the builder's hash-verified package, not an arbitrary user ZIP.
        archive.extractall(installation)
    rehearsal.record("Actual ZIP contains offline docs, Skill, runtime and no private data")

    try:
        rehearsal.launch()
        healthy = wait_for(lambda: rehearsal.health(version), label="packaged service")
        rehearsal.record("Start.cmd boots the bundled runtime in a special-character path",
                         running_version=healthy["version"])
        first = rehearsal.canvas("便携包验收 · 未调用模型")
        rehearsal.assert_canvas(first)
        rehearsal.record("Packaged canvas creates, saves and rereads a Unicode text node")

        for route in ("/api/studio/agent/sessions", "/api/chat/agent"):
            assert rehearsal.http.post(route, json={}).status_code == 404
        for page in ("/", "/settings", "/static/canvas.html", "/static/smart-canvas.html"):
            response = rehearsal.http.get(page)
            response.raise_for_status()
            assert "studio-agent.js" not in response.text
            assert "studio-agent-apply.js" not in response.text
        chat = rehearsal.http.get("/static/gpt-chat.html")
        chat.raise_for_status()
        assert "/api/chat/agent" not in chat.text
        rehearsal.record("Product pages load and retired assistant routes are absent")

        response = rehearsal.http.put("/api/studio/control/settings",
                                      json={"enabled": True, "generation_mode": "confirm"})
        response.raise_for_status()
        configuration = response.json()
        assert configuration["stable_launcher"] is True
        entry = configuration["client_config"]["mcpServers"]["deepwhite-studio"]
        assert rehearsal.http.get("/api/studio/control/skill").status_code == 200
        command = [entry["command"], *entry["args"]]
        environment = dict(os.environ, PATH=str(Path(os.environ["SystemRoot"]) / "System32"),
                           **entry.get("env", {}))
        completed = subprocess.run(command + ["-Check"], env=environment, timeout=40,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
        diagnostics = json.loads(completed.stdout.decode("utf-8-sig"))
        assert diagnostics["ok"] is True
        rehearsal.record("Generated fixed MCP entry passes preflight on the actual extracted package")
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "portable-verification", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                "name": "list_projects", "arguments": {}}},
        ]
        completed = subprocess.run(command, env=environment, timeout=40,
                                   input=("\n".join(json.dumps(item) for item in messages) + "\n").encode(),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
        replies = {item["id"]: item for line in completed.stdout.decode("utf-8-sig").splitlines()
                   if (item := json.loads(line)).get("id") is not None}
        assert all("error" not in replies[key] for key in (1, 2, 3)), replies
        assert len(replies[2]["result"]["tools"]) == 13
        assert not replies[3]["result"].get("isError")
        rehearsal.record("Packaged stdio initializes, lists 13 tools and reads projects")

        rehearsal.stop()
        rehearsal.launch()
        wait_for(lambda: rehearsal.health(version), label="packaged restart")
        rehearsal.assert_canvas(first)
        rehearsal.record("Restart retains the saved canvas and independent user data")
        report["passed"] = True
    finally:
        rehearsal.stop()
        rehearsal.http.close()
        (workspace / "verification.json").write_bytes(canonical(report))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.output, args.workspace), ensure_ascii=False, indent=2))
