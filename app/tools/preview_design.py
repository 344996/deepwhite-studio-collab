"""Serve only static design assets on loopback, without starting product engines."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
import argparse

ROOT = Path(__file__).resolve().parents[1] / 'static'

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/static/design-v0.3/index.html')
            self.end_headers()
            return
        if not path.startswith('/static/'):
            self.send_error(404)
            return
        relative = path[len('/static/'):]
        target = (ROOT / relative).resolve()
        if not target.is_relative_to(ROOT.resolve()) or not target.is_file():
            self.send_error(404)
            return
        self.path = '/' + relative
        super().do_GET()

    def do_HEAD(self):
        self.send_error(405)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=3870)
    args=parser.parse_args()
    print(f'http://127.0.0.1:{args.port}/static/design-v0.3/index.html',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
