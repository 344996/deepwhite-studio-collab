"""HTTP-level static delivery checks; runtime and fixture data are isolated."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from starlette.applications import Starlette
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from studio_static import VersionedStaticFiles


class StaticDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="deepwhite-static-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.static = self.root / "static"
        self.static.mkdir()
        self.html = self.static / "canvas.html"
        self.original = '<!doctype html><title>画布</title><script src="/static/app.js?v=old"></script>\n'.encode()
        self.html.write_bytes(self.original)
        self.script = self.static / "app.js"
        self.script.write_bytes(b"const loaded = true;\n")
        self.binary = self.static / "image.bin"
        self.binary.write_bytes(b"\x89PNG\r\n\x1a\n\xff\x00")
        (self.root / "outside.html").write_text("outside-secret", encoding="utf-8")
        self.version = "0.11.0-studio.6"
        self.delivery = VersionedStaticFiles(
            directory=self.static,
            transform=lambda text: text.replace("?v=old", "?v=" + self.version),
        )
        app = Starlette()
        app.mount("/static", self.delivery)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.static.iterdir()}

    def tearDown(self):
        # Every HTTP case, including conditionals and HEAD, must leave the
        # installed source bytes and modification times unchanged.
        for name, (content, modified) in self.before.items():
            target = self.static / name
            self.assertEqual(target.read_bytes(), content)
            self.assertEqual(target.stat().st_mtime_ns, modified)

    def test_get_versions_html_without_touching_disk(self):
        result = self.client.get("/static/canvas.html?ignored=1")
        self.assertEqual(result.status_code, 200)
        self.assertIn("?v=" + self.version, result.text)
        self.assertNotIn("?v=old", result.text)
        self.assertEqual(result.headers["cache-control"], "no-cache")
        self.assertEqual(result.headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(int(result.headers["content-length"]), len(result.content))
        self.assertNotIn("last-modified", result.headers)
        self.assertNotIn("accept-ranges", result.headers)

    def test_conditional_cache_depends_on_rendered_version_not_disk_mtime(self):
        first = self.client.get("/static/canvas.html")
        same = self.client.get("/static/canvas.html", headers={"If-None-Match": first.headers["etag"]})
        self.assertEqual(same.status_code, 304)
        self.assertEqual(same.content, b"")
        self.assertEqual(same.headers["cache-control"], "no-cache")
        weak = self.client.get("/static/canvas.html", headers={"If-None-Match": "W/" + first.headers["etag"]})
        self.assertEqual(weak.status_code, 304)
        self.version = "0.11.0-studio.7"
        changed = self.client.get("/static/canvas.html", headers={"If-None-Match": first.headers["etag"]})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], first.headers["etag"])
        self.assertIn("?v=" + self.version, changed.text)
        future = self.client.get("/static/canvas.html", headers={"If-Modified-Since": "Thu, 31 Dec 2099 23:59:59 GMT"})
        self.assertEqual(future.status_code, 200, "disk dates cannot validate a transformed HTML representation")

    def test_head_has_get_headers_but_no_asgi_body(self):
        get = self.client.get("/static/canvas.html")
        head = self.client.head("/static/canvas.html")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        for name in ("content-length", "content-type", "cache-control", "etag"):
            self.assertEqual(head.headers[name], get.headers[name])

        async def capture():
            messages = []
            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                     "method": "HEAD", "path": "/canvas.html", "root_path": "",
                     "query_string": b"", "headers": [], "scheme": "http"}
            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}
            async def send(message):
                messages.append(message)
            await self.delivery(scope, receive, send)
            return messages
        messages = asyncio.run(capture())
        self.assertEqual(b"".join(item.get("body", b"") for item in messages), b"")
        self.assertEqual(dict(messages[0]["headers"])[b"content-length"], get.headers["content-length"].encode())

    def test_non_html_keeps_static_file_cache_range_and_binary_bytes(self):
        result = self.client.get("/static/image.bin")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, self.binary.read_bytes())
        self.assertIn("last-modified", result.headers)
        self.assertIn("accept-ranges", result.headers)
        self.assertEqual(self.client.get("/static/image.bin", headers={"If-None-Match": result.headers["etag"]}).status_code, 304)
        ranged = self.client.get("/static/image.bin", headers={"Range": "bytes=0-3"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.content, b"\x89PNG")
        self.assertEqual(self.client.head("/static/image.bin").content, b"")
        self.assertEqual(self.client.get("/static/app.js").content, self.script.read_bytes())

    def test_methods_missing_files_and_encoded_traversal_remain_rejected(self):
        for url in ("/static/missing.html", "/static/%2e%2e/outside.html",
                    "/static/%2e%2e%5coutside.html", "/static/%00.html"):
            with self.subTest(url=url):
                result = self.client.get(url)
                self.assertEqual(result.status_code, 404)
                self.assertNotIn("outside-secret", result.text)
        result = self.client.post("/static/canvas.html")
        self.assertEqual(result.status_code, 405)
        self.assertEqual(result.headers["allow"], "GET, HEAD")

    def test_external_symlink_cannot_bypass_staticfiles_lookup(self):
        link = self.static / "escape.html"
        try:
            link.symlink_to(self.root / "outside.html")
        except (OSError, NotImplementedError):
            self.skipTest("The current OS account cannot create a file symlink.")
        result = self.client.get("/static/escape.html")
        self.assertEqual(result.status_code, 404)
        self.assertNotIn("outside-secret", result.text)

    def test_directory_html_mode_keeps_redirect_and_custom_404_behavior(self):
        nested = self.static / "nested"
        nested.mkdir()
        (nested / "index.html").write_bytes(self.original)
        (self.static / "404.html").write_text("fixture not found", encoding="utf-8")
        app = Starlette()
        app.mount("/static", VersionedStaticFiles(
            directory=self.static, html=True,
            transform=lambda text: text.replace("?v=old", "?v=" + self.version),
        ))
        with TestClient(app) as client:
            redirect = client.get("/static/nested", follow_redirects=False)
            self.assertEqual(redirect.status_code, 307)
            self.assertTrue(redirect.headers["location"].endswith("/static/nested/"))
            result = client.get("/static/nested/")
            self.assertEqual(result.status_code, 200)
            self.assertIn("?v=" + self.version, result.text)
            missing = client.get("/static/absent")
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(missing.text, "fixture not found")


INTEGRATION = r'''
import hashlib,json,os,sys
from pathlib import Path
from unittest.mock import patch
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root))
before={str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(),path.stat().st_mtime_ns)
        for path in (root/"static").rglob("*.html")}
attempted=[]
def audit(event,args):
    if event!="open" or not args or not isinstance(args[0],(str,bytes,os.PathLike)):
        return
    mode=args[1] or ""
    flags=args[2] if len(args)>2 and isinstance(args[2],int) else 0
    writing=any(char in str(mode) for char in "wax+") or bool(flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
    if writing:
        target=Path(os.fsdecode(args[0])).resolve()
        if target.is_relative_to(root):
            attempted.append(str(target.relative_to(root)))
            raise PermissionError("The test guards the installed source against writes.")
sys.addaudithook(audit)
import studio_server
import main as core
from starlette.testclient import TestClient
def forbidden(*args,**kwargs):
    raise AssertionError("External network calls are forbidden by this static delivery test.")
import httpx,requests,urllib.request
with patch.object(requests.sessions.Session,"request",forbidden), \
     patch.object(httpx.AsyncClient,"send",forbidden), \
     patch.object(urllib.request.OpenerDirector,"open",forbidden):
    with TestClient(studio_server.app) as client:
        current=core.current_app_version()
        pages=["/","/static/canvas.html","/static/smart-canvas.html","/static/index.html","/static/angle.html"]
        for url in pages:
            response=client.get(url)
            assert response.status_code==200,(url,response.status_code)
            assert response.headers["cache-control"]=="no-cache",url
            assert "?v="+current in response.text,url
        # Import maps, CSS imports and query/fragment preservation use the
        # production renderer, not a duplicate implementation in the test.
        sample="""<script type="importmap">{"imports":{"three":"/static/no-file.js?v=old"}}</script>
<link href="/static/no-file.css?theme=dark&amp;v=old&amp;lang=zh#part">
<script src="/static/no-file.js?lang=zh&v=old#frag"></script>
<a href="/static/no-file.html?mode=test">Open</a>
<script src="https://else.example/static/no-file.js?v=old"></script>"""
        rendered=core.versioned_static_html(sample)
        assert '"/static/no-file.js?v='+current+'"' in rendered
        assert '?theme=dark&amp;v='+current+'&amp;lang=zh#part' in rendered
        assert '?lang=zh&v='+current+'#frag' in rendered
        assert '?mode=test&v='+current in rendered
        assert 'https://else.example/static/no-file.js?v=old' in rendered
after={str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(),path.stat().st_mtime_ns)
       for path in (root/"static").rglob("*.html")}
assert before==after,"Installed HTML bytes or timestamps changed"
assert not attempted,attempted
print(json.dumps({"passed":True,"pages":pages,"immutable_html_files":len(before),"blocked_source_writes":attempted}))
'''


class MainStaticIntegrationTests(unittest.TestCase):
    def test_actual_startup_and_direct_pages_leave_installed_html_immutable(self):
        with tempfile.TemporaryDirectory(prefix="deepwhite-static-runtime-") as folder:
            environment = dict(os.environ, DEEPWHITE_STUDIO_RUNTIME_DIR=str(Path(folder) / "runtime"),
                               CODEX_HOME=str(Path(folder) / "codex"),
                               PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
            environment.pop("DEEPWHITE_INSTALL_ROOT", None)
            result = subprocess.run([sys.executable, "-B", "-c", INTEGRATION, str(ROOT)],
                                    env=environment, cwd=ROOT, text=True, encoding="utf-8",
                                    capture_output=True, timeout=60,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-3000:])
            report = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(report["passed"])
            self.assertGreater(report["immutable_html_files"], 10)
            self.assertEqual(report["blocked_source_writes"], [])
            print(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    unittest.main()
