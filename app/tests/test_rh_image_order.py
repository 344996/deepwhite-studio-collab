"""F07 (handover 2026-10-26): a missing RH image order is not stored as 0, which outranked 1 and 2."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-rh-order-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import main as core


def order(**raw):
    return core.runninghub_normalize_field({"nodeId": "403", "fieldName": "image", "fieldType": "IMAGE", **raw})["imageOrder"]


class ImageOrderTests(unittest.TestCase):
    def test_zero_is_kept_and_missing_stays_missing(self):
        self.assertEqual(order(imageOrder=0), 0)
        self.assertEqual(order(imageOrder="2"), 2)
        self.assertEqual(order(image_order=1), 1)
        self.assertIsNone(order())
        self.assertIsNone(order(imageOrder=""))

    def test_unreadable_order_is_kept_for_the_request_builder_to_reject(self):
        self.assertEqual(order(imageOrder="first"), "first")

    def test_backend_sort_puts_missing_after_explicit_orders(self):
        fields = [core.runninghub_normalize_field(f) for f in (
            {"nodeId": "9", "fieldName": "image", "fieldType": "IMAGE"},
            {"nodeId": "404", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 1},
            {"nodeId": "403", "fieldName": "image", "fieldType": "IMAGE", "imageOrder": 0})]
        import functools
        ordered = sorted(fields, key=functools.cmp_to_key(core._rh_field_cmp))
        self.assertEqual([f["nodeId"] for f in ordered], ["403", "404", "9"])


if __name__ == "__main__":
    unittest.main()
