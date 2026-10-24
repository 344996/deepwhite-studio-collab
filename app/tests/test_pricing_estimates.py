"""PRICE-01 (handover issue 18): estimates follow the dimensions the bill actually charges.

The evidence mirrors the public pricing data for 2026-10-24; nothing is fetched or generated.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
runtime = tempfile.TemporaryDirectory(prefix="dw-pricing-")
os.environ["DEEPWHITE_STUDIO_RUNTIME_DIR"] = runtime.name
import studio_pricing as pricing

RAW = {
    "pricing_version": "fixture",
    "price_estimates": {
        # One sample, not split by resolution.
        "deepwhiteai-image-nb-2.1-lowprice": {"status": "ready", "active_features": [], "entries": [{"params": {}, "price_cny": 0.072, "sample_count": 2406}]},
        "deepwhiteai-image-nb-2.1": {"status": "ready", "active_features": ["resolution"], "entries": [
            {"params": {"resolution": "1k"}, "price_cny": 0.126}, {"params": {"resolution": "2k"}, "price_cny": 0.147}]},
        "deepwhiteai-image-nb-2-lite": {"status": "ready", "active_features": [], "entries": [{"params": {}, "price_cny": 0.0566}]},
    },
    "observed_prices": {
        # Real bills, split by resolution.
        "deepwhiteai-image-nb-2.1-lowprice": {"entries": [
            {"params": {"metadata.resolution": "1k"}, "price_cny": 0.072}, {"params": {"metadata.resolution": "2k"}, "price_cny": 0.096},
            {"params": {"metadata.resolution": "4k"}, "price_cny": 0.12}]},
        "deepwhiteai-image-nb-2-lite": {"entries": [{"params": {}, "price_cny": 0.0566}]},
    },
}


def quote(model, resolution):
    request = pricing.Quote(provider_id="deepwhite", model=model, kind="image", params={"resolution": resolution, "ratio": "1:1"}, image_count=2)
    return pricing.estimate(RAW, model, request)


class EstimateTests(unittest.TestCase):
    def test_banana_lowprice_follows_resolution(self):
        self.assertAlmostEqual(quote("deepwhiteai-image-nb-2.1-lowprice", "1k")["price"], 0.072)
        self.assertAlmostEqual(quote("deepwhiteai-image-nb-2.1-lowprice", "2k")["price"], 0.096)
        self.assertAlmostEqual(quote("deepwhiteai-image-nb-2.1-lowprice", "4k")["price"], 0.12)

    def test_resolution_without_evidence_is_unknown_not_the_1k_price(self):
        result = quote("deepwhiteai-image-nb-2.1-lowprice", "0.5k")
        self.assertIsNone(result["price"])
        self.assertEqual(result["label"], "暂无可靠估价")

    def test_split_estimates_and_unsplit_models_are_unchanged(self):
        self.assertAlmostEqual(quote("deepwhiteai-image-nb-2.1", "2k")["price"], 0.147)
        lite = quote("deepwhiteai-image-nb-2-lite", "2k")
        self.assertAlmostEqual(lite["price"], 0.0566)
        self.assertIn("尚未细分", lite["note"])


if __name__ == "__main__":
    unittest.main()
