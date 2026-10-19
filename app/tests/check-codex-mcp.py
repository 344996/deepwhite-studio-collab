"""Exercise the installed Codex MCP client, without inference or saved config edits.

Usage: python tests/check-codex-mcp.py --codex /absolute/path/to/codex.exe
Requires this application's Python dependencies. All service and Codex state is
temporary. Evidence contains fixture data only. No provider generation is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, command, env, cwd, stderr):
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8')
        self.events = queue.Queue()
        self.serial = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            try:
                self.events.put(json.loads(line))
            except ValueError:
                pass

    def send(self, method, params, request_id=None):
        message = {'method': method, 'params': params}
        if request_id is not None:
            message['id'] = request_id
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def call(self, method, params):
        self.serial += 1
        request_id = self.serial
        self.send(method, params, request_id)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            message = self.events.get(timeout=max(0.1, deadline - time.monotonic()))
            if message.get('id') == request_id:
                if 'error' in message:
                    raise RuntimeError(f'{method}: {message["error"]}')
                return message['result']
        raise TimeoutError(method)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.reader.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', required=True)
    parser.add_argument('--evidence', type=Path, default=ROOT / 'test-output' / 'codex-mcp')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    trace = evidence / 'handshake.jsonl'
    trace.write_text('', encoding='utf-8')
    user_config = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    config_digest = lambda: hashlib.sha256(user_config.read_bytes()).hexdigest() if user_config.exists() else None
    original_config = config_digest()
    report = {'codex_version': subprocess.check_output([args.codex, '--version'], text=True).strip(),
        'inference_used': False, 'provider_generation_used': False, 'status': 'running'}
    backend = client = None
    with tempfile.TemporaryDirectory(prefix='deepwhite-codex-client-') as temporary:
        work = Path(temporary)
        runtime = work / 'runtime'
        (runtime / 'data').mkdir(parents=True)
        (runtime / 'data' / 'studio_control.json').write_text(json.dumps({
            'enabled': True, 'token': 'isolated-client-fixture-token', 'generation_mode': 'confirm'}), encoding='utf-8')
        isolated_codex = work / 'codex'
        isolated_codex.mkdir()
        wrapper = work / 'trace_bridge.py'
        wrapper.write_text('import sys, json\nfrom pathlib import Path\n'
            f'sys.path.insert(0, {str(ROOT)!r})\nimport studio_mcp as bridge\n'
            'original = bridge.Bridge.handle\n'
            'def handle(self, message):\n'
            '    result = original(self, message)\n'
            '    params = message.get("params", {})\n'
            '    entry = {"method": message.get("method"), "requested_version": params.get("protocolVersion"), '
            '"tool": params.get("name")}\n'
            '    if isinstance(result, dict):\n'
            '        entry["negotiated_version"] = result.get("result", {}).get("protocolVersion")\n'
            '        entry["error_code"] = result.get("error", {}).get("code")\n'
            f'    with open({str(trace)!r}, "a", encoding="utf-8") as stream: stream.write(json.dumps(entry) + "\\n")\n'
            '    return result\nbridge.Bridge.handle = handle\nraise SystemExit(bridge.main())\n', encoding='utf-8')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        base_url = f'http://127.0.0.1:{port}'
        environment = dict(os.environ, DEEPWHITE_STUDIO_RUNTIME_DIR=str(runtime), PYTHONUTF8='1')
        # This child home is isolated from the user's saved configuration/auth.
        codex_environment = dict(environment, CODEX_HOME=str(isolated_codex))
        encode = lambda value: json.dumps(str(value))
        (isolated_codex / 'config.toml').write_text(
            'model_provider = "fixture"\nmodel = "fixture-no-inference"\n'
            '[model_providers.fixture]\nname = "No inference in MCP validation"\n'
            'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n'
            '[mcp_servers.deepwhite_test]\n'
            f'command = {encode(sys.executable)}\n'
            f'args = [{encode(wrapper)}, "--url", {encode(base_url)}]\n'
            'startup_timeout_sec = 20\ntool_timeout_sec = 20\n'
            '[mcp_servers.deepwhite_test.env]\n'
            f'DEEPWHITE_STUDIO_RUNTIME_DIR = {encode(runtime)}\n', encoding='utf-8')
        with (evidence / 'backend.log').open('w', encoding='utf-8') as backend_log, \
                (evidence / 'codex.log').open('w', encoding='utf-8') as codex_log:
            try:
                backend = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'studio_server:app',
                    '--host', '127.0.0.1', '--port', str(port)], cwd=ROOT, env=environment,
                    stdout=backend_log, stderr=subprocess.STDOUT)
                opener = build_opener(ProxyHandler({}))
                for _ in range(100):
                    try:
                        with opener.open(base_url + '/api/studio/health', timeout=1) as response:
                            report['health'] = json.load(response)
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError('Temporary backend did not start')
                client = Client([args.codex, 'app-server', '--stdio'], codex_environment, work, codex_log)
                report['initialize'] = client.call('initialize', {'clientInfo': {
                    'name': 'deepwhite_mcp_validation', 'version': '1'},
                    'capabilities': {'experimentalApi': True}})
                client.send('initialized', {})
                thread = client.call('thread/start', {'cwd': str(work), 'ephemeral': True,
                    'approvalPolicy': 'never', 'sandbox': 'read-only'})
                thread_id = thread['thread']['id']
                inventory = client.call('mcpServerStatus/list', {'threadId': thread_id,
                    'serverName': 'deepwhite_test', 'detail': 'toolsAndAuthOnly'})
                report['inventory'] = inventory
                calls = []
                def tool(name, arguments):
                    result = client.call('mcpServer/tool/call', {'threadId': thread_id,
                        'server': 'deepwhite_test', 'tool': name, 'arguments': arguments})
                    if result.get('isError'):
                        raise RuntimeError(f'{name}: {result}')
                    value = result.get('structuredContent')
                    if value is None:
                        value = json.loads(result['content'][0]['text'])
                    calls.append({'tool': name, 'result': value})
                    return value
                projects = tool('list_projects', {})
                schema = tool('get_node_schema', {})
                assert len(schema['input_schemas']) == 13
                assert 'key' in schema['input_schemas']['apply_nodes']['properties']['nodes']['items']['properties']
                created = tool('create_canvas', {'project_id': 'default', 'title': 'Codex 客户端隔离验证',
                    'expected_revision': projects['revision'], 'operation_id': 'codex-create-fixture'})
                canvas_id = created['canvas_id']
                initial = tool('get_canvas', {'canvas_id': canvas_id})
                edit = {'canvas_id': canvas_id, 'expected_revision': initial['revision'],
                    'operation_id': 'codex-edit-fixture', 'operations': [
                        {'op': 'add_prompt', 'key': 'token', 'text': '真实 Codex MCP 客户端测试', 'x': 10, 'y': 20}]}
                applied = tool('edit_canvas', edit)
                assert applied['node_ids']['token']
                assert tool('edit_canvas', edit) == applied
                after = tool('get_canvas', {'canvas_id': canvas_id})
                assert len(after['canvas']['nodes']) == 1
                undo = {'canvas_id': canvas_id, 'expected_revision': applied['revision'],
                        'operation_id': edit['operation_id']}
                undone = tool('undo_edit', undo)
                assert tool('undo_edit', undo) == undone
                final = tool('get_canvas', {'canvas_id': canvas_id})
                assert final['canvas']['nodes'] == []
                assert len(tool('list_canvases', {'project_id': 'default'})['items']) == 1
                report.update(status='passed', calls=calls, final_node_count=0,
                    discovered_tools=sorted(schema['input_schemas']))
            except Exception as exc:
                report.update(status='failed', error=f'{type(exc).__name__}: {exc}')
                raise
            finally:
                if client:
                    client.close()
                if backend:
                    backend.terminate()
                    backend.wait(timeout=10)
                report['user_config_unchanged'] = config_digest() == original_config
                report['trace'] = [json.loads(line) for line in trace.read_text(encoding='utf-8').splitlines()]
                (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps({key: report[key] for key in ('status', 'codex_version', 'user_config_unchanged')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
