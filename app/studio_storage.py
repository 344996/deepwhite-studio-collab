"""User-selectable, project-aware storage for registered Studio media.

Media references remain version IDs and stable /api/studio/assets URLs. Changing
roots copies managed files and updates registered paths only after verification;
old copies are retained for rollback and for legacy /output URLs.
"""
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import asyncio
import base64
import subprocess
from pathlib import Path

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

import main as core


LOCK = threading.RLock()
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def _legacy_root():
    import studio_assets
    return Path(studio_assets.root()).resolve()


def config_path():
    return Path(core.DATA_DIR) / "studio_storage.json"


def validate_project_id(value):
    project_id = str(value or "default")
    if not PROJECT_ID_RE.fullmatch(project_id) or project_id in (".", ".."):
        raise HTTPException(400, "项目编号格式无效。")
    return project_id


def _normalize_path(value):
    text = os.path.expanduser(os.path.expandvars(str(value or "").strip()))
    if not text:
        raise HTTPException(400, "请填写一个本机绝对文件夹路径。")
    path = Path(text)
    if not path.is_absolute():
        raise HTTPException(400, "存储目录必须使用本机绝对路径。")
    try:
        return path.resolve()
    except (OSError, RuntimeError) as exc:
        raise HTTPException(400, f"无法解析存储目录：{exc}") from exc


def _is_within(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _overlaps(left, right):
    left, right = Path(left).resolve(), Path(right).resolve()
    return _is_within(left, right) or _is_within(right, left)


def validate_root(value, *, configured_paths=()):
    path = _normalize_path(value)
    # Never let user-selected project media roots point into or contain the app,
    # runtime database, or the old shared media roots.
    protected = [str(Path(__file__).resolve().parent),getattr(core, "BASE_DIR", ""), getattr(core, "RUNTIME_DIR", ""),
                 getattr(core, "DATA_DIR", ""), getattr(core, "OUTPUT_DIR", ""),
                 getattr(core, "ASSETS_DIR", "")]
    for protected_path in filter(None, protected):
        if _overlaps(path, protected_path):
            raise HTTPException(400, "存储目录不能位于程序、运行数据或旧媒体目录中，也不能包含这些目录。")
    if len(path.parts) < 2:
        raise HTTPException(400, "不能把磁盘根目录直接设为项目存储目录。")
    for other in configured_paths:
        if other and _overlaps(path, other):
            raise HTTPException(409, "此目录与另一个已配置项目目录重叠，请选择独立文件夹。")
    return path


def _read_config():
    path = config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            return {"default_root": str(_legacy_root()), "projects": {}}
        default = str(data.get("default_root") or _legacy_root())
        projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
        return {"default_root": default, "projects": {str(k): str(v) for k, v in projects.items() if v}}
    except FileNotFoundError:
        return {"default_root": str(_legacy_root()), "projects": {}}
    except (OSError, ValueError):
        raise HTTPException(500, "存储设置文件无法读取。请先恢复该文件，再更改存储目录。")


def _journal_table(db):
    db.execute("CREATE TABLE IF NOT EXISTS storage_migrations (project_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, old_paths_json TEXT NOT NULL)")


def _recover_migrations():
    with LOCK:
        try:
            import studio_assets
            with studio_assets.connect() as db:
                _journal_table(db)
                pending=[dict(row) for row in db.execute("SELECT * FROM storage_migrations").fetchall()]
        except (sqlite3.Error, OSError):
            return
        for entry in pending:
            config=json.loads(entry["config_json"])
            _write_config(config)
            with studio_assets.connect() as db:
                db.execute("DELETE FROM storage_migrations WHERE project_id=?",(entry["project_id"],))
                db.commit()


def _write_config(data):
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="studio_storage.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        raise HTTPException(507, f"无法保存存储配置：{exc}") from exc
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _assert_writable(path):
    path = Path(path)
    try:
        path.mkdir(parents=True, exist_ok=True)
        fd, probe = tempfile.mkstemp(prefix=".deepwhite-write-check-", dir=str(path))
        os.close(fd)
        os.unlink(probe)
    except OSError as exc:
        raise HTTPException(507, f"存储目录不可写或磁盘空间不足：{path}（{exc}）") from exc


def project_root(project_id, *, config=None):
    project_id = validate_project_id(project_id)
    with LOCK:
        config = config or _read_config()
        override = (config.get("projects") or {}).get(project_id)
        return Path(override or (Path(config["default_root"]) / project_id)).resolve()


def is_managed_path(path, project_id=None):
    try:
        candidate=Path(path).resolve(strict=True)
        if not candidate.is_file():return False
        if _is_within(candidate,_legacy_root()):return True
        if project_id is not None and _is_within(candidate,project_root(project_id)):return True
        config=_read_config()
        if _is_within(candidate,config["default_root"]):return True
        return any(_is_within(candidate,value) for value in (config.get("projects") or {}).values())
    except (OSError,RuntimeError,HTTPException,ValueError):
        return False


def project_media_path(project_id, version_id, kind, suffix, *, imported=False, confirmed=False,
                       asset_id="", category="", base_root=None):
    project_id = validate_project_id(project_id)
    kind_dir = {"image": "图片", "video": "视频", "audio": "音频"}.get(kind)
    if not kind_dir:
        raise HTTPException(415, "不支持的媒体类型。")
    base = Path(base_root).resolve() if base_root else project_root(project_id)
    version_file = f"{version_id}{suffix.lower()}"
    if confirmed:
        category_dir = str(category or "未分类")
        category_dir = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", category_dir).strip(" .")[:80] or "未分类"
        return base / "projects" / f"正式资产-{category_dir}" / asset_id / version_file
    bucket = "导入素材" if imported else "候选素材"
    return base / bucket / kind_dir / version_file


def _project_ids_and_names(assets_module):
    names = {}
    try:
        for project in core.load_projects():
            names[str(project.get("id"))] = str(project.get("name") or "未命名项目")
    except Exception:
        pass
    ids = set(names)
    try:
        with assets_module.connect() as db:
            ids.update(row[0] for row in db.execute("SELECT DISTINCT project_id FROM versions"))
    except (sqlite3.Error, OSError):
        pass
    ids.add("default")
    names.setdefault("default", "默认项目")
    return ids, names


def _assert_no_active_jobs(project_id):
    try:
        import studio_generation
        for path in studio_generation.directory().glob("*.json"):
            try:
                job=json.loads(path.read_text(encoding="utf-8"))
                status=str(job.get("status") or "").lower()
                if status in {"succeeded","failed","uncertain","cancelled","complete","completed"}:
                    continue
                canvas_id=(job.get("request") or {}).get("canvas_id") or ""
                if canvas_id:
                    canvas=core.load_canvas(canvas_id)
                    owner=str(canvas.get("project") or "default")
                    if owner==project_id:
                        raise HTTPException(409,"项目仍有生成任务运行或等待中，请完成或失败后再迁移存储目录。")
            except HTTPException:
                raise
            except Exception:
                continue
    except ImportError:
        return


def settings_response(assets_module=None):
    import studio_assets
    assets_module = assets_module or studio_assets
    with LOCK:
        _recover_migrations()
        config = _read_config()
        ids, names = _project_ids_and_names(assets_module)
        projects = []
        for project_id in sorted(ids, key=lambda value: (value != "default", value)):
            count = 0
            try:
                with assets_module.connect() as db:
                    count = int(db.execute("SELECT COUNT(*) FROM versions WHERE project_id=?", (project_id,)).fetchone()[0])
            except sqlite3.Error:
                pass
            override = (config.get("projects") or {}).get(project_id)
            path = project_root(project_id, config=config)
            projects.append({"project_id": project_id, "name": names.get(project_id, project_id),
                             "path": str(path), "uses_default": not bool(override),
                             "managed_versions": count, "exists": path.exists()})
        return {"default_root": config["default_root"], "legacy_root": str(_legacy_root()), "projects": projects}


def _copy_verify(source, destination, expected_hash):
    import studio_assets
    source, destination = Path(source), Path(destination)
    if not source.is_file():
        raise HTTPException(409, f"迁移中止：托管文件缺失，旧路径保持不变（{source.name}）。请先修复资产索引。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        try:
            if studio_assets.digest(destination) == expected_hash:
                return False
        except OSError:
            pass
        raise HTTPException(409, f"迁移目标已存在不同内容，旧文件保持不变：{destination}")
    try:
        studio_assets.atomic_copy(source, destination, expected_hash)
        if studio_assets.digest(destination) != expected_hash:
            raise OSError("目标文件校验失败")
        return True
    except OSError as exc:
        raise HTTPException(507, f"迁移复制或校验失败，旧文件和引用保持不变：{exc}") from exc


def migrate_project(project_id, target_root, config_after=None):
    """Copy every registered candidate/formal version, then atomically switch DB paths."""
    import studio_assets
    project_id = validate_project_id(project_id)
    target_root = Path(target_root).resolve()
    with LOCK:
        # Recover before opening a write transaction: assets helpers may call
        # project_root while their SQLite connection already owns the writer lock.
        _recover_migrations()
        with studio_assets.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM versions WHERE project_id=? ORDER BY created_at", (project_id,)).fetchall()]
        jobs = []
        needed = 0
        for row in rows:
            source_type = (json.loads(row.get("source_json") or "{}") or {}).get("type")
            suffix = Path(row.get("confirmed_path") or row["candidate_path"]).suffix.lower()
            if not is_managed_path(row["candidate_path"],project_id):
                raise HTTPException(409,"迁移中止：数据库中的候选文件不在受管存储目录，旧引用保持不变。")
            if row.get("confirmed_path") and not is_managed_path(row["confirmed_path"],project_id):
                raise HTTPException(409,"迁移中止：数据库中的正式文件不在受管存储目录，旧引用保持不变。")
            candidate = project_media_path(project_id,row["version_id"],row["kind"],suffix,
                imported=(source_type == "import"),base_root=target_root)
            confirmed = ""
            if row.get("confirmed_path"):
                confirmed = str(project_media_path(project_id,row["version_id"],row["kind"],suffix,
                    confirmed=True,asset_id=row["asset_id"],category=row.get("category"),base_root=target_root))
            candidate_source = Path(row["candidate_path"])
            confirmed_source = Path(row["confirmed_path"]) if row.get("confirmed_path") else None
            if candidate_source.is_file(): needed += candidate_source.stat().st_size
            else: raise HTTPException(409, f"迁移中止：候选媒体缺失（{row['name']}），旧位置保持不变。")
            if confirmed_source:
                if not confirmed_source.is_file(): raise HTTPException(409, f"迁移中止：正式媒体缺失（{row['name']}），旧位置保持不变。")
                needed += confirmed_source.stat().st_size
            jobs.append((row,candidate,confirmed,candidate_source,confirmed_source))
        try:
            free = shutil.disk_usage(target_root.anchor or target_root.parent).free
        except OSError:
            free = None
        if free is not None and free < needed:
            raise HTTPException(507, f"目标磁盘空间不足：需要约 {needed} 字节，可用 {free} 字节。旧文件和引用保持不变。")
        created = []
        updates = []
        old_paths = [(row["candidate_path"],row.get("confirmed_path") or "",row["version_id"]) for row in rows]
        next_config=config_after or _read_config()
        next_config={"default_root":next_config["default_root"],"projects":dict(next_config.get("projects") or {})}
        if config_after is None:
            next_config["projects"][project_id]=str(target_root)
        try:
            for row,candidate,confirmed,candidate_source,confirmed_source in jobs:
                if str(candidate_source.resolve()) != str(candidate.resolve()):
                    if _copy_verify(candidate_source,candidate,row["sha256"]): created.append(candidate)
                if confirmed_source and str(confirmed_source.resolve()) != str(Path(confirmed).resolve()):
                    if _copy_verify(confirmed_source,confirmed,row["sha256"]): created.append(Path(confirmed))
                updates.append((str(candidate),confirmed,row["version_id"]))
            with studio_assets.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                _journal_table(db)
                db.executemany("UPDATE versions SET candidate_path=?,confirmed_path=? WHERE version_id=?",updates)
                db.execute("INSERT OR REPLACE INTO storage_migrations(project_id,config_json,old_paths_json) VALUES(?,?,?)",
                    (project_id,json.dumps(next_config,ensure_ascii=False),json.dumps(old_paths,ensure_ascii=False)))
                db.commit()
        except Exception:
            for path in reversed(created):
                try: path.unlink()
                except OSError: pass
            raise
        try:
            _write_config(next_config)
        except Exception:
            # The SQLite path switch and its recovery record share one transaction.
            # If the config cannot be atomically saved, restore the old references;
            # verified copies may remain as harmless, unreferenced rollback files.
            with studio_assets.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                db.executemany("UPDATE versions SET candidate_path=?,confirmed_path=? WHERE version_id=?",old_paths)
                db.execute("DELETE FROM storage_migrations WHERE project_id=?",(project_id,))
                db.commit()
            raise
        with studio_assets.connect() as db:
            db.execute("DELETE FROM storage_migrations WHERE project_id=?",(project_id,))
            db.commit()
        return {"project_id":project_id,"copied_versions":len(rows),"copied_files":sum(1 + bool(job[4]) for job in jobs),
                "bytes":needed,"old_files_retained":True,"path":str(target_root)}


def _pick_folder(initial=None):
    if os.name == 'nt':
        # The bundled Python has no Tk. Use Windows' native dialog with a fixed
        # script; the user-provided path is an environment value, never code.
        script = """[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 DeepWhite 项目存储文件夹'
$dialog.ShowNewFolderButton = $true
if ([System.IO.Directory]::Exists($env:DEEPWHITE_PICK_INITIAL)) { $dialog.SelectedPath = $env:DEEPWHITE_PICK_INITIAL }
try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } }
finally { $dialog.Dispose(); $owner.Dispose() }
"""
        executable=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
        try:
            result=subprocess.run([str(executable),'-NoProfile','-STA','-EncodedCommand',
                base64.b64encode(script.encode('utf-16le')).decode('ascii')],shell=False,
            env={**os.environ,'DEEPWHITE_PICK_INITIAL':str(initial or Path.home())},
                capture_output=True,encoding='utf-8',errors='replace',timeout=115)
        except (OSError,subprocess.TimeoutExpired) as exc:
            raise HTTPException(503,'文件夹选择窗口未完成，请关闭旧窗口后重试，或直接填写路径。') from exc
        if result.returncode:
            raise HTTPException(503,'无法打开系统文件夹选择器，请直接填写本机绝对路径。')
        selected=result.stdout.strip()
        return str(_normalize_path(selected)) if selected else ''
    try:
        import tkinter
        from tkinter import filedialog
        window = tkinter.Tk()
        window.withdraw()
        try:
            window.attributes("-topmost", True)
            chosen = filedialog.askdirectory(title="选择 DeepWhite 项目存储文件夹", initialdir=str(initial or Path.home()), mustexist=False)
        finally:
            window.destroy()
    except Exception as exc:
        raise HTTPException(501, f"系统文件夹选择器不可用，请改为输入本机绝对路径：{exc}") from exc
    if not chosen:
        return ''
    selected = _normalize_path(chosen)
    _assert_writable(selected)
    return str(selected)


def install(core_module=None):
    core_module = core_module or core
    app = core_module.app
    import studio_assets
    studio_assets.database()
    _recover_migrations()

    @app.get("/api/studio/storage")
    def get_storage():
        _recover_migrations()
        return settings_response(studio_assets)

    @app.put("/api/studio/storage")
    def set_default_storage(payload: dict):
        with LOCK:
            _recover_migrations()
            config = _read_config()
            path = _normalize_path(payload.get("default_root"))
            if path == Path(config["default_root"]).resolve():
                return settings_response(studio_assets)
            ids,_=_project_ids_and_names(studio_assets)
            protected_projects=[project_root(pid,config=config) for pid in ids]
            path = validate_root(path,configured_paths=protected_projects)
        _assert_writable(path)
        with LOCK:
            _recover_migrations()
            config = _read_config()
            old_default = Path(config["default_root"]).resolve()
            ids, _ = _project_ids_and_names(studio_assets)
            if path == old_default:
                return settings_response(studio_assets)
            validate_root(path,configured_paths=[project_root(pid,config=config) for pid in ids])
            projects = dict(config.get("projects") or {})
            # A global default affects only projects created after this change.
            for project_id in ids:
                projects.setdefault(project_id,str((old_default / project_id).resolve()))
            config.update(default_root=str(path),projects=projects)
            _write_config(config)
        return settings_response(studio_assets)

    @app.put("/api/studio/storage/projects/{project_id}")
    def set_project_storage(project_id: str, payload: dict):
        project_id = validate_project_id(project_id)
        chosen = payload.get("path")
        with LOCK:
            _recover_migrations()
            config = _read_config()
            if not chosen:
                with studio_assets.connect() as db:
                    count=int(db.execute("SELECT COUNT(*) FROM versions WHERE project_id=?",(project_id,)).fetchone()[0])
                if payload.get("migrate"):
                    path=Path(config["default_root"]) / project_id
                    _assert_no_active_jobs(project_id)
                    desired=dict(config);desired["projects"]=dict(config.get("projects") or {});desired["projects"].pop(project_id,None)
                    _assert_writable(path)
                    migrate_project(project_id,path,config_after=desired)
                    return settings_response(studio_assets)
                if count:
                    raise HTTPException(409,"该项目已有资产。请勾选迁移到默认目录，或指定新的项目目录。")
                config.setdefault("projects",{}).pop(project_id,None)
                _write_config(config)
                return settings_response(studio_assets)
            ids,_=_project_ids_and_names(studio_assets)
            blocked=[project_root(pid,config=config) for pid in ids if pid!=project_id]
            blocked.extend(path for pid,path in (config.get("projects") or {}).items() if pid not in ids and pid!=project_id)
            current=project_root(project_id,config=config)
            if _normalize_path(chosen)==current:
                return settings_response(studio_assets)
            path = validate_root(chosen,configured_paths=blocked)
            _assert_writable(path)
            if payload.get("migrate"):
                _assert_no_active_jobs(project_id)
                desired=dict(config);desired["projects"]=dict(config.get("projects") or {});desired["projects"][project_id]=str(path)
                migrate_project(project_id,path,config_after=desired)
                return settings_response(studio_assets)
            with studio_assets.connect() as db:
                if db.execute('SELECT 1 FROM versions WHERE project_id=? LIMIT 1',(project_id,)).fetchone():
                    raise HTTPException(409,'该项目已有素材，请使用迁移功能更改保存位置。')
            config.setdefault("projects",{})[project_id]=str(path)
            _write_config(config)
        return settings_response(studio_assets)

    @app.post("/api/studio/storage/pick-folder")
    async def pick_storage_folder(payload: dict = None):
        payload=payload or {}
        # Keep the native dialog process visible and let its own bounded timeout
        # end the request; cancelling an asyncio wrapper would leave the dialog
        # thread running after the browser had already reported failure.
        selected=await run_in_threadpool(_pick_folder, payload.get("path") or payload.get("initial"))
        return {"path":selected}

    @app.post("/api/studio/storage/projects/{project_id}/open")
    def open_project_storage(project_id: str):
        project_id=validate_project_id(project_id)
        _recover_migrations()
        if os.name != "nt":
            raise HTTPException(501,"打开本机文件夹仅支持 Windows。")
        path=project_root(project_id)
        _assert_writable(path)
        try:
            os.startfile(str(path))
        except OSError as exc:
            raise HTTPException(500,f"无法打开项目存储目录：{exc}") from exc
        return {"ok":True,"path":str(path)}
