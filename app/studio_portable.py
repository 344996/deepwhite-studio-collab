"""Windows portable supervisor and owned server process; no external Python needed."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import webbrowser

sys.path.insert(0, str(Path(__file__).resolve().parent))
import httpx
import psutil
import studio_update_engine as updates
from studio_update_core import UpdateError, atomic_json, read_json, version


def healthy(port, expected, installation=None, pid=None):
    try:
        with httpx.Client(timeout=2, trust_env=False) as client:
            response=client.get(f'http://127.0.0.1:{port}/api/studio/health')
            value=response.json()
            return (response.status_code==200 and value.get('version')==expected
                    and (installation is None or Path(value.get('installation','')).resolve()==Path(installation).resolve())
                    and (pid is None or value.get('pid')==pid) and value.get('ready') is True)
    except (httpx.HTTPError, ValueError, OSError): return False


def server(args):
    root=Path(args.root).resolve()
    def parent_alive():
        try:
            process=psutil.Process(args.supervisor_pid)
            return abs(process.create_time()-args.supervisor_created)<.001 and process.is_running()
        except psutil.Error: return False
    # No data access until the parent has durably recorded this exact child.
    deadline=time.monotonic()+10
    while True:
        if not parent_alive(): raise UpdateError('启动器已退出，服务未访问用户数据。')
        try:
            record=read_json(root/'updates'/'server-process.json')
            if record.get('pid')==os.getpid() and abs(record.get('created',0)-psutil.Process().create_time())<.001: break
        except UpdateError: pass
        if time.monotonic()>=deadline: raise UpdateError('服务启动登记未完成，已停止。')
        time.sleep(.05)
    def orphan_monitor():
        while True:
            if not parent_alive(): os._exit(0)
            time.sleep(.25)
    threading.Thread(target=orphan_monitor,daemon=True).start()
    with updates.exclusive(root/'updates'/'runtime.lock'):
        if not parent_alive(): raise UpdateError('启动器已退出，服务未访问用户数据。')
        _serve(args)


def _serve(args):
    root, release, runtime, update_dir, current=updates.layout(args.root)
    if Path(__file__).resolve().parent != release/'app':
        raise UpdateError('服务启动版本与当前版本指针不一致。')
    os.environ.update(DEEPWHITE_STUDIO_RUNTIME_DIR=str(runtime), DEEPWHITE_INSTALL_ROOT=str(root),
                      DEEPWHITE_STUDIO_PORT=str(args.port), PYTHONDONTWRITEBYTECODE='1')
    updates.validate_data(runtime)
    import studio_server
    import uvicorn
    instance=uvicorn.Server(uvicorn.Config(studio_server.app,host='127.0.0.1',port=args.port,
                           ws_ping_interval=None,ws_ping_timeout=None,timeout_graceful_shutdown=15))
    stop_path=update_dir/'stop-server.json'
    def monitor():
        while not instance.should_exit:
            try:
                if stop_path.exists():
                    stop=read_json(stop_path)
                    if stop.get('pid')==os.getpid() and abs(stop.get('created',0)-psutil.Process().create_time())<.001:
                        instance.should_exit=True
            except UpdateError: pass
            time.sleep(.25)
    threading.Thread(target=monitor,daemon=True).start()
    instance.run()


class Supervisor:
    def __init__(self, root, port, no_browser=False):
        self.root=Path(root).resolve(); self.port=port; self.no_browser=no_browser
        self.child=None; self.log=None
        self.updates=self.root/'updates'
        self.updates.mkdir(exist_ok=True)

    def reclaim(self):
        """Only a recorded process with matching creation time and root is ours."""
        path=self.updates/'server-process.json'
        if not path.exists(): return
        record=read_json(path)
        try:
            process=psutil.Process(record['pid'])
            if abs(process.create_time()-record['created'])>.001: return
            argv=process.cmdline()
            if '--serve' not in argv or '--root' not in argv or Path(argv[argv.index('--root')+1]).resolve()!=self.root:
                raise UpdateError('记录中的进程身份不匹配，已停止恢复。')
            atomic_json(self.updates/'stop-server.json',{'pid':process.pid,'created':process.create_time()})
            try: process.wait(25)
            except psutil.TimeoutExpired: process.terminate(); process.wait(10)
        except (psutil.NoSuchProcess,psutil.ZombieProcess): pass

    def start(self, selected):
        version(selected)
        release=updates.inside(self.root,self.root/'versions'/selected)
        env=dict(os.environ,DEEPWHITE_INSTALL_ROOT=str(self.root),DEEPWHITE_STUDIO_RUNTIME_DIR=str(self.root/'userdata'),
                 DEEPWHITE_STUDIO_PORT=str(self.port),PYTHONDONTWRITEBYTECODE='1')
        self.log=(self.updates/'server.log').open('ab')
        self.child=subprocess.Popen([str(release/'python'/'python.exe'),'-I','-B',str(release/'app'/'studio_portable.py'),
                                     '--root',str(self.root),'--port',str(self.port),'--serve',
                                     '--supervisor-pid',str(os.getpid()),'--supervisor-created',str(psutil.Process().create_time())],
                                    cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=self.log,stderr=subprocess.STDOUT,
                                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        atomic_json(self.updates/'server-process.json',{'pid':self.child.pid,'created':psutil.Process(self.child.pid).create_time(),
                                                       'version':selected,'port':self.port})

    def stop(self):
        if self.child and self.child.poll() is None:
            atomic_json(self.updates/'stop-server.json',{'pid':self.child.pid,'created':psutil.Process(self.child.pid).create_time()})
            try: self.child.wait(timeout=25)
            except subprocess.TimeoutExpired:
                self.child.terminate(); self.child.wait(timeout=10)
        if self.log: self.log.close(); self.log=None
        self.child=None

    def ready(self, selected):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if not self.child or self.child.poll() is not None: return False
            if healthy(self.port,selected,self.root/'versions'/selected/'app',self.child.pid): return True
            time.sleep(.3)
        return False

    def run(self):
        try:
            with updates.exclusive(self.updates/'supervisor.lock'):
                self.reclaim()
                updates.recover(self.root)
                current=updates.layout(self.root)[4]
                atomic_json(self.updates/'supervisor.json',{'pid':os.getpid(),'created':psutil.Process().create_time(),'port':self.port})
                request=self.updates/'request.json'
                # Requests from a previous stopped supervisor must be confirmed again.
                if request.exists(): os.replace(request,self.updates/('stale-request-'+str(time.time_ns())+'.json'))
                self.start(current)
                if not self.ready(current): raise UpdateError('画布启动失败，请查看 updates/server.log。')
                if not self.no_browser: webbrowser.open(f'http://127.0.0.1:{self.port}/')
                while self.child and self.child.poll() is None:
                    if request.exists():
                        value=read_json(request)
                        os.replace(request,self.updates/('request-'+str(time.time_ns())+'.json'))
                        if value.get('version')!=updates.layout(self.root)[4] or value.get('action') not in ('install','rollback'):
                            updates.state(self.root,phase='failed',error='更新请求已过期，请重新确认。'); updates.gate(self.root,False)
                        else:
                            try: updates.install(self.root,self.stop,self.start,self.ready,action=value['action'])
                            except Exception as exc:
                                updates.state(self.root,phase='failed',error=str(exc) if isinstance(exc,UpdateError) else '更新失败，请查看启动日志。')
                                tx_path=self.updates/'transaction.json'
                                if not tx_path.exists() or read_json(tx_path).get('phase') in ('committed','reverted'):
                                    updates.gate(self.root,False)
                                # Incomplete transactions deliberately retain the gate for recovery.
                    time.sleep(.3)
        except UpdateError:
            # A second launch opens the running, verified installation only.
            try:
                current=updates.layout(self.root)[4]
                existing=read_json(self.updates/'supervisor.json')
                if existing.get('pid')!=os.getpid() and healthy(existing['port'],current,self.root/'versions'/current/'app'):
                    if not self.no_browser: webbrowser.open(f"http://127.0.0.1:{existing['port']}/")
                    return
            except (UpdateError,KeyError): pass
            raise
        finally:
            self.stop()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--port',type=int)
    parser.add_argument('--no-browser',action='store_true')
    parser.add_argument('--serve',action='store_true')
    parser.add_argument('--supervisor-pid',type=int)
    parser.add_argument('--supervisor-created',type=float)
    args=parser.parse_args()
    if args.port is None:
        configured=3848
        config=Path(args.root)/'installation.json'
        if config.exists():
            value=read_json(config)
            if not isinstance(value,dict) or set(value)!={'port'} or type(value['port']) is not int:
                parser.error('installation.json must contain only an integer port')
            configured=value['port']
        try: args.port=int(os.getenv('DEEPWHITE_STUDIO_PORT',str(configured)))
        except ValueError: parser.error('DEEPWHITE_STUDIO_PORT must be an integer')
    if not 1024 <= args.port <= 65535: parser.error('port must be between 1024 and 65535')
    if args.serve:
        if not args.supervisor_pid or not args.supervisor_created: parser.error('server requires supervisor identity')
        server(args)
    else:
        runner=Supervisor(args.root,args.port,args.no_browser or os.getenv('DEEPWHITE_NO_BROWSER')=='1')
        def stop_signal(*_): raise KeyboardInterrupt()
        signal.signal(signal.SIGINT,stop_signal)
        signal.signal(signal.SIGTERM,stop_signal)
        try: runner.run()
        except KeyboardInterrupt: pass


if __name__=='__main__': main()
