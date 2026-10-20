"""A fresh runtime must not import/register retired agents, while MCP still saves."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = r'''
import json,sys
import studio_server, studio_control
from fastapi.testclient import TestClient
client=TestClient(studio_server.app,base_url='http://127.0.0.1')
routes={}
for path,method in [
    ('/api/studio/agent/bootstrap?canvas_id=fixture','get'),
    ('/api/studio/agent/sessions','get'),
    ('/api/studio/agent/sessions','post'),
    ('/api/studio/agent/sessions/fixture/apply','post'),
    ('/api/chat/agent','post'),
]:
    response=getattr(client,method)(path,**({'json':{}} if method=='post' else {}))
    routes[method+' '+path]=response.status_code
settings=studio_control._load()
settings['enabled']=True
studio_control._save(settings)
def call(name,arguments):
    response=client.post('/api/studio/control/call',
        json={'name':name,'arguments':arguments},
        headers={'Authorization':'Bearer '+settings['token']})
    assert response.status_code==200,response.text
    return response.json()['result']
projects=call('list_projects',{})
created=call('create_canvas',{'project_id':'default','title':'Isolated runtime',
    'expected_revision':projects['revision'],'operation_id':'runtime-create-fixture'})
initial=call('get_canvas',{'canvas_id':created['canvas_id']})
edit=call('edit_canvas',{'canvas_id':created['canvas_id'],
    'expected_revision':initial['revision'],'operation_id':'runtime-edit-fixture',
    'operations':[{'op':'add_prompt','key':'brief','text':'独立外接智能体','x':10,'y':20}]})
saved=call('get_canvas',{'canvas_id':created['canvas_id']})
print(json.dumps({
    'routes':routes,
    'agent_modules':[name for name in sys.modules if name.startswith('studio_agent')],
    'saved_text':saved['canvas']['nodes'][0]['text'],
    'revision_matches':saved['revision']==edit['revision'],
    'skill_download':client.get('/api/studio/control/skill').status_code,
},ensure_ascii=False))
client.close()
'''


class ExternalAgentRuntimeTests(unittest.TestCase):
    def test_retired_routes_are_absent_and_mcp_edit_is_durable(self):
        with tempfile.TemporaryDirectory(prefix="dw-external-agent-runtime-") as runtime:
            result = subprocess.run([sys.executable, "-X", "utf8", "-B", "-c", SCRIPT],
                cwd=ROOT, env=dict(os.environ, DEEPWHITE_STUDIO_RUNTIME_DIR=runtime,
                                  PYTHONDONTWRITEBYTECODE="1"),
                capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(all(status == 404 for status in report["routes"].values()), report["routes"])
            self.assertEqual(report["agent_modules"], [])
            self.assertEqual(report["saved_text"], "独立外接智能体")
            self.assertTrue(report["revision_matches"])
            self.assertEqual(report["skill_download"], 200)


if __name__ == "__main__":
    unittest.main()
