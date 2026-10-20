"""Client-specific local MCP configuration. Contains paths, never credentials."""
import json
import os
from pathlib import Path
import tempfile


def install_portable_bridge(application, runtime, install_root):
    """Stable data-directory entry; version-only updates need not replace Start.ps1."""
    root = Path(install_root).resolve()
    if not application.is_relative_to(root / "versions") or runtime != root / "userdata":
        return None
    template = application / "studio_mcp_bootstrap.ps1"
    if not template.is_file() or not (root / "current.json").is_file():
        return None
    folder = runtime / "integrations"
    folder.mkdir(parents=True, exist_ok=True)
    if folder.is_symlink() or not folder.resolve().is_relative_to(runtime):
        raise OSError("MCP integration directory must remain inside user data")
    destination = folder / "deepwhite-mcp.ps1"
    if destination.is_symlink():
        raise OSError("MCP bootstrap must be a regular file")
    # UTF-8 BOM is required for Chinese installation paths on Windows PowerShell 5.
    content = template.read_text(encoding="utf-8").encode("utf-8-sig")
    if not destination.exists() or destination.read_bytes() != content:
        fd, temporary = tempfile.mkstemp(prefix=".mcp-", suffix=".tmp", dir=folder)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return destination


def powershell_command(command, args):
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    return "& " + " ".join(quote(value) for value in [command, *args])


def client_configuration(executable, application, runtime, base_url, install_root=None):
    application, runtime = Path(application).resolve(), Path(runtime).resolve()
    entry = {"command": str(executable), "args": ["-B", str(application / "studio_mcp.py"), "--url", base_url],
             "env": {"DEEPWHITE_STUDIO_RUNTIME_DIR": str(runtime)}}
    stable = False
    launcher_error = False
    if install_root:
        root = Path(install_root).resolve()
        try:
            launcher = install_portable_bridge(application, runtime, root)
        except OSError:
            launcher = None
            launcher_error = True
        if launcher:
            entry = {
                "command": str(Path(os.environ.get("SystemRoot", r"C:\Windows")) /
                               "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"),
                # Same process-only policy scope as the portable Start.cmd.
                # This does not change LocalMachine/CurrentUser/organization policy.
                "args": ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                         "-File", str(launcher), "-InstallRoot", str(root)],
                "env": {},
            }
            stable = True
    encode = lambda value: json.dumps(value, ensure_ascii=False)
    codex = ('[mcp_servers.deepwhite-studio]\n'
             f'command = {encode(entry["command"])}\nargs = {encode(entry["args"])}\n'
             'startup_timeout_sec = 30\ntool_timeout_sec = 60\n')
    if entry["env"]:
        codex += '\n[mcp_servers.deepwhite-studio.env]\n'
        codex += "".join(f'{name} = {encode(value)}\n' for name, value in entry["env"].items())
    check_args = entry["args"] + (["-Check"] if stable else ["--check", "--json"])
    check = powershell_command(entry["command"], check_args)
    if not stable:
        runtime_value = str(runtime).replace("'", "''")
        # Scope the environment to a child script block and restore it even on error.
        check = ("& { $previousRuntime = $env:DEEPWHITE_STUDIO_RUNTIME_DIR; try { "
                 f"$env:DEEPWHITE_STUDIO_RUNTIME_DIR = '{runtime_value}'; {check}"
                 " } finally { $env:DEEPWHITE_STUDIO_RUNTIME_DIR = $previousRuntime } }")
    return {"client_config": {"mcpServers": {"deepwhite-studio": entry}},
            "client_configs": {"codex_toml": codex, "claude_json": {"mcpServers": {"deepwhite-studio": entry}}},
            "stable_launcher": stable, "check_command": check,
            "launcher_warning": ("无法写入稳定 MCP 入口；当前使用版本目录。请检查数据目录权限，升级后重新复制配置。"
                                 if launcher_error else ""),
            "connection_help": "MCP 是本机工具连接协议，不是 API 网站。外接客户端与画布须在同一电脑和操作系统环境运行。"}
