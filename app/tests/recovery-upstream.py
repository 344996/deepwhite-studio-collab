"""Test-only fake platform in its own process, so killing the studio leaves requests truly in flight.

Every paid POST is recorded before any reply. Per endpoint group the reply can be: ok, hang (record,
then wait so the studio can be killed mid-request), drop (record, then close the socket without an
answer: the platform accepted it but the response is lost) or down (close without recording, like
a dead network). POST /__mode changes behaviour; GET /__state reads what was received.
"""
import base64
import json
import os
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')
LOCK = threading.Lock()
STATE = {'posts': [], 'polls': [], 'uploads': [], 'media': [],
         'mode': {'post': 'ok', 'poll': 'ok', 'upload': 'ok', 'media': 'ok', 'mj': 'ok'}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body, status=200, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def behave(self, group, record):
        mode = STATE['mode'][group]
        if mode == 'down':
            self.connection.shutdown(socket.SHUT_RDWR)
            return False
        with LOCK:
            record()
        if mode == 'hang':
            time.sleep(120)
            return False
        if mode == 'drop':
            self.connection.shutdown(socket.SHUT_RDWR)
            return False
        return True

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        if self.path == '/__mode':
            STATE['mode'].update(json.loads(body))
            return self.reply({'mode': STATE['mode']})
        if self.path.endswith('/files/upload'):
            if self.behave('upload', lambda: STATE['uploads'].append(len(body))):
                self.reply({'data': {'url': 'https://cdn.recovery.invalid/upload/%d.png' % len(STATE['uploads']), 'expires_in': 3600}})
            return
        if '/midjourney/' in self.path:
            if self.behave('mj', lambda: STATE['posts'].append({'path': self.path})):
                self.reply({'data': {'task_id': 'mj-%d' % len(STATE['posts']), 'status': 'IN_PROGRESS'}})
            return
        if self.behave('post', lambda: STATE['posts'].append({'path': self.path, 'prompt': json.loads(body or b'{}').get('prompt', '')})):
            self.reply({'data': [{'id': 'task-%d' % len(STATE['posts'])}]})

    def do_GET(self):
        if self.path == '/__state':
            return self.reply(STATE)
        if self.path.startswith('/media/'):
            if self.behave('media', lambda: STATE['media'].append(self.path)):
                self.reply(PNG, kind='image/png')
            return
        match = re.search(r'/image/generations/([^/?]+)$', self.path)
        if match:
            task = match.group(1)
            if not self.behave('poll', lambda: STATE['polls'].append(task)):
                return
            done = STATE['mode'].get('poll_result', 'succeeded')
            if done == 'running':
                return self.reply({'data': {'status': 'running', 'progress': '40%'}})
            return self.reply({'data': {'status': 'succeeded', 'progress': '100%', 'image_urls': ['https://cdn.recovery.invalid/media/%s.png' % task]}})
        self.reply({'error': 'unknown fake path ' + self.path}, 404)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler)
    server.daemon_threads = True
    server.serve_forever()
