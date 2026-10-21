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
from urllib.request import ProxyHandler, Request, build_opener

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
                def http_json(path, method='GET', payload=None):
                    data = None if payload is None else json.dumps(payload).encode('utf-8')
                    with opener.open(Request(base_url + path, data=data, method=method,
                            headers={'Content-Type': 'application/json'}), timeout=20) as response:
                        return json.load(response)
                report['preflight'] = http_json('/api/studio/control/diagnostics', 'POST')
                assert report['preflight']['ok'], report['preflight']
                settings = http_json('/api/studio/control/settings')
                assert '[mcp_servers.deepwhite-studio]' in settings['client_configs']['codex_toml']
                assert 'fixture-token' not in json.dumps(settings)
                # Synthetic offline provider: validate node/tool editing, never generate.
                http_json('/api/providers', 'PUT', [{'id':'codex-fixture','name':'Offline test',
                    'base_url':'https://fixture.invalid/v1','enabled':True,
                    'image_models':['deepwhiteai-image-g-v2.5-lowprice']}])
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
                assert len(schema['input_schemas']) == 17
                status = tool('studio_status', {})
                assert status['ok'], status
                packages = tool('list_canvas_packages', {})
                assert {'film-short', 'avatar-talk'} <= {item['id'] for item in packages['items']}
                imported = tool('import_canvas_package', {'package_id': 'film-short', 'project_id': 'default',
                    'expected_revision': projects['revision'], 'operation_id': 'codex-package-fixture',
                    'variables': {'主题': 'Codex 验证'}})
                assert len(imported['node_ids']) == packages['items'][[i['id'] for i in packages['items']].index('film-short')]['node_count']
                projects = tool('list_projects', {})
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
                assert len(tool('list_canvases', {'project_id': 'default'})['items']) == 2  # package import + created canvas
                available = tool('list_models', {})['items']
                model = next(item for item in available if item['provider_id'] == 'codex-fixture')
                generated = tool('apply_nodes', {'canvas_id':canvas_id, 'expected_revision':final['revision'],
                    'operation_id':'codex-generator-fixture', 'nodes':[{'key':'image', 'kind':'image',
                    'title':'外接 Skill 节点验证','prompt':'雨夜旧车站，柔和电影光线，人物中景',
                    'provider_id':model['provider_id'],'model':model['model'],'params':{},'references':[]}]})
                generator_id = generated['node_ids']['image']
                linked = tool('edit_canvas', {'canvas_id':canvas_id, 'expected_revision':generated['revision'],
                    'operation_id':'codex-link-fixture', 'operations':[
                        {'op':'add_prompt','key':'brief','text':'角色与镜头要求','x':10,'y':20},
                        {'op':'connect','from':'$brief','to':generator_id}]})
                modified = tool('edit_canvas', {'canvas_id':canvas_id, 'expected_revision':linked['revision'],
                    'operation_id':'codex-modify-fixture', 'operations':[
                        {'op':'update_prompt','node_id':linked['node_ids']['brief'],'text':'角色与镜头要求已修改'},
                        {'op':'move_node','node_id':generator_id,'x':500,'y':200}]})
                saved = tool('get_canvas', {'canvas_id':canvas_id})
                assert len(saved['canvas']['connections']) == 1
                assert len(saved['canvas']['nodes']) == 2
                assert saved['revision'] == modified['revision']
                assert any(node.get('text') == '角色与镜头要求已修改' for node in saved['canvas']['nodes'])
                report.update(status='passed', calls=calls, final_node_count=2,
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
