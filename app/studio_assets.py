"""Local, versioned media assets for DeepWhite Studio.

All imported media is copied into the Studio-owned data directory. URL-based
registration only accepts files that the existing core resolver can resolve.
"""
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

import main as core


EXTENSIONS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".gif": "image", ".bmp": "image", ".tif": "image", ".tiff": "image",
    ".avif": "image", ".mp4": "video", ".mov": "video", ".webm": "video",
    ".mkv": "video", ".avi": "video", ".m4v": "video", ".mp3": "audio",
    ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".ogg": "audio",
    ".flac": "audio", ".opus": "audio",
}
ID_RE = re.compile(r"^[a-f0-9]{32}$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def root():
    path = Path(core.DATA_DIR) / "studio-assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def database():
    path = root() / "index.sqlite3"
    with sqlite3.connect(path, timeout=30) as db:
        db.row_factory = sqlite3.Row
        db.execute("""CREATE TABLE IF NOT EXISTS versions (
            version_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, project_id TEXT NOT NULL,
            name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
            sha256 TEXT NOT NULL, created_at TEXT NOT NULL, source_json TEXT NOT NULL,
            candidate_path TEXT NOT NULL, confirmed_path TEXT NOT NULL DEFAULT '',
            missing INTEGER NOT NULL DEFAULT 0, source_size INTEGER NOT NULL DEFAULT -1,
            source_mtime_ns INTEGER NOT NULL DEFAULT -1
        )""")
        columns = {r[1] for r in db.execute("PRAGMA table_info(versions)")}
        if "source_size" not in columns:
            db.execute("ALTER TABLE versions ADD COLUMN source_size INTEGER NOT NULL DEFAULT -1")
        if "source_mtime_ns" not in columns:
            db.execute("ALTER TABLE versions ADD COLUMN source_mtime_ns INTEGER NOT NULL DEFAULT -1")
        db.execute("CREATE INDEX IF NOT EXISTS idx_assets_project ON versions(project_id, status)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_assets_hash ON versions(project_id, sha256)")
        db.execute("""CREATE TABLE IF NOT EXISTS confirmations (
            version_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, name TEXT NOT NULL,
            category TEXT NOT NULL, destination TEXT NOT NULL, sha256 TEXT NOT NULL
        )""")
    return path


@contextmanager
def connect():
    path = database()
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def validate_project(project_id):
    project_id = str(project_id or "default")
    if not PROJECT_RE.fullmatch(project_id) or project_id in (".", ".."):
        raise HTTPException(400, "项目编号格式无效。")
    return project_id


def safe_name(name, fallback):
    text = Path(str(name or fallback)).name
    text = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", text).strip(" .")
    return (text or fallback)[:180]


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_copy(source, destination, expected_hash=None):
    """Copy and verify on the same volume before publishing without overwrite."""
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_hash = expected_hash or digest(source)
    fd, temp_name = tempfile.mkstemp(prefix=".asset-", suffix=".part", dir=str(destination.parent))
    os.close(fd)
    temp = Path(temp_name)
    try:
        shutil.copyfile(source, temp)
        if digest(temp) != expected_hash:
            raise OSError("媒体内容在复制期间发生变化。")
        # Hard-link creation fails if the destination already exists, avoiding races/overwrites.
        os.link(temp, destination)
        return destination
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def resolved_local(url):
    """Accept only the local output URL shapes understood by the core resolver."""
    if not isinstance(url, str) or not (url.startswith("/output/") or url.startswith("/assets/") or url.startswith("/api/storage-files/")):
        raise HTTPException(400, "仅支持导入 Studio 已登记的本地媒体文件。")
    try:
        path = core.output_file_from_url(url)
    except Exception:
        path = None
    if not path:
        raise HTTPException(404, "本地媒体文件不存在。")
    path = Path(path).resolve(strict=True)
    suffix = path.suffix.lower()
    if suffix not in EXTENSIONS or not path.is_file():
        raise HTTPException(415, "仅支持常见图片、视频和音频文件。")
    return path, EXTENSIONS[suffix]


def source_data(value):
    if not isinstance(value, dict):
        return {}
    # Keep prompts and allowed parameters for reproducibility; never copy credentials.
    allowed = {"type", "job_id", "canvas_id", "node_id", "model", "provider_id",
               "tool_id", "tool_version", "recipe_id", "recipe_version",
               "source_task_id", "filename", "prompt", "params"}
    def clean(item, depth=0):
        if depth > 5:
            return None
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                safe_key = str(key)
                if re.search(r"(?i)(key|token|secret|password|authorization|credential)", safe_key):
                    continue
                if isinstance(child, (str, int, float, bool, type(None), dict, list)):
                    result[safe_key[:120]] = clean(child, depth + 1)
            return result
        if isinstance(item, list):
            return [clean(child, depth + 1) for child in item[:300]
                    if isinstance(child, (str, int, float, bool, type(None), dict, list))]
        if isinstance(item, str):
            return item[:20000]
        return item if isinstance(item, (int, float, bool)) or item is None else None
    value = {str(k): clean(v) for k, v in value.items() if str(k) in allowed and isinstance(v, (str, int, float, bool, type(None), dict, list))}
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        raise HTTPException(400, "来源信息格式无效。")
    if len(encoded.encode("utf-8")) > 131072:
        raise HTTPException(400, "来源信息过长。")
    return value


def public(row):
    if not row:
        return None
    d = dict(row)
    return {
        "version_id": d["version_id"], "asset_id": d["asset_id"],
        "project_id": d["project_id"], "name": d["name"], "kind": d["kind"],
        "status": d["status"], "category": d["category"],
        "url": f"/api/studio/assets/{d['version_id']}/file",
        "source_url": d["source_url"], "sha256": d["sha256"],
        "created_at": d["created_at"], "source": json.loads(d["source_json"]),
        "missing": bool(d["missing"]),
    }


def _row(version_id):
    if not ID_RE.fullmatch(str(version_id)):
        raise HTTPException(404, "资产版本不存在。")
    with connect() as db:
        row = db.execute("SELECT * FROM versions WHERE version_id=?", (version_id,)).fetchone()
    if not row:
        raise HTTPException(404, "资产版本不存在。")
    return row


def file_path(version_id):
    """Return an existing managed media path for the core output resolver hook."""
    d = dict(_row(version_id))
    path = Path(d["confirmed_path"] if d["confirmed_path"] else d["candidate_path"])
    try:
        resolved = path.resolve(strict=True)
        import studio_storage
        if not studio_storage.is_managed_path(resolved, d["project_id"]):
            return None
    except (FileNotFoundError, ValueError, OSError):
        return None
    return str(resolved) if resolved.is_file() else None


def _register_path_unlocked(path, *, name="", project_id="default", source=None, source_url=""):
    project_id = validate_project(project_id)
    path = Path(path).resolve(strict=True)
    kind = EXTENSIONS.get(path.suffix.lower())
    if not kind or not path.is_file():
        raise HTTPException(415, "仅支持常见图片、视频和音频文件。")
    sha = digest(path)
    source_stat = path.stat()
    source = source_data(source)
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM versions WHERE project_id=? AND sha256=? ORDER BY created_at LIMIT 1", (project_id, sha)).fetchone()
        if existing:
            existing_data = dict(existing)
            managed = Path(existing_data["confirmed_path"] if existing_data["status"] in ("confirmed", "archived") else existing_data["candidate_path"])
            if not managed.is_file():
                try:
                    atomic_copy(path, managed, sha)
                except OSError as exc:
                    raise HTTPException(500, "无法恢复缺失的托管媒体文件。") from exc
            source_stat = path.stat()
            if not existing_data["source_url"] or existing_data["source_url"] == source_url:
                db.execute("UPDATE versions SET source_url=?,source_size=?,source_mtime_ns=?,missing=0 WHERE version_id=?",
                           (source_url or existing_data["source_url"], source_stat.st_size, source_stat.st_mtime_ns, existing_data["version_id"]))
            else:
                db.execute("UPDATE versions SET missing=0 WHERE version_id=?", (existing_data["version_id"],))
            db.commit()
            existing = db.execute("SELECT * FROM versions WHERE version_id=?", (existing_data["version_id"],)).fetchone()
            return public(existing)
        version_id = uuid.uuid4().hex
        asset_id = uuid.uuid4().hex
        clean_name = safe_name(name, path.name)
        import studio_storage
        source_type = str(source.get("type") or "")
        candidate = studio_storage.project_media_path(project_id, version_id, kind, path.suffix.lower(),
            imported=(source_type == "import"))
        try:
            atomic_copy(path, candidate, sha)
        except OSError as exc:
            raise HTTPException(500, "保存候选媒体失败，请稍后重试。") from exc
        created = datetime.now(timezone.utc).isoformat()
        try:
            db.execute("""INSERT INTO versions(version_id,asset_id,project_id,name,kind,status,source_url,sha256,
                created_at,source_json,candidate_path,source_size,source_mtime_ns) VALUES(?,?,?,?,?,'candidate',?,?,?,?,?,?,?)""",
                (version_id, asset_id, project_id, clean_name, kind, source_url, sha, created,
                 json.dumps(source, ensure_ascii=False), str(candidate), source_stat.st_size, source_stat.st_mtime_ns))
            db.commit()
        except Exception:
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass
            raise
        return public(db.execute("SELECT * FROM versions WHERE version_id=?", (version_id,)).fetchone())


def _register_path(path, *, name="", project_id="default", source=None, source_url=""):
    import studio_storage
    with studio_storage.LOCK:
        studio_storage._recover_migrations()
        return _register_path_unlocked(path, name=name, project_id=project_id, source=source, source_url=source_url)


def register_local(url, name="", project_id="default", source=None):
    match = re.fullmatch(r"/api/studio/assets/([a-f0-9]{32})/file(?:\?.*)?", str(url or ""))
    if match:
        existing = _row(match.group(1))
        if file_path(match.group(1)):
            return public(existing)
        raise HTTPException(404, "资产文件缺失，请先修复索引。")
    path, _ = resolved_local(url)
    return _register_path(path, name=name, project_id=project_id, source=source,
                          source_url=url)


def _confirmed_destination(project_id, asset_id, name, version_id, media_suffix):
    import studio_storage
    row = dict(_row(version_id))
    return studio_storage.project_media_path(
        project_id, version_id, row["kind"], media_suffix,
        confirmed=True, asset_id=asset_id, category=row.get("category"),
    )


def _confirm_unlocked(version_id, asset_id=None, category="", name=None):
    row = _row(version_id)
    d = dict(row)
    if d["status"] in ("confirmed", "archived"):
        return public(row)
    if d["status"] != "candidate":
        raise HTTPException(409, "此版本不能确认。")
    target_asset = str(asset_id or d["asset_id"])
    if not ID_RE.fullmatch(target_asset):
        raise HTTPException(400, "资产编号格式无效。")
    with connect() as db:
        owners = db.execute("SELECT DISTINCT project_id,status FROM versions WHERE asset_id=? AND version_id<>?", (target_asset, version_id)).fetchall()
    if asset_id and not owners:
        raise HTTPException(404, "所选资产不存在，请刷新资产列表。")
    if owners and any(owner["project_id"] != d["project_id"] for owner in owners):
        raise HTTPException(409, "该资产编号属于其他项目。")
    if asset_id and owners and not any(owner["status"] in ("confirmed", "archived") for owner in owners):
        raise HTTPException(409, "请选择已确认的资产。")
    display = safe_name(name or d["name"], d["name"])
    source = Path(d["candidate_path"])
    if not source.is_file():
        raise HTTPException(409, "候选文件缺失，请先修复索引或重新导入。")
    import studio_storage
    destination = studio_storage.project_media_path(d["project_id"],version_id,d["kind"],source.suffix.lower(),
        confirmed=True,asset_id=target_asset,category=category,base_root=studio_storage.project_root(d["project_id"]))
    category_value = str(category or "")[:120]
    with connect() as db:
        db.execute("INSERT OR REPLACE INTO confirmations VALUES(?,?,?,?,?,?)",
                   (version_id, target_asset, display, category_value, str(destination), d["sha256"]))
        db.commit()
    try:
        atomic_copy(source, destination, d["sha256"])
    except OSError as exc:
        with connect() as db:
            db.execute("DELETE FROM confirmations WHERE version_id=?", (version_id,))
            db.commit()
        raise HTTPException(500, "归档文件写入失败，候选版本仍可重试。") from exc
    try:
        with connect() as db:
            db.execute("UPDATE versions SET asset_id=?,name=?,category=?,status='confirmed',confirmed_path=?,missing=0 WHERE version_id=? AND status='candidate'",
                       (target_asset, display, category_value, str(destination), version_id))
            db.execute("DELETE FROM confirmations WHERE version_id=?", (version_id,))
            db.commit()
            updated = db.execute("SELECT * FROM versions WHERE version_id=?", (version_id,)).fetchone()
        return public(updated)
    except Exception:
        # Preserve candidate identity; repair can reconcile the completed copy.
        raise


def confirm(version_id, asset_id=None, category="", name=None):
    import studio_storage
    with studio_storage.LOCK:
        studio_storage._recover_migrations()
        return _confirm_unlocked(version_id,asset_id,category,name)


def archive(version_id):
    row = _row(version_id)
    if dict(row)["status"] == "archived":
        return public(row)
    if dict(row)["status"] != "confirmed":
        raise HTTPException(409, "此版本不能归档。")
    with connect() as db:
        db.execute("UPDATE versions SET status='archived' WHERE version_id=? AND status='confirmed'", (version_id,))
        db.commit()
        return public(db.execute("SELECT * FROM versions WHERE version_id=?", (version_id,)).fetchone())


def _repair_unlocked(project_id="default"):
    project_id = validate_project(project_id)
    changed = 0
    with connect() as db:
        rows = db.execute("SELECT * FROM versions WHERE project_id=?", (project_id,)).fetchall()
        for row in rows:
            d = dict(row)
            if d["status"] == "candidate":
                # A crash after the atomic project copy but before the SQLite commit.
                intent = db.execute("SELECT * FROM confirmations WHERE version_id=?", (d["version_id"],)).fetchone()
                if intent:
                    intended = Path(intent["destination"])
                    if intended.is_file() and digest(intended) == intent["sha256"]:
                        db.execute("UPDATE versions SET asset_id=?,name=?,category=?,status='confirmed',confirmed_path=?,missing=0 WHERE version_id=?",
                                   (intent["asset_id"], intent["name"], intent["category"], str(intended), d["version_id"]))
                        changed += 1
                        db.execute("DELETE FROM confirmations WHERE version_id=?", (d["version_id"],))
                        continue
                    db.execute("DELETE FROM confirmations WHERE version_id=?", (d["version_id"],))
                    changed += 1
            current = Path(d["confirmed_path"] if d["status"] in ("confirmed", "archived") else d["candidate_path"])
            missing = not current.is_file()
            if bool(d["missing"]) != missing:
                db.execute("UPDATE versions SET missing=? WHERE version_id=?", (int(missing), d["version_id"]))
                changed += 1
        db.commit()
        items = [public(r) for r in db.execute("SELECT * FROM versions WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()]
    return {"items": items, "changed": changed}


def repair(project_id="default"):
    import studio_storage
    with studio_storage.LOCK:
        studio_storage._recover_migrations()
        return _repair_unlocked(project_id)


def enrich_canvas(canvas):
    """Register local media referenced by a canvas and add stable per-node refs."""
    if not isinstance(canvas, dict):
        return canvas
    project = canvas.get("project_id") or canvas.get("project") or "default"
    if isinstance(project, dict):
        project = project.get("id") or project.get("project_id") or "default"
    project_id = validate_project(project)
    indexed_by_source = {}
    indexed_signatures = {}
    with connect() as db:
        rows = db.execute("SELECT * FROM versions WHERE missing=0 AND project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()
        for row in rows:
            d = dict(row)
            if d["source_url"]:
                try:
                    source_path, _ = resolved_local(d["source_url"])
                    stat = source_path.stat()
                    recorded_signature = (d["source_size"], d["source_mtime_ns"])
                    if recorded_signature == (stat.st_size, stat.st_mtime_ns) and d["source_url"] not in indexed_by_source:
                        indexed_by_source[d["source_url"]] = public(row)
                        indexed_signatures[d["source_url"]] = recorded_signature
                except (HTTPException, OSError):
                    pass
            for stored in (d["candidate_path"], d["confirmed_path"]):
                if stored and Path(stored).is_file():
                    indexed_by_source["path:" + str(Path(stored).resolve())] = public(row)

    media_keys = {"url", "src", "file", "video_url", "audio_url", "image_url"}
    all_sources = set()
    def media_urls(node):
        found = []
        def collect(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == "studioAssetRefs":
                        continue
                    if str(key).lower() in media_keys and isinstance(child, str):
                        found.append(child)
                    elif str(key).lower() in {"images", "videos", "audios", "media", "outputs"} and isinstance(child, list):
                        for entry in child:
                            if isinstance(entry, str):
                                found.append(entry)
                            elif isinstance(entry, (dict, list)):
                                collect(entry)
                    elif isinstance(child, (dict, list)):
                        collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)
        collect(node)
        return list(dict.fromkeys(found))

    def enrich_node(node, node_id):
        if not isinstance(node, dict):
            return
        urls = media_urls(node)
        all_sources.update(urls)
        old_refs = node.get("studioAssetRefs")
        if not isinstance(old_refs, list):
            old_refs = []
        refs = [r for r in old_refs if isinstance(r, dict) and
                (r.get('source_url') or r.get('url')) in urls]
        seen = {(r.get("version_id"), r.get("source_url")) for r in refs if isinstance(r, dict)}
        valid_local_sources = set()
        for url in urls:
            owned = re.fullmatch(r"/api/studio/assets/([a-f0-9]{32})/file(?:\?.*)?", url)
            if owned:
                try:
                    existing = register_local(url, project_id=project_id)
                except HTTPException:
                    continue
                path = Path(file_path(existing["version_id"])) if file_path(existing["version_id"]) else None
            else:
                try:
                    path, _ = resolved_local(url)
                except HTTPException:
                    continue
                valid_local_sources.add(url)
                stat = path.stat()
                signature = (stat.st_size, stat.st_mtime_ns)
                existing = indexed_by_source.get(url) if indexed_signatures.get(url) == signature else None
                if existing is None:
                    existing = indexed_by_source.get("path:" + str(path))
            if not existing:
                try:
                    existing = register_local(url, project_id=project_id,
                        source={"type": "canvas", "canvas_id": str(canvas.get("id") or canvas.get("canvas_id") or ""), "node_id": node_id})
                except HTTPException:
                    continue
                indexed_by_source[url] = existing
                if path:
                    indexed_by_source["path:" + str(path)] = existing
                    stat = path.stat()
                    indexed_signatures[url] = (stat.st_size, stat.st_mtime_ns)
            elif not owned:
                indexed_by_source[url] = existing
                indexed_signatures[url] = (path.stat().st_size, path.stat().st_mtime_ns)
            # A source replaced at the same URL points to a new immutable version.
            refs = [r for r in refs if (r.get('source_url') or r.get('url')) != url]
            seen = {(r.get("version_id"), r.get("source_url")) for r in refs if isinstance(r, dict)}
            ref_key = (existing["version_id"], url)
            if ref_key not in seen:
                refs.append({"version_id": existing["version_id"], "asset_id": existing["asset_id"],
                             "project_id": existing["project_id"], "url": existing["url"], "source_url": url})
                seen.add(ref_key)
        if refs or "studioAssetRefs" in node:
            node["studioAssetRefs"] = refs

    # Canvas nodes carry refs locally; don't treat canvas metadata as a media node.
    nodes = canvas.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict):
                enrich_node(node, str(node.get("id") or node.get("node_id") or ""))
    refs = []
    canvas["studioAssetRefs"] = refs
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        for ref in node.get("studioAssetRefs", []):
            if isinstance(ref, dict) and not any(isinstance(old, dict) and old.get("version_id") == ref.get("version_id") and old.get("source_url") == ref.get("source_url") for old in refs):
                refs.append(ref)
    return canvas


def install(core_module=None):
    core_module = core_module or core
    app = core_module.app
    database()

    @app.post("/api/studio/assets/register")
    async def register(payload: dict):
        item = register_local(payload.get("url", ""), payload.get("name", ""),
                              payload.get("project_id", "default"), payload.get("source", {}))
        return {"item": item}

    @app.get("/api/studio/assets")
    async def listing(project_id: str = "default", status: str = "", q: str = ""):
        project_id = validate_project(project_id)
        if status and status not in ("candidate", "confirmed", "archived"):
            raise HTTPException(400, "资产状态无效。")
        with connect() as db:
            sql = "SELECT * FROM versions WHERE project_id=?"
            args = [project_id]
            if status:
                sql += " AND status=?"; args.append(status)
            if q:
                sql += " AND (name LIKE ? OR category LIKE ? OR sha256 LIKE ?)"
                args.extend([f"%{q[:120]}%"] * 3)
            sql += " ORDER BY created_at DESC"
            return {"items": [public(r) for r in db.execute(sql, args).fetchall()]}

    @app.post("/api/studio/assets/{version_id}/confirm")
    async def confirm_route(version_id: str, payload: dict):
        return {"item": confirm(version_id, payload.get("asset_id"), payload.get("category", ""), payload.get("name"))}

    @app.post("/api/studio/assets/{version_id}/archive")
    async def archive_route(version_id: str):
        return {"item": archive(version_id)}

    @app.get("/api/studio/assets/{version_id}/file")
    async def file_route(version_id: str):
        row = dict(_row(version_id))
        path = Path(row["confirmed_path"] if row["status"] in ("confirmed", "archived") else row["candidate_path"])
        if not path.is_file():
            raise HTTPException(404, "资产文件缺失，请先修复索引。")
        return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream")

    @app.post("/api/studio/assets/{version_id}/open-folder")
    async def open_folder(version_id: str):
        if sys.platform != "win32":
            raise HTTPException(501, "打开文件夹仅支持 Windows。")
        row = dict(_row(version_id))
        path = Path(row["confirmed_path"] if row["status"] in ("confirmed", "archived") and row["confirmed_path"] else row["candidate_path"]).parent
        path.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(path))
        except OSError as exc:
            raise HTTPException(500, "无法打开资产文件夹。") from exc
        return {"ok": True}

    @app.post("/api/studio/assets/import")
    async def import_file(request: Request):
        form = await request.form()
        upload = form.get("file")
        if not upload or not getattr(upload, "filename", ""):
            raise HTTPException(400, "请选择一个媒体文件。")
        project_id = validate_project(form.get("project_id", "default"))
        filename = safe_name(upload.filename, "import")
        suffix = Path(filename).suffix.lower()
        if suffix not in EXTENSIONS:
            raise HTTPException(415, "仅支持常见图片、视频和音频文件。")
        incoming = root() / "incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        temp = incoming / f"{uuid.uuid4().hex}{suffix}"
        total = 0
        try:
            with temp.open("wb") as output:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 1024 * 1024 * 1024:
                        raise HTTPException(413, "单个媒体文件不能超过 1 GB。")
                    output.write(chunk)
            if not total:
                raise HTTPException(400, "不能导入空文件。")
            item = _register_path(temp, name=filename, project_id=project_id,
                                  source={"type": "import", "filename": filename})
            return {"item": item}
        finally:
            try:
                temp.unlink()
            except FileNotFoundError:
                pass

    @app.post("/api/studio/assets/repair")
    async def repair_route(payload: dict):
        return repair(payload.get("project_id", "default"))
