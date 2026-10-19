# Windows portable releases

Run the builder on Windows with a development Python environment containing pip
and the repository's pinned `cryptography` dependency. The shipped interpreter is
the official CPython 3.13.16 AMD64 embeddable distribution. Runtime packages come
from `requirements.lock.txt`, downloaded as compatible binary wheels from PyPI;
the builder verifies every wheel against the corresponding PyPI release digest,
checks the full dependency closure, and invokes the bundled interpreter to test
its imports and the release signature. It never copies host site-packages.

Prepare the cache without producing a release:

```powershell
& ./.venv/Scripts/python.exe scripts/build_windows_release.py --cache D:/DeepWhiteBuildCache --prepare-only
```

Create an Ed25519 signing key once, in a directory outside all Git worktrees:

```powershell
& ./.venv/Scripts/python.exe scripts/sign_release.py create-key --private-key C:/PrivateReleaseKeys/deepwhite-stable.pem --key-id deepwhite-stable-2026 --public-output app/update-trust.json
```

Back up that private file securely. Keep it out of installation packages and
source control. The signing command refuses an existing key file; the public key
ID cannot silently replace an existing trust entry. Commit only the public trust
file with the release source.

Commit the completed app, version/release documents and bootstrap templates.
Use an explicit commit when building; uncommitted changes and user runtime data
are excluded. The output directory must be new or empty:

```powershell
& ./.venv/Scripts/python.exe scripts/build_windows_release.py --ref COMMIT --cache D:/DeepWhiteBuildCache --output D:/DeepWhiteReleases/VERSION --private-key C:/PrivateReleaseKeys/deepwhite-stable.pem --key-id deepwhite-stable-2026 --sequence 2026101901 --notes-file D:/DeepWhiteReleases/release-notes.txt
```

The release directory contains a complete portable ZIP, a version ZIP, signed
`update-stable.json`, `SHA256SUMS.txt`, and a local `build-report.json`. The version
ZIP has `app/`, `python/`, `references/`, `LICENSE`, `README.md` and `release.json`
at its root. Its signed unpacked size is the exact sum of file sizes. The portable
ZIP additionally has the stable launchers, version pointer and empty data/update
directories. The build report includes the local staging path for diagnostics;
it is not an installation file. Stage folders and failed downloads remain in the
external build cache for inspection.

Only the two ZIPs, signed manifest and checksum list belong in a GitHub release.
The default artifact URL uses the `vVERSION` tag; the app's stable feed is
`https://github.com/344996/deepwhite-studio-collab/releases/latest/download/update-stable.json`.
Keep `sequence` increasing for every published manifest, including a reissued
manifest for the same version. Manifests expire after 90 days; publishing the
files is a separate action from building them.

Checks before publishing:

```powershell
& ./.venv/Scripts/python.exe -m unittest discover -s scripts/tests -v
& ./.venv/Scripts/python.exe scripts/check_windows_launcher.py --runtime D:/DeepWhiteBuildCache/python-3.13.16-embed-amd64.zip --workspace D:/DeepWhiteEvidence/NEW-LAUNCHER-CHECK
```

The launcher check runs both actual Windows entrypoints under a path containing
Chinese text, spaces, ampersands, exclamation marks, parentheses and an apostrophe,
with system Python absent from PATH. It records arguments and the bundled Python
path, and verifies a duplicate version field is rejected. Also extract the final
portable ZIP into a fresh writable directory, verify the served version and own
installation identity, repeat the launch to confirm a single server, and perform
the update/rollback rehearsal using temporary data. A local build does not prove
GitHub publication or real provider generation.
