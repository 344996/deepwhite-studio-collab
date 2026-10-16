"""Launch/stop only this DeepWhite Studio installation."""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORTS = range(3848, 3859)


def service_info(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/studio/health', timeout=.4) as response:
            info = json.load(response)
        if info.get('app') == 'DeepWhite Studio' and info.get('installation') == str(ROOT):
            return info
    except Exception:
        pass
    return None


def open_app(port):
    url = f'http://127.0.0.1:{port}/'
    print(url, flush=True)
    if os.getenv('DEEPWHITE_STUDIO_NO_BROWSER') != '1':
        webbrowser.open(url)


def launch():
    for port in PORTS:
        if service_info(port):
            open_app(port)
            return
    for port in PORTS:
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
                break
            except OSError:
                continue
    else:
        raise RuntimeError('3848–3858 端口均被占用，请关闭本项目旧服务后重试。')
    logs = ROOT / 'logs'
    logs.mkdir(exist_ok=True)
    env = {**os.environ, 'DEEPWHITE_STUDIO_PORT': str(port),
           'DEEPWHITE_STUDIO_RUNTIME_DIR': str(ROOT / 'workspace'),
           'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1'}
    with (logs / 'server.log').open('a', encoding='utf-8') as log:
        process = subprocess.Popen([str(ROOT / 'python/python.exe'), str(ROOT / 'studio_server.py')],
            cwd=ROOT, env=env, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    (logs / 'server.json').write_text(json.dumps({'pid': process.pid, 'port': port}), encoding='utf-8')
    for _ in range(100):
        if service_info(port):
            open_app(port)
            return
        if process.poll() is not None:
            break
        time.sleep(.2)
    raise RuntimeError('服务未能启动，请查看 logs/server.log。')


def stop():
    for port in PORTS:
        info = service_info(port)
        if info and isinstance(info.get('pid'), int):
            try:
                request=urllib.request.Request(f'http://127.0.0.1:{port}/api/studio/local-engine/stop',data=b'',method='POST')
                with urllib.request.urlopen(request,timeout=15):pass
            except urllib.error.HTTPError as exc:
                if exc.code!=404:raise RuntimeError('本地引擎有任务或尚未就绪，请先在画布中完成任务后退出。')
            os.kill(info['pid'], signal.SIGTERM)


if __name__ == '__main__':
    try:
        stop() if '--stop' in sys.argv else launch()
    except Exception as error:
        print(str(error), file=sys.stderr)
        if os.name == 'nt' and os.getenv('DEEPWHITE_STUDIO_NO_BROWSER') != '1':
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(error), 'DeepWhite Studio', 0x10)
        sys.exit(1)
