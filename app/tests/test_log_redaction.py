"""F04 (handover 2026-10-26): logs never carry signed links or credentials from upstream replies."""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
runtime = tempfile.TemporaryDirectory(prefix='dw-log-redaction-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR'] = runtime.name
import main as core

RAW = {'code': 805, 'msg': 'failed', 'data': [{'fileUrl': 'https://rh-images.invalid/out.png?X-Amz-Signature=sig789&X-Amz-Credential=cred9',
                                             'apiKey': 'rh-secret-key-123', 'note': 'see https://cdn.invalid/a.png?token=tok456'}]}


class LogRedactionTests(unittest.TestCase):
    def logged(self, call):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            call()
        return buffer.getvalue()

    def test_runninghub_error_log_hides_signatures_and_keys(self):
        text = self.logged(lambda: core.log_runninghub_error('query-failed', RAW, taskId='t-1'))
        for secret in ('sig789', 'cred9', 'X-Amz-Signature', 'rh-secret-key-123', 'tok456'):
            self.assertNotIn(secret, text)
        self.assertIn('https://rh-images.invalid/out.png', text, 'the useful part of the link was lost')
        self.assertIn('query-failed', text)

    def test_log_safe_helper_is_used_for_raw_dumps(self):
        self.assertEqual(core.log_safe({'apiKey': 'k', 'url': 'https://x.invalid/a?sig=1'}), {'apiKey': '[已隐藏]', 'url': 'https://x.invalid/a'})


if __name__ == '__main__':
    unittest.main()
