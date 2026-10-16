"""Local engine lifecycle. Only a child process started here may be stopped here."""
import asyncio
import json
import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
from fastapi import HTTPException
from pydantic import BaseModel
import main as core

BASE='http://127.0.0.1:8188'
LOCK=asyncio.Lock()
PROCESS=None
START_TASK=None
ERROR=''
STARTED=0


class Settings(BaseModel):
    directory: str = r'D:\deep\Comfyui'
    base_url: str = 'http://127.0.0.1:8188'
    auto_start: bool = True
    start_with_app: bool = False


def settings_path():return Path(core.DATA_DIR)/'local-comfy-engine.json'
def config():
    p=settings_path()
    if not p.exists(): return Settings()
    try: return Settings(**json.loads(p.read_text(encoding='utf-8')))
    except (ValueError, TypeError): return Settings()


def base_url():
    from urllib.parse import urlsplit
    value=config().base_url.strip().rstrip('/')
    parts=urlsplit(value)
    if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password or parts.path not in ('','/') or parts.query or parts.fragment:
        raise HTTPException(400,'ComfyUI 地址需要是有效的 http(s) 基础地址。')
    return value


def validate_local_address(value):
    from urllib.parse import urlsplit
    import ipaddress
    parts=urlsplit(value.strip().rstrip('/'))
    if parts.scheme!='http' or not parts.hostname or parts.path not in ('','/') or parts.query or parts.fragment or parts.username or parts.password:
        raise HTTPException(400,'本地 ComfyUI 只接受无凭据的 http 地址。')
    host=parts.hostname.lower()
    if host not in ('localhost','127.0.0.1','::1'):
        try:
            if not ipaddress.ip_address(host).is_loopback: raise HTTPException(400,'为保护本机服务，只能连接本机回环地址。')
        except ValueError: raise HTTPException(400,'为保护本机服务，只能连接 localhost 或本机回环 IP。')
    if parts.port is None or not (1<=parts.port<=65535):raise HTTPException(400,'请填写有效的 ComfyUI 端口。')
    return f'http://{parts.netloc}'


def layout(directory):
    root=Path(directory).expanduser().resolve()
    python=root/'python/python.exe';work=root/'ComfyUI'
    if not python.is_file() or not (work/'main.py').is_file():
        raise HTTPException(400,'请选择包含 python 和 ComfyUI 两个文件夹的整合包根目录。')
    return root,python,work


def command(directory):
    root,python,work=layout(directory)
    args=[str(python),'-s',str(Path(__file__).parent/'comfy_engine_entry.py'),str(work/'main.py'),'--listen','127.0.0.1','--port','8188','--disable-auto-launch']
    preference=root/'.launcher/preference.json'
    if preference.exists():
        prefs=json.loads(preference.read_text(encoding='utf-8-sig')).get('args',{})
        if prefs.get('smart_memory') is False:args.append('--disable-smart-memory')
        if prefs.get('upcast_attention'):args.append('--force-upcast-attention')
        if prefs.get('fast'):args.append('--fast')
    return args,work,root


async def probe(address=None):
    address=validate_local_address(address or base_url())
    try:
        async with httpx.AsyncClient(timeout=2,trust_env=False) as client:
            r=await client.get(address+'/system_stats');r.raise_for_status();data=r.json()
            if not isinstance(data.get('system'),dict) or not isinstance(data.get('devices'),list):return False
            r=await client.get(address+'/queue');r.raise_for_status();q=r.json()
            return 'queue_running' in q and 'queue_pending' in q
    except (httpx.HTTPError,ValueError,AttributeError):return False


def owned():return PROCESS is not None and PROCESS.poll() is None


async def status():
    address=base_url()
    ready=await probe(address)
    starting=START_TASK is not None and not START_TASK.done()
    state='ready' if ready else 'starting' if starting else 'missing_dependencies' if ERROR.startswith('缺少依赖') else 'failed' if ERROR else 'stopped'
    return {'state':state,'service_state':'ready' if ready else state,
            'owned':owned(),'error':ERROR if not ready else '', 'base_url':address,'settings':config().model_dump(),
            'message':'已连接 · 首次生成时加载模型' if ready else '正在启动本地引擎，请稍候…' if starting else ERROR or '本地引擎未启动',
            'elapsed':int(time.time()-STARTED) if starting else 0}


async def boot():
    global PROCESS,ERROR,STARTED
    try:
        if await probe():return
        if not owned():
            from urllib.parse import urlsplit
            target=urlsplit(base_url())
            with socket.socket() as s:
                if s.connect_ex((target.hostname,target.port or 8188))==0:
                    raise HTTPException(409,'8188 端口已被占用且服务尚未就绪。若启动器正在加载，请稍后重试；不会重复启动。')
            if target.hostname not in ('127.0.0.1','localhost','::1'):
                raise HTTPException(400,'只有本机整合包可以由 DeepWhite 启动。')
            args,work,root=command(config().directory)
            args[args.index('--port')+1]=str(target.port or 8188)
            log=Path(core.DATA_DIR)/'local-comfy-engine.log';log.parent.mkdir(parents=True,exist_ok=True)
            env={**os.environ,'PYTHONUTF8':'1','PYTHONUNBUFFERED':'1'}
            env['PATH']=str(root/'python')+os.pathsep+str(root/'git/bin')+os.pathsep+env.get('PATH','')
            with log.open('ab') as stream:
                PROCESS=subprocess.Popen(args,cwd=work,env=env,stdout=stream,stderr=stream,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        STARTED=time.time()
        for _ in range(240):
            if await probe():return
            if not owned():raise HTTPException(400,'本地引擎启动后退出，请查看启动日志。')
            await asyncio.sleep(2)
        raise HTTPException(408,'启动等待超时，进程仍保留。可查看日志并重试连接，不会重复启动。')
    except Exception as exc:
        ERROR=str(exc.detail) if isinstance(exc,HTTPException) else '启动失败：'+str(exc)[:250]
        log=Path(core.DATA_DIR)/'local-comfy-engine.log'
        if log.exists():
            try:
                tail=log.read_bytes()[-12000:].decode('utf-8',errors='replace').lower()
                if any(token in tail for token in ('modulenotfounderror','no module named','missing dependencies','dll load failed')):
                    ERROR='缺少依赖：请检查整合包 Python 环境与启动日志。'
            except OSError: pass


async def start():
    global START_TASK,ERROR,STARTED
    async with LOCK:
        if await probe():return await status()
        if START_TASK is None or START_TASK.done():
            layout(config().directory);ERROR='';STARTED=time.time();START_TASK=asyncio.create_task(boot())
    return await status()


async def ensure():
    if await probe():return
    if not config().auto_start:raise HTTPException(400,'本地引擎未启动，请点击启动本地引擎。')
    await start()
    if START_TASK:await asyncio.shield(START_TASK)
    if not await probe():raise HTTPException(400,ERROR or '本地引擎未就绪，请重试。')


async def stop():
    global PROCESS,ERROR
    async with LOCK:
        if not owned():return {'stopped':False,'message':'此引擎不是由当前 DeepWhite 服务启动，不会关闭。'}
        if START_TASK and not START_TASK.done():raise HTTPException(409,'引擎仍在启动，请等待启动结束。')
        import studio_generation as jobs
        if any(not t.done() for t in jobs.WORKERS.values()):raise HTTPException(409,'画布有任务正在执行，请完成后再关闭引擎。')
        try:
            async with httpx.AsyncClient(timeout=3,trust_env=False) as client:
                r=await client.get(base_url()+'/queue');r.raise_for_status();q=r.json()
                if q.get('queue_running') or q.get('queue_pending'):raise HTTPException(409,'ComfyUI 有任务运行或排队，请完成后再关闭。')
        except (httpx.HTTPError,ValueError):
            raise HTTPException(409,'无法确认任务是否空闲，暂不关闭进程。')
        PROCESS.terminate()
        await asyncio.to_thread(PROCESS.wait,10)
        PROCESS=None;ERROR=''
        return {'stopped':True,'message':'本地引擎已关闭'}


def install(app):
    @app.get('/api/studio/local-engine')
    async def get_status():return await status()

    @app.put('/api/studio/local-engine/settings')
    async def save_settings(payload:Settings):
        async with LOCK:
            if owned() and (payload.directory!=config().directory or validate_local_address(payload.base_url)!=base_url()):raise HTTPException(409,'请先关闭当前由 DeepWhite 启动的引擎，再修改目录或地址。')
            validate_local_address(payload.base_url)
            if payload.auto_start or payload.start_with_app or owned(): layout(payload.directory)
            p=settings_path();p.parent.mkdir(parents=True,exist_ok=True)
            temp=p.with_suffix('.tmp');temp.write_text(payload.model_dump_json(),encoding='utf-8');os.replace(temp,p)
        return await status()

    @app.post('/api/studio/local-engine/probe')
    async def probe_engine(payload:dict):
        requested=validate_local_address(str(payload.get('base_url') or ''))
        return {'base_url':requested,'ready':await probe(requested)}

    @app.get('/api/studio/local-engine/discover')
    async def discover_engines():
        ports=[]
        try:
            configured=int(__import__('urllib.parse',fromlist=['urlsplit']).urlsplit(base_url()).port or 8188)
            ports.append(configured)
        except Exception: pass
        ports.extend(p for p in (8188,8189,8000,8181,3000) if p not in ports)
        results=[]
        for port in ports:
            address=f'http://127.0.0.1:{port}'
            results.append({'base_url':address,'ready':await probe(address),'saved':address==base_url()})
        return {'connections':results,'state':'ready' if any(x['ready'] for x in results) else 'stopped'}

    @app.post('/api/studio/local-engine/start')
    async def start_engine():return await start()

    @app.post('/api/studio/local-engine/stop')
    async def stop_engine():return await stop()

    @app.get('/api/studio/local-engine/log')
    async def log_tail():
        from studio_generation import clean_error
        p=Path(core.DATA_DIR)/'local-comfy-engine.log'
        if not p.exists():return {'text':'尚无后台启动日志。'}
        with p.open('rb') as f:
            f.seek(max(0,p.stat().st_size-12000));text=f.read().decode('utf-8',errors='replace')
        return {'text':'\n'.join(clean_error(line) for line in text.splitlines()[-60:])}

    @app.on_event('startup')
    async def startup():
        if config().start_with_app:
            try:await start()
            except HTTPException:pass

    @app.on_event('shutdown')
    async def shutdown():
        if owned():
            try:await stop()
            except Exception:pass  # Busy or unidentified tasks remain running.
