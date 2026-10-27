"""Handover 2026-10-26, section 9: a running paid task survives a killed process or a lost network.

Two real processes: the studio (tests/recovery-studio-server.py) and a fake platform
(tests/recovery-upstream.py). The studio is hard-killed (TerminateProcess / SIGKILL) while a request
is genuinely in flight, then restarted on the same data. Each case checks the three outcomes the
report distinguishes: not submitted (safe to submit), submitted but unconfirmed (never resubmitted
automatically), and a known task (recovered by query only). The paid POST count must stay at one.
Nothing leaves this machine and nothing is billed.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'deepwhiteai-image-g-v2.5-lowprice'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class CrashRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = tempfile.TemporaryDirectory(prefix='dw-crash-recovery-')
        cls.up_port, cls.port = free_port(), free_port()
        cls.upstream = subprocess.Popen([sys.executable, '-B', str(ROOT / 'tests/recovery-upstream.py'), str(cls.up_port)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.studio = None
        cls.start_studio()

    @classmethod
    def tearDownClass(cls):
        cls.kill_studio()
        cls.upstream.kill(); cls.upstream.wait()
        cls.runtime.cleanup()

    @classmethod
    def start_studio(cls):
        env = {**os.environ, 'DEEPWHITE_STUDIO_RUNTIME_DIR': cls.runtime.name, 'DEEPWHITE_STUDIO_PORT': str(cls.port),
               'RECOVERY_UPSTREAM_PORT': str(cls.up_port), 'PYTHONUTF8': '1'}
        cls.log = open(Path(cls.runtime.name) / 'studio.log', 'ab')
        cls.studio = subprocess.Popen([sys.executable, '-B', str(ROOT / 'tests/recovery-studio-server.py')], cwd=ROOT, env=env,
                                      stdout=cls.log, stderr=subprocess.STDOUT)
        for _ in range(150):
            try:
                if httpx.get(f'http://127.0.0.1:{cls.port}/api/studio/health', timeout=1).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise AssertionError('studio did not start: ' + (Path(cls.runtime.name) / 'studio.log').read_text(errors='replace')[-2000:])

    @classmethod
    def kill_studio(cls):
        if cls.studio and cls.studio.poll() is None:
            cls.studio.kill()  # TerminateProcess on Windows: no shutdown handlers run
            cls.studio.wait()
        if getattr(cls, 'log', None):
            cls.log.close()

    def restart(self):
        type(self).kill_studio()
        type(self).start_studio()

    # -- helpers ----------------------------------------------------------------------------
    def api(self, method, path, body=None, status=None):
        r = httpx.request(method, f'http://127.0.0.1:{self.port}{path}', json=body, timeout=30)
        if status is not None:
            self.assertEqual(r.status_code, status, r.text)
        return r

    def mode(self, **mode):
        httpx.post(f'http://127.0.0.1:{self.up_port}/__mode', json=mode, timeout=5)

    def upstream_state(self):
        return httpx.get(f'http://127.0.0.1:{self.up_port}/__state', timeout=5).json()

    def posts(self, marker):
        return [p for p in self.upstream_state()['posts'] if marker in p.get('prompt', '') or marker in p.get('path', '')]

    def wait(self, check, what, timeout=40):
        end = time.time() + timeout
        while time.time() < end:
            value = check()
            if value:
                return value
            time.sleep(0.25)
        self.fail('timed out waiting for ' + what)

    def submit(self, marker, references=()):
        rid = 'rec-' + uuid.uuid4().hex[:12]
        body = {'request_id': rid, 'provider_id': 'dw', 'model': MODEL, 'kind': 'image',
                'prompt': f'雨夜的老城修表铺 {marker}', 'params': {}, 'references': list(references)}
        self.api('POST', '/api/studio/generations', body, 200)
        return rid, body

    def job(self, rid):
        return self.api('GET', f'/api/studio/generations/{rid}', status=200).json()

    def setUp(self):
        self.mode(post='ok', poll='ok', upload='ok', media='ok', mj='ok', poll_result='succeeded')

    # -- killed process -----------------------------------------------------------------------
    def test_killed_before_the_paid_post_submits_once_after_restart(self):
        # Not submitted: the reference upload is still in flight when the process dies.
        self.mode(upload='hang')
        rid, _ = self.submit('K1', [{'url': '/api/storage-files/generated/recovery-ref.png', 'kind': 'image'}])
        self.wait(lambda: self.upstream_state()['uploads'], 'the upload to reach the platform')
        self.restart()
        self.assertEqual(self.posts('K1'), [], 'a paid POST happened before the kill')
        self.mode(upload='ok')
        done = self.wait(lambda: (lambda j: j if j['status'] in ('succeeded', 'failed', 'uncertain') else None)(self.job(rid)), 'the job to finish')
        self.assertEqual(done['status'], 'succeeded', done.get('error'))
        self.assertEqual(len(self.posts('K1')), 1)
        self.assertTrue(all(o['url'].startswith('/') for o in done['outputs']), done['outputs'])

    def test_killed_during_the_paid_post_is_uncertain_and_never_resubmitted(self):
        # Submitted but unconfirmed: the platform has the POST, the reply never arrives.
        self.mode(post='hang')
        rid, body = self.submit('K2')
        self.wait(lambda: self.posts('K2'), 'the paid POST to reach the platform')
        self.restart()
        self.mode(post='ok')
        for _ in range(3):
            job = self.job(rid)
            time.sleep(1)
        self.assertEqual(job['status'], 'uncertain', job)
        self.assertIn('核', job['error'])
        self.assertEqual(self.api('POST', f'/api/studio/generations/{rid}/resume').status_code, 409)
        again = self.api('POST', '/api/studio/generations', body, 200).json()
        self.assertEqual(again['status'], 'uncertain')
        time.sleep(2)
        self.assertEqual(len(self.posts('K2')), 1, 'the unconfirmed submit was sent again')

    def test_killed_after_the_receipt_recovers_by_query_only(self):
        # Known task: the receipt was saved, the process dies while polling.
        self.mode(poll_result='running')
        rid, _ = self.submit('K3')
        self.wait(lambda: self.job(rid).get('task_ids'), 'the receipt to be saved')
        task = self.job(rid)['task_ids'][0]
        self.restart()
        self.mode(poll_result='succeeded')
        done = self.wait(lambda: (lambda j: j if j['status'] in ('succeeded', 'failed', 'uncertain', 'paused') else None)(self.job(rid)), 'the job to finish')
        self.assertEqual(done['status'], 'succeeded', done.get('error'))
        self.assertEqual(done['task_ids'], [task])
        self.assertEqual(len(self.posts('K3')), 1)

    def test_killed_while_saving_the_result_downloads_again_without_a_new_post(self):
        self.mode(media='hang')
        rid, _ = self.submit('K4')
        self.wait(lambda: self.upstream_state()['media'], 'the result download to start')
        self.restart()
        self.mode(media='ok')
        done = self.wait(lambda: (lambda j: j if j['status'] in ('succeeded', 'failed', 'uncertain', 'paused') else None)(self.job(rid)), 'the job to finish')
        self.assertEqual(done['status'], 'succeeded', done.get('error'))
        self.assertEqual(len(self.posts('K4')), 1)

    # -- lost network ------------------------------------------------------------------------
    def test_lost_reply_to_the_paid_post_is_uncertain_without_retry(self):
        self.mode(post='drop')
        rid, _ = self.submit('N1')
        job = self.wait(lambda: (lambda j: j if j['status'] != 'running' and j['status'] != 'queued' else None)(self.job(rid)), 'the submit to fail')
        self.assertEqual(job['status'], 'uncertain', job)
        time.sleep(5)  # longer than one poll interval: nothing retries on its own
        self.assertEqual(len(self.posts('N1')), 1)
        self.assertEqual(self.api('POST', f'/api/studio/generations/{rid}/resume').status_code, 409)

    def test_offline_network_is_not_submitted_and_can_be_sent_once_later(self):
        # The connection never opened, so the platform cannot have the request: this is "not
        # submitted", not "unconfirmed", and continuing later sends it exactly once.
        offline = Path(self.runtime.name) / 'recovery-offline'
        offline.write_text('1')
        try:
            rid, _ = self.submit('N2')
            job = self.wait(lambda: (lambda j: j if j['status'] not in ('running', 'queued') else None)(self.job(rid)), 'the submit to stop')
        finally:
            offline.unlink()
        self.assertEqual(self.posts('N2'), [])
        self.assertEqual(job['status'], 'paused', job)
        self.assertIn('没有发出', job['error'])
        self.api('POST', f'/api/studio/generations/{rid}/resume', status=200)
        done = self.wait(lambda: (lambda j: j if j['status'] in ('succeeded', 'failed', 'uncertain') else None)(self.job(rid)), 'the job to finish')
        self.assertEqual(done['status'], 'succeeded', done.get('error'))
        self.assertEqual(len(self.posts('N2')), 1)

    def test_connection_cut_after_sending_stays_unconfirmed(self):
        # The socket opened and closed before any reply: the request may have been read.
        self.mode(post='down')
        rid, _ = self.submit('N4')
        job = self.wait(lambda: (lambda j: j if j['status'] not in ('running', 'queued') else None)(self.job(rid)), 'the submit to stop')
        self.assertEqual(job['status'], 'uncertain', job)
        self.assertEqual(self.api('POST', f'/api/studio/generations/{rid}/resume').status_code, 409)

    def test_poll_outage_pauses_then_resume_queries_the_same_task(self):
        self.mode(poll='drop')
        rid, _ = self.submit('N3')
        job = self.wait(lambda: (lambda j: j if j['status'] == 'paused' else None)(self.job(rid)), 'the job to pause')
        self.assertIn('不会重新生成', job['error'])
        task = job['task_ids'][0]
        self.mode(poll='ok')
        self.api('POST', f'/api/studio/generations/{rid}/resume', status=200)
        done = self.wait(lambda: (lambda j: j if j['status'] in ('succeeded', 'failed') else None)(self.job(rid)), 'the job to finish')
        self.assertEqual(done['status'], 'succeeded', done.get('error'))
        self.assertEqual(done['task_ids'], [task])
        self.assertEqual(len(self.posts('N3')), 1)

    # -- MJ ----------------------------------------------------------------------------------
    def test_mj_killed_during_submit_is_found_by_attempt_and_never_resubmitted(self):
        self.mode(mj='hang')
        attempt = 'mj-attempt-' + uuid.uuid4().hex[:10]
        body = {'provider_id': 'dw', 'action': 'imagine', 'params': {'prompt': '雨夜的老城修表铺 M1'}, 'attempt_id': attempt}
        before = len(self.posts('/midjourney/'))
        with self.assertRaises(httpx.HTTPError):
            httpx.post(f'http://127.0.0.1:{self.port}/api/studio/mj/submit', json=body, timeout=3)
        self.wait(lambda: len(self.posts('/midjourney/')) > before, 'the MJ POST to reach the platform')
        self.restart()
        self.mode(mj='ok')
        found = self.api('GET', f'/api/studio/mj/attempts/{attempt}', status=200).json()
        self.assertEqual((found['found'], found['status'], found['task_id']), (True, 'uncertain', ''))
        self.assertEqual(self.api('POST', '/api/studio/mj/submit', body).status_code, 409)
        self.assertEqual(len(self.posts('/midjourney/')), before + 1)


if __name__ == '__main__':
    unittest.main()
