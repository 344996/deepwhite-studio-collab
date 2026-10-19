"""Stable bootstrap v1. Standard library only; user data stays outside versions."""
import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys

BOOTSTRAP_VERSION = 1
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-studio\.(0|[1-9]\d*)')


class LaunchError(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise LaunchError('Duplicate fields in installation metadata.')
        result[key] = value
    return result


def read_json(path):
    try:
        if path.stat().st_size > 64 * 1024:
            raise LaunchError('Installation metadata is too large.')
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    except (OSError, ValueError) as exc:
        raise LaunchError('Installation metadata is missing or invalid. Extract the complete package again.') from exc


def contained_file(root, path):
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise LaunchError('A required program file is missing or points outside this installation.')
    return resolved


def selected_installation(root):
    root = Path(root).resolve()
    pointer = read_json(root / 'current.json')
    if not isinstance(pointer, dict) or set(pointer) != {'version'}:
        raise LaunchError('current.json must contain exactly one version field.')
    version = pointer['version']
    if not isinstance(version, str) or len(version) > 60 or not VERSION.fullmatch(version):
        raise LaunchError('The selected version is invalid. Keep current.json and check the recovery instructions.')
    release_root = root / 'versions' / version
    if not release_root.resolve().is_relative_to(root):
        raise LaunchError('The selected version points outside this installation.')
    release = read_json(contained_file(root, release_root / 'release.json'))
    fields = {'app', 'version', 'platform', 'data_schema', 'min_bootstrap', 'commit'}
    if (not isinstance(release, dict) or set(release) != fields or release['app'] != 'deepwhite-studio'
            or release['version'] != version or release['platform'] != 'windows-x64'
            or type(release['min_bootstrap']) is not int or not 1 <= release['min_bootstrap'] <= BOOTSTRAP_VERSION
            or release['data_schema'] != {'read_min': 1, 'read_max': 1, 'write': 1}
            or any(type(value) is not int for value in release['data_schema'].values())
            or not isinstance(release['commit'], str) or not re.fullmatch('[a-f0-9]{40}', release['commit'])):
        raise LaunchError('The selected release is incompatible or incomplete.')
    app_version = contained_file(root, release_root / 'app' / 'VERSION').read_text(encoding='utf-8').strip()
    if app_version != version:
        raise LaunchError('The application version does not match current.json.')
    executable = contained_file(root, release_root / 'python' / 'python.exe')
    supervisor = contained_file(root, release_root / 'app' / 'studio_portable.py')
    return version, executable, supervisor


def launch(root, *, port=None, no_browser=False, check=False):
    root = Path(root).resolve()
    version, executable, supervisor = selected_installation(root)
    if check:
        print(json.dumps({'version': version, 'bootstrap': BOOTSTRAP_VERSION,
                          'python': str(executable), 'supervisor': str(supervisor)}))
        return 0
    command = [str(executable), '-I', '-B', str(supervisor), '--root', str(root)]
    if port is not None:
        if type(port) is not int or not 1024 <= port <= 65535:
            raise LaunchError('Port must be an integer between 1024 and 65535.')
        command.extend(['--port', str(port)])
    environment = dict(os.environ)
    if no_browser:
        command.append('--no-browser')
    # The supervisor owns the installation lock, readiness and repeated launches.
    return subprocess.call(command, cwd=root, env=environment,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def main():
    parser = argparse.ArgumentParser(description='DeepWhite Studio portable bootstrap')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--port', type=int)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        return launch(args.root, port=args.port, no_browser=args.no_browser, check=args.check)
    except (LaunchError, OSError) as exc:
        message = str(exc)
        log = args.root / 'userdata' / 'logs' / 'launcher.log'
        try:
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open('a', encoding='utf-8') as stream:
                stream.write(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' ' + message + '\n')
        except OSError:
            pass
        print(message, file=sys.stderr)
        if os.name == 'nt' and not args.no_browser and os.getenv('DEEPWHITE_STUDIO_NO_BROWSER') != '1':
            ctypes.windll.user32.MessageBoxW(0, message + '\n\n' + str(log), 'DeepWhite Studio', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
