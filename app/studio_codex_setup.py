"""Opt-in Codex setup for the OS user running the local canvas.

No arbitrary destination, command, or config content is accepted from HTTP.
Only the generated DeepWhite transport is installed. TOML Kit preserves the
customer's other settings/comments; a semantic comparison guards every write.
"""
import copy
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping

import tomlkit

SERVER = "deepwhite-studio"
LIMIT = 1024 * 1024
RECEIPT = "deepwhite-mcp-last.json"
LOCK = threading.RLock()
TRANSPORT_KEYS = {
    "command", "args", "env", "env_vars", "cwd", "url", "http_headers",
    "env_http_headers", "bearer_token_env_var", "experimental_environment", "oauth",
}


class SetupError(Exception):
    def __init__(self, message, status_code=409):
        super().__init__(message)
        self.status_code = status_code


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _fingerprint(value):
    return _hash(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8"))


def _regular(path, directory=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise SetupError("Codex 配置位置使用了链接或重定向目录，请使用高级选项手动配置。")
    if (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)) or (
            not directory and info.st_nlink > 1):
        raise SetupError("Codex 配置位置不是独立的普通文件或目录，已停止自动修改。")


_RESOLVED_HOMES = {}


def codex_home():
    """The one absolute Codex directory used for its config and its Skills.

    A relative CODEX_HOME is resolved against this service's working directory the
    first time it is seen, so the target shown before an install is the one written.
    """
    raw = os.environ.get("CODEX_HOME", "").strip()
    home = Path(raw).expanduser() if raw else Path.home() / ".codex"
    if str(home).startswith(("\\\\", "//")):
        raise SetupError("CODEX_HOME 不能是网络路径，请改为本机目录后重启画布。")
    if not home.is_absolute():
        home = _RESOLVED_HOMES.setdefault(raw, Path(os.path.abspath(home)))
    return Path(os.path.abspath(home))


def _home():
    home = codex_home()
    for parent in reversed((home, *home.parents)):
        _regular(parent, directory=True)
    return home


def _read(path, limit=LIMIT):
    _regular(path)
    if not path.exists():
        return None
    if path.stat().st_size > limit:
        raise SetupError("Codex 配置文件过大，已停止自动修改，请使用高级选项。")
    with path.open("rb") as stream:
        result = stream.read(limit + 1)
    if len(result) > limit:
        raise SetupError("Codex 配置文件过大，已停止自动修改，请使用高级选项。")
    return result


def _parse(raw):
    try:
        document = tomlkit.parse((raw or b"").decode("utf-8-sig"))
    except (ValueError, UnicodeError, tomlkit.exceptions.ParseError):
        raise SetupError("Codex 配置格式无效，原文件未改动。请先在 Codex 中修复配置。") from None
    servers = document.get("mcp_servers", {})
    if not isinstance(servers, Mapping) or (
            SERVER in servers and not isinstance(servers[SERVER], Mapping)):
        raise SetupError("Codex 的 MCP 配置结构异常，原文件未改动。请使用高级选项检查。")
    return document


def _snapshot(home):
    raw = _read(home / "config.toml")
    revision = _hash(str(home).encode("utf-8") + (b"\0missing" if raw is None else b"\0file" + raw))
    return raw, _parse(raw), revision


def _desired(configuration):
    if configuration.get("launcher_warning"):
        raise SetupError("当前安装的连接启动入口不可用，请检查完整安装包后重试。")
    try:
        entry = _parse(configuration["client_configs"]["codex_toml"].encode())["mcp_servers"][SERVER]
        if not entry.get("command") or not isinstance(entry.get("args"), list):
            raise ValueError()
        return entry.unwrap()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise SetupError("当前画布的连接配置不可用，请重新启动画布后重试。") from None


def _entry(document):
    return document.get("mcp_servers", {}).get(SERVER)


def _matches(entry, desired):
    if entry is None or entry.get("enabled", True) is not True:
        return False
    return all(entry.get(key, {} if key == "env" else None) == desired.get(
        key, {} if key == "env" else None) for key in TRANSPORT_KEYS | set(desired))


def _receipt(home):
    try:
        raw = _read(home / RECEIPT, 64 * 1024)
        value = json.loads(raw) if raw else {}
        if not isinstance(value, dict):
            return {}
        name = value.get("backup")
        if not isinstance(name, str) or not re.fullmatch(r"config-\d{8}-\d{6}-[a-f0-9]{12}\.toml", name):
            return {}
        if any(not isinstance(value.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", value[key])
               for key in ("before_hash", "after_hash", "after_entry")):
            return {}
        return value
    except (OSError, ValueError, SetupError):
        return {}


def _can_undo(home, document):
    receipt = _receipt(home)
    if not receipt or receipt.get("after_entry") != _fingerprint(_entry(document)):
        return False
    try:
        folder = home / "deepwhite-backups"
        _regular(folder, directory=True)
        backup = _read(folder / receipt["backup"])
        return backup is not None and _hash(backup) == receipt.get("before_hash")
    except (OSError, SetupError):
        return False


def status(configuration):
    result = {"state": "blocked", "revision": "", "config_path": "",
              "can_install": False, "can_undo": False,
              "portable": bool(configuration.get("stable_launcher"))}
    try:
        desired = _desired(configuration)
        home = _home()
        result["config_path"] = str(home / "config.toml")
        _, document, revision = _snapshot(home)
        entry = _entry(document)
        state = "missing" if entry is None else "installed" if _matches(entry, desired) else "different"
        message = {
            "missing": "尚未配置。点击自动配置，将连接加入这台电脑当前用户的 Codex。",
            "installed": "深白连接已配置。请在 Codex 中重启 MCP 连接，或退出并重新打开 Codex。",
            "different": "检测到另一份深白连接，可能来自旧安装目录。确认后可更新为当前画布。",
        }[state]
        raw = os.environ.get("CODEX_HOME", "").strip()
        if raw and not Path(raw).expanduser().is_absolute():
            message += f" 注意：CODEX_HOME 是相对路径，已按画布的启动目录解析为 {home}；若 Codex 使用的不是这个目录，请把 CODEX_HOME 改为绝对路径。"
        result.update(state=state, revision=revision, message=message,
                      can_install=True, can_undo=_can_undo(home, document))
    except SetupError as exc:
        result["message"] = str(exc)
    except OSError:
        result["message"] = "无法读取当前用户的 Codex 配置，请检查目录访问权限后重试。"
    return result


@contextmanager
def _file_lock(home):
    home.mkdir(parents=True, exist_ok=True)
    _home()  # Check newly created ancestors too.
    path = home / ".deepwhite-mcp.lock"
    _regular(path)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "r+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SetupError("另一份画布正在配置 Codex，请稍后重试。") from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _atomic_write(path, raw):
    _regular(path)
    descriptor, name = tempfile.mkstemp(prefix=".deepwhite-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        _regular(path)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _backup(home, raw):
    folder = home / "deepwhite-backups"
    _regular(folder, directory=True)
    folder.mkdir(exist_ok=True)
    _regular(folder, directory=True)
    name = "config-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12] + ".toml"
    _atomic_write(folder / name, raw or b"")
    return name


def _without_server(document):
    value = copy.deepcopy(document.unwrap())
    value.get("mcp_servers", {}).pop(SERVER, None)
    if not value.get("mcp_servers"):
        value.pop("mcp_servers", None)
    return value


def _replace_mapping(document, keys, replacement):
    # Edit values in place: replacing a dotted TOML table wholesale can change
    # the scope of later root keys. This also retains comments on policy keys.
    def current():
        target = document
        for key in keys:
            target = target[key]
        return target
    for key in list(current()):
        if key not in replacement:
            del current()[key]
    for key, value in replacement.items():
        # Out-of-order TOML tables use proxies whose indices can change after
        # removing a child table. Never keep that proxy across mutations.
        target = current()
        if isinstance(value, Mapping) and isinstance(target.get(key), Mapping):
            _replace_mapping(document, (*keys, key), value)
        else:
            target[key] = copy.deepcopy(value)


def _render(document, raw, previous):
    text = tomlkit.dumps(document)
    # Preserve BOM and the file's usual newline convention.
    if raw and b"\r\n" in raw:
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    encoded = (b"\xef\xbb\xbf" if raw and raw.startswith(b"\xef\xbb\xbf") else b"") + text.encode("utf-8")
    after = _parse(encoded)
    if _fingerprint(_without_server(after)) != _fingerprint(_without_server(previous)):
        raise SetupError("配置合并检查未通过，原文件未改动。请使用高级选项手动配置。")
    return encoded


def configure(configuration, payload):
    allowed = {"action", "expected_revision", "replace_existing"}
    if (not isinstance(payload, dict) or set(payload) - allowed or
            payload.get("action") not in ("install", "undo", "remove") or
            not isinstance(payload.get("expected_revision"), str) or
            not isinstance(payload.get("replace_existing", False), bool)):
        raise SetupError("配置请求无效，请刷新页面重试。", 400)
    try:
        with LOCK:
            desired = _desired(configuration)
            home = _home()
            # Parse before creating lock/backup files; malformed customer files
            # are never modified as a side effect of validation.
            _snapshot(home)
            with _file_lock(home):
                raw, document, revision = _snapshot(home)
                if payload["expected_revision"] != revision:
                    raise SetupError("Codex 配置已变化，请刷新连接状态后重试。")
                entry = _entry(document)
                previous = copy.deepcopy(document)
                if payload["action"] == "install":
                    if _matches(entry, desired):
                        return dict(status(configuration), changed=False)
                    if entry is not None and not payload.get("replace_existing"):
                        raise SetupError("已有深白连接。请确认替换后，再更新为当前画布。")
                    # Keep tool restrictions/approval policy while replacing
                    # obsolete transport fields from a different installation.
                    replacement = copy.deepcopy(entry.unwrap()) if entry is not None else {}
                    for key in TRANSPORT_KEYS:
                        replacement.pop(key, None)
                    replacement.update(desired)
                    replacement["enabled"] = True
                    if "mcp_servers" not in document:
                        document["mcp_servers"] = tomlkit.table()
                    if entry is None:
                        document["mcp_servers"][SERVER] = replacement
                    else:
                        _replace_mapping(document, ("mcp_servers", SERVER), replacement)
                    encoded = _render(document, raw, previous)
                    if not _matches(_entry(_parse(encoded)), desired):
                        raise SetupError("连接配置校验失败，原文件未改动。")
                    backup = _backup(home, raw)
                    receipt = {"backup": backup, "before_hash": _hash(raw or b""),
                               "after_hash": _hash(encoded), "after_entry": _fingerprint(_entry(document))}
                    # Write-ahead receipt: if the process stops immediately after
                    # config replacement, the next start still offers undo.
                    _atomic_write(home / RECEIPT, json.dumps(receipt).encode("utf-8"))
                    message = "已自动配置，并保留原配置备份。请重启 Codex 的 MCP 连接，再检查画布工具。"
                elif payload["action"] == "remove":
                    if entry is None:
                        return dict(status(configuration), changed=False)
                    document["mcp_servers"].pop(SERVER, None)
                    encoded = _render(document, raw, previous)
                    _backup(home, raw)
                    message = "已断开深白连接，其他 Codex 设置已保留，原配置已备份。请重启 Codex。"
                else:
                    if not _can_undo(home, document):
                        raise SetupError("此连接在配置后已被修改，或没有可用备份，无法自动撤销。")
                    receipt = _receipt(home)
                    backup_raw = _read(home / "deepwhite-backups" / receipt["backup"])
                    backup_document = _parse(backup_raw)
                    if _hash(raw or b"") == receipt["after_hash"]:
                        encoded = backup_raw
                    else:
                        old_entry = _entry(backup_document)
                        if old_entry is None:
                            document["mcp_servers"].pop(SERVER, None)
                        else:
                            _replace_mapping(document, ("mcp_servers", SERVER), old_entry)
                        encoded = _render(document, raw, previous)
                    message = "已撤销上次深白连接配置，其他设置已保留。请重启 Codex 的 MCP 连接。"
                # Do not overwrite an edit made by Codex while backing up.
                if _snapshot(home)[2] != revision:
                    raise SetupError("Codex 配置在操作期间已变化，未覆盖新内容。请刷新后重试。")
                _atomic_write(home / "config.toml", encoded)
                return dict(status(configuration), changed=True, message=message)
    except OSError:
        raise SetupError("未能完成 Codex 配置操作。请刷新状态，并检查目录权限或文件占用后重试；已生成的备份会保留。") from None
