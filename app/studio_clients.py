"""Connect external agent clients and install DeepWhite Skills, one client at a time.

Each client is configured once per computer and then works for every canvas.
Only files at fixed, client-specific locations under the current OS user are
touched; HTTP callers choose a client id and an action, never a path or content.
Every write keeps a timestamped backup and preserves unrelated settings.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
import zipfile

from studio_integrations import skills_root

SERVER = "deepwhite-studio"
LOCK = threading.RLock()
MARKER = ".deepwhite-skill.json"
LIMIT = 16 * 1024 * 1024


class ClientError(Exception):
    def __init__(self, message, status_code=409):
        super().__init__(message)
        self.status_code = status_code


# ---------------------------------------------------------------- locations

def _home():
    return Path.home()


def _appdata():
    return Path(os.environ.get("APPDATA") or _home() / "AppData" / "Roaming")


def _localappdata():
    return Path(os.environ.get("LOCALAPPDATA") or _home() / "AppData" / "Local")


def _claude_code_dir():
    return Path(os.environ["CLAUDE_CONFIG_DIR"]) if os.environ.get("CLAUDE_CONFIG_DIR") else _home() / ".claude"


def _claude_code_config():
    base = Path(os.environ["CLAUDE_CONFIG_DIR"]) if os.environ.get("CLAUDE_CONFIG_DIR") else _home()
    return base / ".claude.json"


def _claude_desktop_dir():
    # The Microsoft Store (MSIX) build reads a package-private copy when it exists.
    private = _localappdata() / "Packages" / "Claude_pzs8sxrjxfjjc" / "LocalCache" / "Roaming" / "Claude"
    return private if private.is_dir() else _appdata() / "Claude"


def _codex_dir():
    # Same resolution as the Codex config, so Skills and MCP always share one directory.
    import studio_codex_setup
    try:
        return studio_codex_setup.codex_home()
    except studio_codex_setup.SetupError as exc:
        raise ClientError(str(exc)) from None


def _hermes_dir():
    raw = os.environ.get("HERMES_HOME", "").strip()
    if raw:
        return Path(os.path.expandvars(raw)).expanduser()
    return _localappdata() / "hermes" if os.name == "nt" else _home() / ".hermes"


def _doubao_dir():
    # An uninstall leaves "Doubao\User Data" behind; only a program counts.
    application = _localappdata() / "Doubao" / "Application"
    found = next(application.glob("*.exe"), None) if application.is_dir() else None
    return found or application / "Doubao.exe"


CLIENTS = {
    "codex": {"name": "Codex", "format": "codex", "marker": _codex_dir,
              "config": lambda: _codex_dir() / "config.toml", "skills": lambda: _codex_dir() / "skills"},
    "claude_code": {"name": "Claude Code", "format": "claude_code", "marker": _claude_code_dir,
                    "config": _claude_code_config, "skills": lambda: _claude_code_dir() / "skills"},
    "claude_desktop": {"name": "Claude 桌面版", "format": "json", "marker": _claude_desktop_dir,
                       "config": lambda: _claude_desktop_dir() / "claude_desktop_config.json", "skills": None,
                       "skills_hint": "在 Claude 桌面版“设置 → 功能 → Skills”上传下载的 Skill 压缩包。",
                       "restart_hint": "请完全退出 Claude 桌面版（含托盘图标）后再打开。"},
    "workbuddy": {"name": "WorkBuddy", "format": "json", "marker": lambda: _home() / ".workbuddy",
                  "config": lambda: _home() / ".workbuddy" / "mcp.json", "skills": lambda: _home() / ".workbuddy" / "skills"},
    "hermes": {"name": "Hermes", "format": "hermes", "marker": _hermes_dir,
               "config": lambda: _hermes_dir() / "config.yaml", "skills": lambda: _hermes_dir() / "skills"},
    "doubao": {"name": "豆包工作", "format": "manual", "marker": _doubao_dir, "config": None, "skills": None,
               "manual_hint": "豆包工作没有可自动写入的配置文件：在客户端“设置 → MCP 服务 → 添加（JSON）”粘贴下方配置，再点“复制验证命令”核对。",
               "skills_hint": "在豆包客户端的技能（Skills）管理中上传下载的 Skill 压缩包。"},
    # Install location and config file are not known yet: no detection, honest manual setup.
    "deepseek_harness": {"name": "DeepSeek Harness", "format": "manual", "marker": lambda: Path(""), "detect": False,
                         "config": None, "skills": None,
                         "manual_hint": "暂不支持自动检测 DeepSeek Harness 的安装位置和配置文件：请在它的 MCP 设置中添加下方配置，再点“复制验证命令”核对。"},
}

# U11: the connection page shows exactly these five; other entries stay usable through the API.
VISIBLE = ("codex", "claude_code", "workbuddy", "doubao", "deepseek_harness")


# ---------------------------------------------------------------- file helpers

def _regular_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or not stat.S_ISREG(info.st_mode):
        raise ClientError("配置位置使用了链接或不是普通文件，已停止自动修改，请使用手动配置。")
    return True


def _read(path):
    if not _regular_file(path):
        return None
    if path.stat().st_size > LIMIT:
        raise ClientError("配置文件过大，已停止自动修改，请使用手动配置。")
    return path.read_bytes()


def _digest(raw):
    return hashlib.sha256(raw or b"\0missing").hexdigest()


def _atomic_write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".deepwhite-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _backup(path, raw):
    if raw is None:
        return ""
    target = path.with_name(path.name + ".deepwhite-backup-" + time.strftime("%Y%m%d-%H%M%S"))
    _atomic_write(target, raw)
    return str(target)


def _commit(path, before, encoded):
    # A client may rewrite its own file meanwhile; never overwrite that edit.
    if _digest(_read(path)) != _digest(before):
        raise ClientError("配置文件在操作期间被客户端修改，未覆盖新内容。请刷新后重试。")
    backup = _backup(path, before)
    _atomic_write(path, encoded)
    return backup


# ---------------------------------------------------------------- entries

def _entry(configuration, client_format):
    entry = dict(configuration["client_config"]["mcpServers"][SERVER])
    entry = {"command": entry["command"], "args": list(entry["args"]), "env": dict(entry.get("env") or {})}
    if client_format == "claude_code":
        entry = {"type": "stdio", **entry}
    return entry


def _same(found, wanted):
    if not isinstance(found, dict):
        return False
    return all(found.get(key, {} if key == "env" else None) == value for key, value in wanted.items())


def _json_document(raw):
    if raw is None or not raw.strip():
        return {}
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, ValueError):
        raise ClientError("配置文件不是有效的 JSON，原文件未改动。请修正或使用手动配置。") from None
    if not isinstance(value, dict) or not isinstance(value.get("mcpServers", {}), dict):
        raise ClientError("配置文件结构无法识别，原文件未改动。请使用手动配置。")
    return value


def _json_encode(document, raw):
    text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    if raw and b"\r\n" in raw:
        text = text.replace("\n", "\r\n")
    return text.encode("utf-8")


# Hermes keeps MCP servers in YAML. Only a block-style top-level `mcp_servers:`
# mapping is edited, by whole lines; anything else falls back to manual setup.
def _yaml_block(entry):
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    lines = [f"  {SERVER}:", f"    command: {quote(entry['command'])}", "    args:"]
    lines += [f"      - {quote(arg)}" for arg in entry["args"]]
    if entry.get("env"):
        lines.append("    env:")
        lines += [f"      {key}: {quote(value)}" for key, value in entry["env"].items()]
    return lines


def _yaml_find(lines):
    top = next((i for i, line in enumerate(lines) if re.match(r"^mcp_servers\s*:", line)), None)
    if top is None:
        return None, None, None
    rest = lines[top].split(":", 1)[1].split("#", 1)[0].strip()
    if rest not in ("", "{}"):
        raise ClientError("Hermes 配置中的 mcp_servers 不是可安全编辑的写法，请使用手动配置。")
    end = top + 1
    while end < len(lines) and (not lines[end].strip() or lines[end].startswith((" ", "\t"))):
        end += 1
    start = stop = None
    for i in range(top + 1, end):
        if re.match(rf"^  {re.escape(SERVER)}\s*:", lines[i]):
            start, stop = i, i + 1
            while stop < end and (not lines[stop].strip() or lines[stop].startswith("    ")):
                stop += 1
    return top, start, stop


def _yaml_text(raw):
    try:
        return (raw or b"").decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ClientError("Hermes 配置文件不是 UTF-8 编码，原文件未改动。请用文本编辑器另存为 UTF-8 后点“刷新”。") from None


def _yaml_state(raw, entry):
    lines = _yaml_text(raw).splitlines()
    top, start, stop = _yaml_find(lines)
    if start is None:
        return "missing"
    return "connected" if [line for line in lines[start:stop] if line.strip()] == _yaml_block(entry) else "different"


def _yaml_apply(raw, entry, remove=False):
    text = _yaml_text(raw)
    lines = text.splitlines()
    top, start, stop = _yaml_find(lines)
    if start is not None:
        del lines[start:stop]
    if not remove:
        if top is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines += ["mcp_servers:", *_yaml_block(entry)]
        else:
            lines[top] = "mcp_servers:"
            lines[top + 1:top + 1] = _yaml_block(entry)
    newline = "\r\n" if "\r\n" in text else "\n"
    return (newline.join(lines) + newline).encode("utf-8")


# ---------------------------------------------------------------- skills

def catalog():
    try:
        data = json.loads((skills_root() / "catalog.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = []
    for item in data.get("skills", []) if isinstance(data, dict) else []:
        if (isinstance(item, dict) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", str(item.get("id", ""))) and
                re.fullmatch(r"\d+\.\d+\.\d+", str(item.get("version", ""))) and
                (skills_root() / item["id"] / "SKILL.md").is_file()):
            rows.append({"id": item["id"], "name": str(item.get("name") or item["id"]),
                         "version": item["version"], "description": str(item.get("description", ""))})
    return rows


def _skill_files(skill_id):
    folder = skills_root() / skill_id
    files = {}
    for path in sorted(folder.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.name != MARKER:
            relative = path.relative_to(folder).as_posix()
            if path.suffix.lower() not in (".md", ".txt", ".json", ".yaml", ".yml"):
                continue
            files[relative] = path.read_bytes()
    if "SKILL.md" not in files or sum(len(v) for v in files.values()) > 2 * 1024 * 1024:
        raise ClientError("Skill 文件不完整或过大，请检查安装包。")
    return files


def _version_tuple(value):
    try:
        return tuple(int(part) for part in str(value).split("."))
    except ValueError:
        return (0,)


def _installed(folder):
    try:
        marker = json.loads((folder / MARKER).read_text(encoding="utf-8"))
        return marker if isinstance(marker, dict) else None
    except (OSError, ValueError):
        return None


def _skill_health(folder, marker):
    """Check an installed Skill against its marker's file list, not only its version.

    "damaged": the entry SKILL.md or a listed file is missing; "modified": a file no
    longer matches its recorded hash; "ok" otherwise.
    """
    manifest = marker.get("sha256") if isinstance(marker.get("sha256"), dict) else {}
    state = "ok"
    for name in sorted(set(manifest) | {"SKILL.md"}):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            return "damaged"
        path = folder / relative
        if path.is_symlink() or not path.is_file():
            return "damaged"
        digest = manifest.get(name)
        if digest and hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            state = "modified"
    return state


def _skill_current(folder, marker, skill):
    return (marker is not None and _version_tuple(marker.get("version")) >= _version_tuple(skill["version"])
            and _skill_health(folder, marker) == "ok")


def skill_rows(client_id):
    spec = CLIENTS[client_id]
    rows = []
    for skill in catalog():
        row = {**skill, "latest": skill["version"], "installed": None}
        if spec["skills"] is None:
            row["state"] = "manual"
        else:
            folder = spec["skills"]() / skill["id"]
            marker = _installed(folder)
            if marker:
                row["installed"] = str(marker.get("version", ""))
                health = _skill_health(folder, marker)
                if health == "damaged":
                    row["state"] = "damaged"
                elif _version_tuple(row["installed"]) < _version_tuple(skill["version"]):
                    row["state"] = "upgrade"
                else:
                    row["state"] = "latest" if health == "ok" else "modified"
            else:
                row["state"] = "foreign" if folder.exists() else "missing"
        rows.append(row)
    return rows


def install_skills(client_id):
    spec = CLIENTS[client_id]
    if spec["skills"] is None:
        raise ClientError(spec.get("skills_hint", "此客户端需要在客户端内上传 Skill。"))
    results = []
    with LOCK:
        base = spec["skills"]()
        for skill in catalog():
            folder = base / skill["id"]
            if _skill_current(folder, _installed(folder), skill):
                results.append({"id": skill["id"], "changed": False})
                continue
            files = _skill_files(skill["id"])
            backup = ""
            if folder.exists() and (folder.is_symlink() or not folder.is_dir()):
                raise ClientError(f"{folder.name} 位置不是普通文件夹，已停止安装。")
            base.parent.mkdir(parents=True, exist_ok=True)
            # SKILL-ROLLBACK: the new copy is complete before the old one moves, and a failed
            # activation puts the old one back, so the client always has a working Skill.
            # Backups and staging live NEXT TO the skills folder: clients load every subfolder
            # of it that has a SKILL.md, so a copy inside would appear as a duplicate Skill.
            staging = Path(tempfile.mkdtemp(prefix=".deepwhite-skill-staging-", dir=base.parent))
            try:
                for relative, content in files.items():
                    target = staging / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                (staging / MARKER).write_text(json.dumps({
                    "id": skill["id"], "version": skill["version"], "installed_at": int(time.time()),
                    "source": "DeepWhite Studio",
                    "sha256": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}},
                    ensure_ascii=False, indent=2), encoding="utf-8")
                base.mkdir(parents=True, exist_ok=True)
                if folder.exists():
                    backups = base.parent / "deepwhite-skill-backups"
                    backups.mkdir(parents=True, exist_ok=True)
                    backup = str(backups / f"{skill['id']}-{time.strftime('%Y%m%d-%H%M%S')}")
                    shutil.move(str(folder), backup)
                try:
                    shutil.move(str(staging), str(folder))
                except OSError as exc:
                    if folder.exists():
                        shutil.rmtree(folder, ignore_errors=True)
                    if backup:
                        shutil.move(backup, str(folder))
                        raise ClientError(f"{skill['id']} 升级失败（{exc.strerror or exc}），已恢复原来的版本；请检查目录权限或文件占用后重试。") from exc
                    raise ClientError(f"{skill['id']} 安装失败（{exc.strerror or exc}）；请检查目录权限或文件占用后重试。") from exc
            finally:
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
            results.append({"id": skill["id"], "changed": True, "version": skill["version"], "backup": backup})
    return results


def skill_zip(skill_id):
    if skill_id not in {skill["id"] for skill in catalog()}:
        raise ClientError("Skill 不存在。", 404)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative, content in _skill_files(skill_id).items():
            archive.writestr(f"{skill_id}/{relative}", content)
    return buffer.getvalue()


# ---------------------------------------------------------------- status / actions

def _codex(configuration):
    import studio_codex_setup
    return studio_codex_setup.status(configuration)


def mcp_state(client_id, configuration):
    spec = CLIENTS[client_id]
    result = {"state": "manual", "config_path": "", "message": ""}
    if spec["format"] == "manual":
        result["message"] = spec["manual_hint"]
        return result
    if spec["format"] == "codex":
        codex = _codex(configuration)
        state = {"installed": "connected", "missing": "missing", "different": "different"}.get(codex["state"], "blocked")
        return {"state": state, "config_path": codex.get("config_path", ""), "message": codex.get("message", ""),
                "revision": codex.get("revision", "")}
    path = spec["config"]()
    result["config_path"] = str(path)
    try:
        raw = _read(path)
        entry = _entry(configuration, spec["format"])
        if spec["format"] == "hermes":
            state = _yaml_state(raw, entry)
        else:
            found = _json_document(raw).get("mcpServers", {}).get(SERVER)
            state = "missing" if found is None else "connected" if _same(found, entry) else "different"
        result["state"] = state
        result["message"] = {"missing": "尚未连接。", "connected": "已连接。重启客户端后可在对话中使用画布工具。",
                             "different": "检测到旧的深白连接（可能来自旧安装位置），点击连接可更新。"}[state]
    except ClientError as exc:
        result.update(state="blocked", message=str(exc))
    except OSError:
        result.update(state="blocked", message="无法读取此客户端配置，请检查目录权限。")
    return result


def manual_config(client_id, configuration):
    spec = CLIENTS[client_id]
    entry = _entry(configuration, "claude_code" if spec["format"] == "claude_code" else "json")
    if spec["format"] == "codex":
        return {"format": "toml", "text": configuration["client_configs"]["codex_toml"]}
    if spec["format"] == "hermes":
        return {"format": "yaml", "text": "\n".join(["mcp_servers:", *_yaml_block(entry)]) + "\n"}
    return {"format": "json", "text": json.dumps({"mcpServers": {SERVER: entry}}, ensure_ascii=False, indent=2)}


def skills_path(client_id):
    spec = CLIENTS[client_id]
    return str(spec["skills"]()) if spec["skills"] else ""


# U11: "configured" and "verified" are different facts. Each client gets a one-time code; only an
# agent that really reaches this studio through MCP can report it back (verify_client).
def _verification_path():
    import main as core  # late: this module is imported by main's startup chain
    return Path(core.DATA_DIR) / "studio_client_verification.json"


def _verifications():
    try:
        value = json.loads(_verification_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_verifications(value):
    path = _verification_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def verification(client_id):
    with LOCK:
        store = _verifications()
        row = store.get(client_id)
        if not isinstance(row, dict) or not re.fullmatch(r"DW-[0-9A-F]{6}", str(row.get("code", ""))):
            row = {"code": "DW-" + secrets.token_hex(3).upper(), "verified_at": 0}
            store[client_id] = row
            _save_verifications(store)
    code = row["code"]
    return {"code": code, "verified_at": row.get("verified_at") or 0,
            "command": f"请调用 deepwhite-studio 的 verify_client 工具，参数 code 为 \"{code}\"；只读取，不要修改画布或发起生成。然后告诉我返回的画布名和节点数。"}


def reset_verification(client_id):
    with LOCK:
        store = _verifications()
        store.pop(client_id, None)
        _save_verifications(store)


def mark_verified(code):
    with LOCK:
        store = _verifications()
        for client_id, row in store.items():
            if isinstance(row, dict) and row.get("code") == code and client_id in CLIENTS:
                row["verified_at"] = int(time.time())
                _save_verifications(store)
                return client_id
    return None


def describe(client_id, configuration):
    spec = CLIENTS[client_id]
    detected = spec["marker"]().exists() if spec.get("detect", True) else False
    return {"id": client_id, "name": spec["name"], "detected": detected,
            "mcp": mcp_state(client_id, configuration), "skills": skill_rows(client_id),
            "skills_path": skills_path(client_id),
            "skills_hint": spec.get("skills_hint", ""), "restart_hint": spec.get("restart_hint", "连接或安装 Skills 后请重启该客户端。"),
            "manual": manual_config(client_id, configuration), "detectable": spec.get("detect", True),
            "verification": verification(client_id)}


def _unreadable(client_id, configuration, exc):
    # One client's broken files must not hide the others; this one stays repairable.
    spec = CLIENTS[client_id]
    reason = str(exc) if isinstance(exc, ClientError) else "无法读取此客户端的配置或 Skills，请检查文件编码与权限后点“刷新”。"
    try:
        manual = manual_config(client_id, configuration)
    except Exception:
        manual = {"format": "text", "text": ""}
    return {"id": client_id, "name": spec["name"], "detected": True, "error": reason,
            "mcp": {"state": "blocked", "config_path": "", "message": reason}, "skills": [], "skills_path": "",
            "skills_hint": spec.get("skills_hint", ""), "restart_hint": spec.get("restart_hint", ""), "manual": manual}


def listing(configuration):
    items = []
    for client_id in VISIBLE:
        try:
            items.append(describe(client_id, configuration))
        except Exception as exc:  # noqa: BLE001 - isolate per client
            items.append(_unreadable(client_id, configuration, exc))
    return {"items": items, "skills": catalog()}


def connect(client_id, configuration, remove=False):
    spec = CLIENTS[client_id]
    if spec["format"] == "manual":
        raise ClientError(spec["manual_hint"])
    if spec["format"] == "codex":
        import studio_codex_setup
        status = studio_codex_setup.status(configuration)
        try:
            return studio_codex_setup.configure(configuration, {
                "action": "remove" if remove else "install", "expected_revision": status.get("revision", ""),
                "replace_existing": True})
        except studio_codex_setup.SetupError as exc:
            raise ClientError(str(exc), exc.status_code) from None
    path = spec["config"]()
    with LOCK:
        raw = _read(path)
        entry = _entry(configuration, spec["format"])
        if spec["format"] == "hermes":
            current = _yaml_state(raw, entry)
            if (current == "connected" and not remove) or (current == "missing" and remove):
                return {"changed": False}
            encoded = _yaml_apply(raw, entry, remove)
            if _yaml_state(encoded, entry) != ("missing" if remove else "connected"):
                raise ClientError("Hermes 配置校验失败，原文件未改动。请使用手动配置。")
        else:
            document = _json_document(raw)
            servers = document.setdefault("mcpServers", {})
            if remove:
                if SERVER not in servers:
                    return {"changed": False}
                servers.pop(SERVER)
            else:
                if _same(servers.get(SERVER), entry):
                    return {"changed": False}
                servers[SERVER] = entry
            encoded = _json_encode(document, raw)
        backup = _commit(path, raw, encoded)
    return {"changed": True, "backup": backup,
            "message": ("已断开。" if remove else "已连接。") + spec.get("restart_hint", "请重启该客户端。")}
