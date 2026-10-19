"""Loopback-only update API. Installation is performed by the portable supervisor."""
import asyncio
import os
from pathlib import Path
import threading
import time
from typing import Literal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
import psutil
from pydantic import BaseModel, ConfigDict

import studio_update_engine as engine
from studio_update_core import UpdateError, atomic_json, read_json

_lock=threading.Lock()
_worker=None
_active=0


def managed_root(core):
    value=os.getenv('DEEPWHITE_INSTALL_ROOT')
    if not value: return None
    root=Path(value).resolve()
    _, release, runtime, _, _=engine.layout(root)
    if release/'app' != Path(core.BASE_DIR).resolve() or runtime != Path(core.RUNTIME_DIR).resolve():
        raise UpdateError('服务路径与发行包安装目录不匹配。')
    return root


def status(core):
    current=(Path(core.BASE_DIR)/'VERSION').read_text(encoding='utf-8').strip()
    root=managed_root(core)
    if root is None:
        return {'managed':False,'phase':'source','current_version':current,'latest_version':None,
                'has_update':False,'update_available':False,'can_install':False,'can_rollback':False,
                'message':'当前为源码运行版。请通过 Git 更新；自动下载安装需要 Windows 独立发行包。'}
    path=root/'updates'/'state.json'
    result=read_json(path) if path.exists() else {'phase':'unchecked'}
    latest=result.get('latest_version')
    result.update(managed=True,current_version=current,has_update=bool(latest and latest!=current),
                  update_available=bool(latest and latest!=current),can_install=result['phase']=='ready',
                  can_rollback=(root/'updates'/'previous.json').exists(),
                  maintenance=(root/'updates'/'maintenance.json').exists(),data_schema=1)
    return result


def _origin(request):
    origin=request.headers.get('origin','').rstrip('/')
    expected=f'{request.url.scheme}://{request.url.netloc}'
    if origin!=expected or request.headers.get('sec-fetch-site') in ('cross-site','none'):
        raise HTTPException(403,'请从本机更新页面操作。')


def _root(core):
    try: root=managed_root(core)
    except UpdateError as exc: raise HTTPException(409,str(exc)) from exc
    if root is None: raise HTTPException(409,'源码运行版不能替换程序文件，请使用 Windows 发行包。')
    return root


def _supervisor(root):
    try:
        info=read_json(root/'updates'/'supervisor.json')
        process=psutil.Process(info['pid'])
        argv=process.cmdline()
        if abs(process.create_time()-info['created'])>.001 or '--root' not in argv or '--serve' in argv:
            raise ValueError()
        if Path(argv[argv.index('--root')+1]).resolve()!=root: raise ValueError()
    except (UpdateError,psutil.Error,ValueError,KeyError,IndexError) as exc:
        raise HTTPException(409,'请使用发行包的 Start.cmd 启动画布，再安装更新。') from exc


def install(app, core):
    @app.middleware('http')
    async def update_maintenance(request: Request, call_next):
        global _active
        root=os.getenv('DEEPWHITE_INSTALL_ROOT')
        api=request.url.path.startswith('/api/')
        allowed=request.url.path in ('/api/studio/health','/api/studio/updates/status')
        if root and (Path(root)/'updates'/'maintenance.json').exists() and api and not allowed:
            return JSONResponse({'detail':'正在更新，画布暂时只读。完成后请重新打开。'},status_code=503,headers={'Retry-After':'3'})
        counted=api and not request.url.path.startswith('/api/studio/updates/') and not allowed
        if counted: _active+=1
        try: return await call_next(request)
        finally:
            if counted: _active-=1

    @app.get('/updates')
    def page(): return core.static_html_response('studio-updates.html')

    @app.get('/api/studio/updates/status')
    def get_status():
        try: return status(core)
        except UpdateError as exc: raise HTTPException(409,str(exc)) from exc

    @app.post('/api/studio/updates/check')
    async def check(request:Request):
        _origin(request); root=_root(core)
        if not _lock.acquire(blocking=False): raise HTTPException(409,'已有更新操作正在执行。')
        try:
            return await asyncio.to_thread(engine.check,root)
        except (UpdateError,OSError) as exc:
            message=str(exc) if isinstance(exc,UpdateError) else '无法保存更新检查结果，请检查磁盘。'
            engine.state(root,phase='check_failed',error=message)
            raise HTTPException(502,message) from exc
        finally: _lock.release()

    @app.post('/api/studio/updates/download')
    async def download(request:Request):
        global _worker
        _origin(request); root=_root(core)
        if not _lock.acquire(blocking=False): raise HTTPException(409,'已有更新操作正在执行。')
        def run():
            try: engine.prepare(root)
            except Exception as exc:
                engine.state(root,phase='download_failed',error=str(exc) if isinstance(exc,UpdateError) else '下载或解压失败；已保留现有版本。')
            finally: _lock.release()
        _worker=threading.Thread(target=run,daemon=True); _worker.start()
        return {'accepted':True}

    class InstallRequest(BaseModel):
        model_config=ConfigDict(extra='forbid')
        action:Literal['install','rollback']='install'
        saved_and_closed:bool

    @app.post('/api/studio/updates/install')
    async def queue_install(payload:InstallRequest,request:Request):
        _origin(request); root=_root(core); _supervisor(root)
        if not payload.saved_and_closed: raise HTTPException(409,'请先保存并关闭其他画布标签页。')
        if not _lock.acquire(blocking=False): raise HTTPException(409,'已有更新操作正在执行。')
        try:
            # Gate first, then drain/check: no new browser/API work can race the snapshot.
            engine.gate(root,True)
            if core.manager.active_connections or _active:
                raise UpdateError('还有画布页面或请求正在使用服务，请保存并关闭其他画布标签页后重试。')
            if engine.busy_jobs(core.RUNTIME_DIR): raise UpdateError('有生成任务未完成或状态待核实，请先处理任务。')
            if payload.action=='install':
                signed=engine.verified_available(root)
                prepared=read_json(root/'updates'/'prepared.json')
                if prepared.get('version')!=signed['version']: raise UpdateError('请先下载并校验更新包。')
            elif not (root/'updates'/'previous.json').exists(): raise UpdateError('没有可回退的上一个版本。')
            engine.require_space(root)
            current=engine.layout(root)[4]
            engine.state(root,phase='queued',error=None)
            atomic_json(root/'updates'/'request.json',{'action':payload.action,'version':current,'at':int(time.time())})
            return {'accepted':True,'phase':'queued'}
        except (UpdateError,OSError) as exc:
            engine.gate(root,False)
            raise HTTPException(409,str(exc) if isinstance(exc,UpdateError) else '无法准备更新，请检查磁盘和文件占用。') from exc
        finally: _lock.release()
