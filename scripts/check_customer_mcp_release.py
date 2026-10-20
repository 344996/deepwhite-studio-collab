"""Exercise customer Codex setup from an actual Windows portable release.

Usage:
    python scripts/check_customer_mcp_release.py --release RELEASE_DIR \
        --workspace NEW_DIRECTORY [--codex /absolute/path/to/codex.exe]

The new workspace is retained as evidence. The app runs with its bundled Python,
without system Python on PATH, and with an isolated CODEX_HOME. No real customer
configuration is modified and no inference or provider generation is requested.
Only owned fixture processes are stopped. The installation is moved only between
verified directories inside the newly created verification workspace.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import queue
import subprocess
import threading
import time
import tomllib
import zipfile

import httpx

import build_windows_release as build
from check_portable_release import Rehearsal, read, wait_for
from sign_release import canonical


SERVER_NAME = "deepwhite-studio"
SOURCE_ROOT = Path(__file__).resolve().parents[1]
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CUSTOMER_CONFIG = (
    '# Customer notes must survive setup: 中文 / spaces / apostrophe\'s.\r\n'
    'model_provider = "fixture"\r\n'
    'model = "fixture-no-inference"\r\n'
    '\r\n'
    '# This offline provider must never be called by this check.\r\n'
    '[model_providers.fixture]\r\n'
    'name = "Offline verification only"\r\n'
    'base_url = "http://127.0.0.1:9/v1"\r\n'
    'wire_api = "responses"\r\n'
    '\r\n'
    '# A customer-owned MCP entry, deliberately disabled.\r\n'
    '[mcp_servers.keep_customer_entry]\r\n'
    'command = "never-run-fixture"\r\n'
    'enabled = false\r\n'
    'args = ["preserve spaces", "中文", "apostrophe\'s"]\r\n'
).encode("utf-8")


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def parse_config(path):
    return tomllib.loads(path.read_text(encoding="utf-8-sig"))


def only_customer_configuration(value):
    value = copy.deepcopy(value)
    servers = value.get("mcp_servers", {})
    servers.pop(SERVER_NAME, None)
    if not servers:
        value.pop("mcp_servers", None)
    return value


def assert_customer_preserved(path):
    """Check values and every original line, including comments, in order."""
    expected = tomllib.loads(CUSTOMER_CONFIG.decode("utf-8"))
    assert only_customer_configuration(parse_config(path)) == expected
    actual = iter(path.read_text(encoding="utf-8-sig").splitlines())
    for original in CUSTOMER_CONFIG.decode("utf-8").splitlines():
        assert any(line == original for line in actual), (
            "A customer preference/comment line was changed or removed"
        )


def child_environment(codex_home):
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith("DEEPWHITE_")
        and key not in {
            "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY",
        }
    }
    environment.update(
        PATH=str(Path(os.environ["SystemRoot"]) / "System32"),
        CODEX_HOME=str(codex_home),
        DEEPWHITE_NO_BROWSER="1",
        DEEPWHITE_STUDIO_NO_BROWSER="1",
        PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1",
        OTEL_SDK_DISABLED="true",
    )
    environment.pop("PYTHONPATH", None)
    environment.pop("PYTHONHOME", None)
    return environment


class CustomerInstallation(Rehearsal):
    def __init__(self, root, workspace, report, codex_home):
        super().__init__(root, workspace, report)
        self.environment = child_environment(codex_home)
        # Portable startup can take a little longer on a fresh extracted tree.
        self.http.timeout = httpx.Timeout(30)

    def launch(self, use_config=False):
        command = Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"
        invocation = (
            '"' + str(command) + '" /d /v:off /s /c ""'
            + str(self.root / "Start.cmd") + '" -NoBrowser'
            + ("" if use_config else " -Port " + str(self.port)) + '"'
        )
        completed = subprocess.run(
            invocation, cwd=self.root, env=self.environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=30, creationflags=CREATE_NO_WINDOW,
        )
        assert completed.returncode == 0, "The packaged Start.cmd failed"

    def setup_status(self):
        response = self.http.get("/api/studio/control/codex")
        response.raise_for_status()
        result = response.json()
        assert result["state"] in {"missing", "installed", "different", "blocked"}
        assert isinstance(result["revision"], str)
        return result

    def setup(self, action, status=None, *, replace=False, expected_code=200):
        status = self.setup_status() if status is None else status
        response = self.http.post("/api/studio/control/codex", json={
            "action": action, "expected_revision": status["revision"],
            "replace_existing": replace,
        })
        assert response.status_code == expected_code, (
            f"{action} returned HTTP {response.status_code}, expected {expected_code}"
        )
        return response.json()


class CodexClient:
    """Small JSON-lines app-server client; never issues an inference turn."""
    def __init__(self, executable, environment, workspace, stderr):
        self.process = subprocess.Popen(
            [str(executable), "app-server", "--stdio"], cwd=workspace,
            env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=stderr, text=True, encoding="utf-8",
            creationflags=CREATE_NO_WINDOW,
        )
        self.messages = queue.Queue()
        self.serial = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    pass
        finally:
            self.messages.put({"_closed": True})

    def send(self, method, parameters, request_id=None):
        message = {"method": method, "params": parameters}
        if request_id is not None:
            message["id"] = request_id
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, method, parameters):
        self.serial += 1
        self.send(method, parameters, self.serial)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(
                    timeout=max(0.1, deadline - time.monotonic())
                )
            except queue.Empty as exc:
                raise TimeoutError(method) from exc
            if message.get("_closed"):
                raise RuntimeError("Codex app-server exited before " + method)
            if message.get("id") == self.serial:
                if "error" in message:
                    raise RuntimeError("Codex rejected " + method)
                return message["result"]
        raise TimeoutError(method)

    def close(self):
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.reader.join(timeout=2)


def unpack_release(release, installation, report):
    output = release if release.is_dir() else release.parent
    built = read(output / "build-report.json")
    candidates = list(output.glob("*-portable.zip")) if release.is_dir() else [release]
    assert len(candidates) == 1, "Specify exactly one portable release ZIP"
    package = candidates[0]
    expected = built["files"][package.name]
    assert package.stat().st_size == expected["size"]
    assert build.sha256(package) == expected["sha256"]
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None, "The release ZIP is damaged"
        names = archive.namelist()
        assert {"Start.cmd", "Start.ps1", "current.json", "userdata/", "updates/"} <= set(names)
        for name in names:
            relative = PurePosixPath(name)
            assert not relative.is_absolute() and ".." not in relative.parts
            assert "\\" not in name and ":" not in name
            assert (installation / name).resolve().is_relative_to(installation)
        archive.extractall(installation)
    assert read(installation / "current.json")["version"] == built["version"]
    report.update(version=built["version"], commit=built["commit"],
                  portable_sha256=expected["sha256"])
    return built["version"]


def assert_portable_entry(config, installation):
    entry = parse_config(config)["mcp_servers"][SERVER_NAME]
    arguments = entry["args"]
    assert "-InstallRoot" in arguments and "-File" in arguments
    assert Path(arguments[arguments.index("-InstallRoot") + 1]).resolve() == installation
    assert Path(arguments[arguments.index("-File") + 1]).resolve().is_relative_to(
        installation / "userdata"
    )
    text = json.dumps(entry, ensure_ascii=False).replace("\\\\", "/").casefold()
    assert str(SOURCE_ROOT).replace("\\", "/").casefold() not in text
    assert ".venv" not in text
    assert not entry.get("env", {}).get("DEEPWHITE_STUDIO_RUNTIME_DIR")
    return entry


def result_value(reply):
    assert not reply.get("isError"), "The MCP tool returned an application error"
    if reply.get("structuredContent") is not None:
        return reply["structuredContent"]
    return json.loads(reply["content"][0]["text"])


def verify_stdio(installation, config, codex_home, workspace, label, canvas_id):
    entry = assert_portable_entry(config, installation)
    command = [entry["command"], *entry["args"]]
    environment = dict(child_environment(codex_home), **entry.get("env", {}))
    checked = subprocess.run(
        command + ["-Check"], cwd=workspace, env=environment, timeout=45,
        capture_output=True, creationflags=CREATE_NO_WINDOW,
    )
    (workspace / (label + "-preflight.stderr.log")).write_bytes(checked.stderr)
    assert checked.returncode == 0, "Packaged MCP preflight failed; see fixture log"
    preflight = json.loads(checked.stdout.decode("utf-8-sig"))
    assert preflight["ok"] is True
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "customer-release-verification", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "list_projects", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "list_canvases", "arguments": {"project_id": "default"}}},
    ]
    completed = subprocess.run(
        command, cwd=workspace, env=environment, timeout=45,
        input=("\n".join(json.dumps(item) for item in requests) + "\n").encode(),
        capture_output=True, creationflags=CREATE_NO_WINDOW,
    )
    (workspace / (label + "-stdio.stderr.log")).write_bytes(completed.stderr)
    assert completed.returncode == 0, "Packaged MCP stdio failed; see fixture log"
    replies = {}
    for line in completed.stdout.decode("utf-8-sig").splitlines():
        reply = json.loads(line)
        if reply.get("id") is not None:
            replies[reply["id"]] = reply
    assert all(key in replies and "error" not in replies[key] for key in (1, 2, 3, 4))
    tools = sorted(item["name"] for item in replies[2]["result"]["tools"])
    assert len(tools) == 13 and {"list_projects", "list_canvases"} <= set(tools)
    projects = result_value(replies[3]["result"])
    canvases = result_value(replies[4]["result"])
    assert any(item["id"] == canvas_id for item in canvases["items"])
    (workspace / (label + "-stdio.json")).write_bytes(canonical({
        "preflight": preflight, "tools": tools, "projects": projects,
        "canvas_count": len(canvases["items"]),
    }))
    return tools


def verify_real_codex(executable, codex_home, workspace, label, expected_tools):
    environment = child_environment(codex_home)
    version = subprocess.check_output(
        [str(executable), "--version"], env=environment, cwd=workspace,
        timeout=15, text=True, encoding="utf-8", creationflags=CREATE_NO_WINDOW,
    ).strip()
    client = None
    with (workspace / (label + "-codex.stderr.log")).open("w", encoding="utf-8") as log:
        try:
            client = CodexClient(executable, environment, workspace, log)
            initialized = client.call("initialize", {
                "clientInfo": {"name": "deepwhite_customer_verification", "version": "1"},
                "capabilities": {"experimentalApi": True},
            })
            client.send("initialized", {})
            thread = client.call("thread/start", {
                "cwd": str(workspace), "ephemeral": True,
                "approvalPolicy": "never", "sandbox": "read-only",
            })
            thread_id = thread["thread"]["id"]
            inventory = client.call("mcpServerStatus/list", {
                "threadId": thread_id, "serverName": SERVER_NAME,
                "detail": "toolsAndAuthOnly",
            })
            def tool(name):
                return result_value(client.call("mcpServer/tool/call", {
                    "threadId": thread_id, "server": SERVER_NAME,
                    "tool": name, "arguments": {},
                }))
            projects = tool("list_projects")
            schema = tool("get_node_schema")
            assert sorted(schema["input_schemas"]) == expected_tools
            (workspace / (label + "-codex.json")).write_bytes(canonical({
                "version": version, "initialize": initialized, "inventory": inventory,
                "tools": expected_tools, "projects": projects,
                "inference_used": False, "provider_generation_used": False,
            }))
        finally:
            if client:
                client.close()
    return version


def configuration_backups(installation, codex_home, config, expected):
    matches = []
    for parent in (installation / "userdata", codex_home):
        if not parent.exists():
            continue
        for candidate in parent.rglob("*"):
            if candidate != config and candidate.is_file() and not candidate.is_symlink():
                if candidate.stat().st_size == len(expected) and candidate.read_bytes() == expected:
                    matches.append(candidate)
    return matches


def assert_rejected(response):
    assert 400 <= response.status_code < 500, (
        f"Unsafe installation was not rejected: HTTP {response.status_code}"
    )


def verify(release, workspace, codex=None):
    if os.name != "nt":
        raise RuntimeError("This verifier exercises the Windows portable launcher")
    release, workspace = release.resolve(), workspace.resolve()
    real_config = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    original_real_digest = file_digest(real_config)
    workspace.mkdir(parents=True, exist_ok=False)
    report = {
        "passed": False, "checks": [], "provider_generation_used": False,
        "inference_used": False, "other_computer_verified": False,
        "real_codex_client_requested": codex is not None,
    }
    codex_home = workspace / "客户配置 中文 & (Codex) single'quote"
    config = codex_home / "config.toml"
    initial = workspace / "客户安装 中文 & ! (画布) single'quote"
    moved = workspace / "客户移动后 中文 & ! (新位置) single'quote"
    assert not config.exists() and config.resolve() != real_config.resolve()
    instance = None
    try:
        version = unpack_release(release, initial, report)
        instance = CustomerInstallation(initial, workspace, report, codex_home)
        instance.record("Actual portable ZIP hash, version and safe extraction verified")
        instance.launch()
        health = wait_for(lambda: instance.health(version), label="customer portable startup")
        assert Path(instance.owned("server-process.json").exe()).resolve() == (
            initial / "versions" / version / "python" / "python.exe"
        ).resolve()
        instance.record("Packaged Start.cmd starts the embedded interpreter with no system Python on PATH",
                        version=health["version"], profile="isolated")

        status = instance.setup_status()
        assert status["state"] == "missing" and status["portable"] is True
        assert Path(status["config_path"]).resolve() == config.resolve()
        assert not config.exists(), "Reading setup status changed the customer configuration"
        denied = instance.http.post("/api/studio/control/codex", json={
            "action": "install", "expected_revision": status["revision"],
            "replace_existing": False,
        })
        assert_rejected(denied)
        assert not config.exists()
        instance.record("Setup status is read-only and disabled MCP blocks configuration installation")

        enabled = instance.http.put("/api/studio/control/settings", json={
            "enabled": True, "generation_mode": "confirm",
        })
        enabled.raise_for_status()
        status = instance.setup_status()
        assert status["can_install"] is True
        payload = {"action": "install", "expected_revision": status["revision"],
                   "replace_existing": False}
        for origin in (None, "https://untrusted.example.invalid"):
            with httpx.Client(base_url=instance.base, timeout=10, trust_env=False) as outside:
                headers = {} if origin is None else {"Origin": origin}
                assert_rejected(outside.post("/api/studio/control/codex", json=payload, headers=headers))
            assert not config.exists()
        instance.record("Missing or foreign Origin cannot write the isolated Codex configuration")

        instance.setup("install")
        assert instance.setup_status()["state"] == "installed"
        assert_portable_entry(config, initial)
        instance.setup("undo")
        assert not config.exists() or parse_config(config) == {}, (
            "Undo of a first installation must restore the original empty settings"
        )
        instance.record("A new customer profile installs automatically and undo restores empty settings")

        codex_home.mkdir(parents=True, exist_ok=True)
        config.write_bytes(CUSTOMER_CONFIG)
        status = instance.setup_status()
        assert status["state"] == "missing"
        stale = dict(status, revision="0" * 64)
        instance.setup("install", stale, expected_code=409)
        assert config.read_bytes() == CUSTOMER_CONFIG
        instance.record("A stale revision cannot overwrite newer customer preferences")

        instance.setup("install", status)
        status = instance.setup_status()
        assert status["state"] == "installed" and status["can_undo"] is True
        assert_customer_preserved(config)
        before_repeat = config.read_bytes()
        backups = configuration_backups(initial, codex_home, config, CUSTOMER_CONFIG)
        assert backups, "The original customer configuration has no recoverable backup"
        instance.setup("install", status)
        assert config.read_bytes() == before_repeat
        assert configuration_backups(initial, codex_home, config, CUSTOMER_CONFIG) == backups
        instance.record("Automatic setup preserves preferences, comments and other MCP entries; repeat is idempotent",
                        recoverable_backups=len(backups))
        instance.setup("undo")
        assert config.read_bytes() == CUSTOMER_CONFIG
        assert instance.setup_status()["state"] == "missing"
        instance.record("Undo restores the exact original configuration bytes")
        instance.setup("install")
        assert_customer_preserved(config)

        canvas = instance.canvas("客户便携 MCP 验收 · 不调用模型")
        instance.assert_canvas(canvas)
        tools = verify_stdio(initial, config, codex_home, workspace, "initial", canvas["id"])
        instance.record("Installed customer configuration initializes real stdio, discovers 13 tools and reads saved canvas",
                        tool_count=len(tools))
        if codex:
            client_version = verify_real_codex(codex, codex_home, workspace, "initial", tools)
            instance.record("Installed real Codex app-server discovers and calls the packaged MCP without inference",
                            codex_version=client_version, tool_count=len(tools))

        instance.stop()
        instance.http.close()
        instance = None
        old_configuration = config.read_bytes()
        # Both the existing source and nonexistent destination are constrained
        # to this newly created fixture workspace before any directory move.
        assert initial.resolve().is_relative_to(workspace)
        assert moved.resolve().is_relative_to(workspace)
        assert initial.resolve() != workspace and moved.resolve() != workspace
        assert not initial.is_symlink() and not moved.exists()
        def relocate():
            try:
                initial.rename(moved)
            except PermissionError:
                # The outer launcher can briefly retain its working-directory
                # handle after its owned supervisor and child have exited.
                return False
            return True
        wait_for(relocate, timeout=15, label="stopped fixture directory move")
        instance = CustomerInstallation(moved, workspace, report, codex_home)
        instance.launch()
        wait_for(lambda: instance.health(version), label="moved customer installation")
        instance.assert_canvas(canvas)
        status = instance.setup_status()
        assert status["state"] == "different"
        instance.setup("install", status, expected_code=409)
        assert config.read_bytes() == old_configuration
        instance.record("Moving the complete installation retains data and requires explicit connection replacement")

        instance.setup("install", replace=True)
        assert instance.setup_status()["state"] == "installed"
        assert_customer_preserved(config)
        assert_portable_entry(config, moved)
        assert str(initial).casefold() not in json.dumps(parse_config(config)).replace("\\\\", "\\").casefold()
        instance.setup("undo")
        assert config.read_bytes() == old_configuration
        assert instance.setup_status()["state"] == "different"
        instance.setup("install", replace=True)
        tools = verify_stdio(moved, config, codex_home, workspace, "moved", canvas["id"])
        instance.record("Confirmed repair targets the new installation; undo and repeat repair preserve the prior entry",
                        tool_count=len(tools))
        if codex:
            client_version = verify_real_codex(codex, codex_home, workspace, "moved", tools)
            instance.record("Real Codex reconnects after installation movement and repair",
                            codex_version=client_version, tool_count=len(tools))

        instance.stop()
        instance.launch()
        wait_for(lambda: instance.health(version), label="moved installation restart")
        instance.assert_canvas(canvas)
        assert instance.setup_status()["state"] == "installed"
        instance.record("A subsequent restart keeps the repaired connection and saved canvas")

        working_configuration = config.read_bytes()
        malformed = working_configuration + b"\n[malformed\n"
        config.write_bytes(malformed)
        blocked = instance.setup_status()
        assert blocked["state"] == "blocked" and blocked["can_install"] is False
        assert_rejected(instance.http.post("/api/studio/control/codex", json={
            "action": "install", "expected_revision": blocked["revision"],
            "replace_existing": True,
        }))
        assert config.read_bytes() == malformed
        # Restore only the deliberately broken synthetic fixture.
        config.write_bytes(working_configuration)
        assert instance.setup_status()["state"] == "installed"
        instance.record("Malformed existing TOML is preserved and requires manual repair")
        assert file_digest(real_config) == original_real_digest
        report["passed"] = True
    except Exception as exc:
        report["failure"] = {"type": type(exc).__name__, "message": str(exc)}
        raise
    finally:
        try:
            if instance:
                instance.stop()
        finally:
            if instance:
                instance.http.close()
            report["real_user_config_unchanged"] = file_digest(real_config) == original_real_digest
            if not report["real_user_config_unchanged"]:
                report["passed"] = False
            (workspace / "verification.json").write_bytes(canonical(report))
    assert report["real_user_config_unchanged"], "The real user configuration changed during verification"
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--codex", type=Path)
    args = parser.parse_args()
    if args.codex and not args.codex.is_file():
        parser.error("--codex must be an existing executable")
    result = verify(args.release, args.workspace, args.codex.resolve() if args.codex else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
