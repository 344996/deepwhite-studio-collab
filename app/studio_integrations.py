"""Locate shipped external-agent integrations (Skills and canvas packages).

Source checkouts keep them in <repo>/integrations; the Windows release copies
them to app/references/integrations (see scripts/build_windows_release.py).
"""
from pathlib import Path

APP = Path(__file__).resolve().parent


def root():
    for candidate in (APP.parent / "integrations", APP / "references" / "integrations"):
        if candidate.is_dir():
            return candidate
    return APP.parent / "integrations"


def skills_root():
    return root() / "skills"


def packages_root():
    return root() / "packages"
