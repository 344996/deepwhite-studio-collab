"""Writable legacy workflows over read-only packaged and older custom files."""
import json
import os
from pathlib import Path
import re
import tempfile
import threading

NAME = re.compile(r"(?:(?:custom|自定义)/)?[a-zA-Z0-9_一-龥.\-]+\.json\Z")
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)-studio\.(\d+)\Z")
LOCK = threading.RLock()


class WorkflowStorageError(ValueError):
    pass


def _plain(path):
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise WorkflowStorageError("工作流目录包含链接，请保留原文件并检查存储位置。")


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".workflow-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class WorkflowStore:
    def __init__(self, data, bundled, install_root=None):
        self.data = Path(data)
        self.user = self.data / "legacy-workflows"
        self.bundled = Path(bundled)
        self.install_root = Path(install_root) if install_root else None
        self.hidden_path = self.data / "legacy-workflows-hidden.json"

    def _path(self, root, name):
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise WorkflowStorageError("工作流名称不合法。")
        path = root.joinpath(*name.split("/"))
        for ancestor in reversed((path, *path.parents)):
            _plain(ancestor)
        if not path.resolve().is_relative_to(root.resolve()):
            raise WorkflowStorageError("工作流路径超出存储目录。")
        return path

    def _hidden(self):
        _plain(self.hidden_path)
        if not self.hidden_path.exists():
            return set()
        try:
            value = json.loads(self.hidden_path.read_text(encoding="utf-8"))
            if not isinstance(value, list) or any(not isinstance(x, str) or not NAME.fullmatch(x) for x in value):
                raise ValueError()
            return {x.casefold() for x in value}
        except (OSError, ValueError):
            raise WorkflowStorageError("工作流隐藏记录无法读取，原文件已保留。") from None

    def _roots(self):
        yield self.user, False
        yield self.bundled, False
        if not self.install_root:
            return
        versions = self.install_root / "versions"
        if not self.bundled.resolve().is_relative_to(versions.resolve()) or not versions.is_dir():
            return
        _plain(versions)
        candidates = []
        for release in versions.iterdir():
            matched = VERSION.fullmatch(release.name)
            if matched and release.is_dir():
                candidates.append((tuple(map(int, matched.groups())), release))
        for _, release in sorted(candidates, reverse=True):
            root = release / "app" / "workflows"
            if root != self.bundled:
                _plain(release)
                yield root, True

    def read_path(self, name):
        self._path(self.user, name)
        if name.casefold() in self._hidden():
            raise FileNotFoundError(name)
        for root, custom_only in self._roots():
            if custom_only and "/" not in name:
                continue
            path = self._path(root, name)
            if path.is_file():
                return path
        raise FileNotFoundError(name)

    def config_path(self, name):
        source = self.read_path(name)
        user = self._path(self.user, name).with_suffix(".config.json")
        _plain(user)
        if user.is_file():
            return user
        default = source.with_suffix(".config.json")
        _plain(default)
        return default

    def names(self):
        names = {}
        hidden = self._hidden()
        for root, custom_only in self._roots():
            _plain(root)
            folders = [root / "custom", root / "自定义"]
            if not custom_only:
                folders.insert(0, root)
            for folder in folders:
                _plain(folder)
                if not folder.is_dir():
                    continue
                for path in folder.glob("*.json"):
                    name = path.relative_to(root).as_posix()
                    key = name.casefold()
                    if NAME.fullmatch(name) and not name.endswith(".config.json") and key not in hidden:
                        self._path(root, name)
                        if path.is_file():
                            names.setdefault(key, name)
        return sorted(names.values())

    def write_workflow(self, name, value):
        with LOCK:
            hidden = self._hidden()
            _write(self._path(self.user, name), value)
            if name.casefold() in hidden:
                hidden.remove(name.casefold())
                _write(self.hidden_path, sorted(hidden))

    def write_config(self, name, value):
        with LOCK:
            self.read_path(name)
            path = self._path(self.user, name).with_suffix(".config.json")
            _plain(path)
            _write(path, value)

    def delete(self, name):
        with LOCK:
            self.read_path(name)
            hidden = self._hidden()
            hidden.add(name.casefold())
            _write(self.hidden_path, sorted(hidden))
            path = self._path(self.user, name)
            config = path.with_suffix(".config.json")
            _plain(config)
            path.unlink(missing_ok=True)
            config.unlink(missing_ok=True)
