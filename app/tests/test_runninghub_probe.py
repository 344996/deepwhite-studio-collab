"""RunningHub connection probe and app parameter shapes, against a mocked upstream only.

RH-CONNECTION-FALSE-POSITIVE (handover issue 04) and RH-APP-DEMO-SHAPE (issue 05).
No request leaves the process and nothing is submitted or billed.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-rh-probe-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_server
import main as core

BASE = "https://rh.invalid"
REGISTRY = [{"name_en": "nano-banana/text-to-image", "endpoint": "nano-banana/text-to-image", "output_type": "image"}]
NODES = [{"nodeId": "122", "fieldName": "prompt", "fieldValue": "雨夜", "description": "prompt"},
         {"nodeId": "88", "fieldName": "image", "fieldValue": "example.png", "fieldType": "IMAGE"}]
CURL = ("curl --location --request POST 'https://www.runninghub.cn/task/openapi/ai-app/run' \\\n"
        "--header 'Content-Type: application/json' \\\n"
        "--data-raw '" + json.dumps({"webappId": "1877265245566922800", "apiKey": "dummy-key",
                                     "nodeInfoList": NODES}, ensure_ascii=False, indent=4) + "'")


class Upstream:
    def __init__(self):
        self.routes = {}
        self.seen = []

    def __call__(self, request):
        self.seen.append(str(request.url))
        for prefix, reply in self.routes.items():
            if str(request.url).startswith(prefix):
                if isinstance(reply, Exception):
                    raise reply
                return reply
        return httpx.Response(404, json={"code": 404})


class Base(unittest.TestCase):
    def setUp(self):
        self.upstream = Upstream()
        original = httpx.AsyncClient
        provider = {"id": "runninghub", "name": "RunningHub", "base_url": BASE, "protocol": "runninghub",
                    "api_key": "dummy-key", "wallet_api_key": "dummy-key"}
        for item in (
            patch.object(core.httpx, "AsyncClient", side_effect=lambda *a, **kw: original(
                *a, **{**kw, "transport": httpx.MockTransport(self.upstream)})),
            patch.object(core, "runninghub_provider", side_effect=lambda: dict(provider)),
            patch.object(core, "load_api_providers", side_effect=lambda: [core.normalize_provider(dict(provider))]),
            patch.object(core, "provider_env_key_value", side_effect=lambda pid: "dummy-key"),
            patch.object(core, "STATIC_RUNNINGHUB_MODEL_REGISTRY_FILE", os.path.join(runtime.name, "absent.json")),
        ):
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(studio_server.app)
        self.addCleanup(self.client.close)


class ConnectionProbeTests(Base):
    def probe(self):
        response = self.client.post("/api/providers/test-connection", json={
            "provider_id": "runninghub", "protocol": "runninghub", "base_url": BASE, "api_key": "dummy-key"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_rejected_key_is_not_reported_as_connected(self):
        self.upstream.routes = {
            BASE + "/openapi/v2/models": httpx.Response(401, json={"code": 401, "msg": "invalid api key"}),
            core.RUNNINGHUB_MODEL_REGISTRY_URL: httpx.Response(200, json=REGISTRY),
            "https://llm.runninghub.ai": httpx.Response(401, json={"error": "unauthorized"}),
        }
        result = self.probe()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["status"], 401)
        self.assertIn("鉴权失败", result["message"])
        self.assertNotIn("可用", result["message"].split("。")[0])
        self.assertEqual(result["stages"], {"service": True, "auth": "failed", "auth_status": 401, "catalog": "github"})

    def test_accepted_key_passes_only_the_stages_it_completed(self):
        self.upstream.routes = {BASE + "/openapi/v2/models": httpx.Response(200, json=REGISTRY),
                                "https://llm.runninghub.ai": httpx.Response(200, json={"data": []})}
        result = self.probe()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["stages"]["auth"], "ok")
        self.assertEqual(result["stages"]["catalog"], "openapi")
        self.assertIn("鉴权通过", result["message"])

    def test_unreachable_service_is_unverified_not_connected(self):
        self.upstream.routes = {
            BASE + "/openapi/v2/models": httpx.ConnectError("unreachable"),
            core.RUNNINGHUB_MODEL_REGISTRY_URL: httpx.Response(200, json=REGISTRY),
            "https://llm.runninghub.ai": httpx.ConnectError("unreachable"),
        }
        result = self.probe()
        self.assertFalse(result["ok"])
        self.assertEqual(result["stages"]["auth"], "unverified")
        self.assertFalse(result["stages"]["service"])
        self.assertIn("未能核实", result["message"])


class AppShapeTests(Base):
    def app_info(self, data):
        self.upstream.routes = {BASE + "/api/webapp/apiCallDemo": httpx.Response(200, json={"code": 0, "msg": "success", "data": data})}
        return self.client.get("/api/runninghub/app-info", params={"webappId": "1877265245566922800"})

    def test_structured_and_curl_only_shapes_both_yield_parameters(self):
        structured = self.app_info({"webappName": "结构化", "nodeInfoList": NODES, "curl": CURL})
        self.assertEqual(structured.status_code, 200, structured.text)
        self.assertEqual(structured.json()["data"]["nodeInfoList"], NODES)
        self.assertEqual(structured.json()["data"]["fieldSource"], "nodeInfoList")
        curl_only = self.app_info({"webappName": "官方样例", "curl": CURL})
        self.assertEqual(curl_only.status_code, 200, curl_only.text)
        data = curl_only.json()["data"]
        self.assertEqual(data["nodeInfoList"], NODES)
        self.assertEqual(data["fieldSource"], "curl")
        self.assertNotIn("dummy-key", json.dumps(curl_only.json(), ensure_ascii=False))

    def test_preview_reads_curl_only_app_and_names_the_source(self):
        self.upstream.routes = {BASE + "/api/webapp/apiCallDemo": httpx.Response(200, json={
            "code": 0, "data": {"webappName": "官方样例", "curl": CURL}})}
        response = self.client.post("/api/studio/runninghub/workflows/preview",
                                    json={"kind": "app", "source": "1877265245566922800"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([f["fieldName"] for f in body["fields"]], ["prompt", "image"])
        self.assertTrue(any("curl" in note for note in body["diagnostics"]), body["diagnostics"])

    def test_response_without_parameters_gets_a_specific_diagnosis(self):
        for data in ({"webappName": "空"}, {"curl": "curl 'https://x' --data-raw '{not json'"}):
            with self.subTest(data=data):
                response = self.app_info(data)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("没有可识别的参数", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
