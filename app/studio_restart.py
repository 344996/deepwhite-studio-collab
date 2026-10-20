"""Restart only this portable installation through its existing stop protocol."""
import argparse
import math
from pathlib import Path
import subprocess
import time

import psutil

import studio_update_engine as engine
from studio_update_core import UpdateError, atomic_json, read_object as read_json, version


def process_identity(record):
    if (not isinstance(record,dict) or type(record.get('pid')) is not int or record['pid']<=0
            or type(record.get('created')) not in (int,float)
            or not math.isfinite(record['created']) or record['created']<=0):
        raise UpdateError('进程身份记录无效，未重启任何进程。')
    return record['pid'],record['created']


def owned_process(root, record, *, server=False):
    """PID, creation time, command, interpreter and installation must all agree."""
    root = Path(root).resolve()
    pid,created = process_identity(record)
    try:
        process = psutil.Process(pid)
        argv = process.cmdline()
        if (abs(process.create_time() - created) > .001
                or ('--serve' in argv) != server or '--root' not in argv
                or Path(argv[argv.index('--root') + 1]).resolve() != root):
            raise ValueError()
        executable = Path(process.exe()).resolve()
        release = executable.parent.parent
        if release.parent != root / 'versions' or executable != release / 'python' / 'python.exe':
            raise ValueError()
        selected = release.name
        version(selected)
        script = release / 'app' / 'studio_portable.py'
        if not any(Path(arg).resolve() == script for arg in argv if arg.endswith('studio_portable.py')):
            raise ValueError()
        return process, selected
    except (psutil.Error, KeyError, IndexError, OSError, TypeError, ValueError) as exc:
        raise UpdateError('启动器身份无法确认，请保留当前画布并重新检查。') from exc


def restart(root, expected_supervisor, expected_server):
    root, release, runtime, updates, current = engine.layout(root)
    with engine.exclusive(updates / 'restart.lock'):
        supervisor_record = read_json(updates / 'supervisor.json')
        server_record = read_json(updates / 'server-process.json')
        for actual, expected in ((supervisor_record, expected_supervisor),
                                 (server_record, expected_server)):
            actual_pid,actual_created = process_identity(actual)
            expected_pid,expected_created = process_identity(expected)
            if (actual_pid != expected_pid or abs(actual_created - expected_created) > .001):
                raise UpdateError('画布进程已改变，请重新确认重启。')
        supervisor, _ = owned_process(root, supervisor_record)
        server, selected = owned_process(root, server_record, server=True)
        if server.ppid() != supervisor.pid or selected != current:
            raise UpdateError('当前服务不属于此启动器，未重启任何进程。')
        port = server_record['port']
        if type(port) is not int or not 1024 <= port <= 65535 or supervisor_record.get('port') != port:
            raise UpdateError('当前启动端口记录不匹配。')
        tx_path = updates / 'transaction.json'
        if tx_path.exists() and read_json(tx_path).get('phase') not in ('committed', 'reverted'):
            raise UpdateError('更新事务尚未完成，请稍后重启。')
        if engine.busy_jobs(runtime):
            raise UpdateError('有生成任务未完成，未重启。')
        engine.state(root, phase='restarting', error=None)
        # The server exits gracefully; its owning supervisor and bootstrap then
        # exit naturally. Never terminate a process by name or listening port.
        atomic_json(updates / 'stop-server.json', {
            'pid': server.pid, 'created': server.create_time(),
        })
        try:
            server.wait(35)
            supervisor.wait(20)
        except psutil.TimeoutExpired as exc:
            raise UpdateError('画布尚未安全退出，未强制结束进程。请稍后再试。') from exc
        if engine.layout(root)[4] != current:
            raise UpdateError('重启期间版本已改变，未启动第二个画布。')
        with (updates / 'launcher.log').open('ab') as log:
            subprocess.Popen([
                str(release / 'python' / 'python.exe'), '-I', '-B',
                str(root / 'launcher.py'), '--root', str(root), '--port', str(port), '--no-browser',
            ], cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + 90
        from studio_portable import healthy
        while time.monotonic() < deadline:
            try:
                record = read_json(updates / 'supervisor.json')
                new_supervisor, running = owned_process(root, record)
                child_record = read_json(updates / 'server-process.json')
                child, selected = owned_process(root, child_record, server=True)
                if (new_supervisor.pid != supervisor.pid and running == selected == current
                        and child.ppid() == new_supervisor.pid
                        and healthy(port, current, release / 'app', child.pid)):
                    engine.state(root, phase='restarted', current_version=current, error=None)
                    engine.gate(root, False)
                    return
            except (UpdateError, psutil.Error):
                pass
            time.sleep(.3)
        raise UpdateError('重启尚未通过启动检查，请重新运行 Start.cmd 并查看启动日志。')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--supervisor-pid', type=int, required=True)
    parser.add_argument('--supervisor-created', type=float, required=True)
    parser.add_argument('--server-pid', type=int, required=True)
    parser.add_argument('--server-created', type=float, required=True)
    args = parser.parse_args()
    try:
        restart(args.root, {'pid': args.supervisor_pid, 'created': args.supervisor_created},
                {'pid': args.server_pid, 'created': args.server_created})
    except Exception as exc:
        engine.state(args.root, phase='failed', error=str(exc) if isinstance(exc, UpdateError)
                     else '重启失败，请查看 updates/restart.log；原数据和程序均已保留。')
        # No program or data transaction is performed by this helper.
        engine.gate(args.root, False)
        raise


if __name__ == '__main__':
    main()
