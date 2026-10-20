"""Verify published Windows downloads and real HTTPS updates in isolated installs.

The normal run starts from the published .16 portable ZIP, checks/downloads via
the product HTTP API, upgrades, rolls back and upgrades again. A tagged feed is
overridden only in that extracted old application, never in the real product.
After latest is switched, --verify-stable-existing reuses the stopped fixture,
removes only that recorded override, and checks the product's default feed.
--reuse-old-download accepts a prior public .16 ZIP with its original download
evidence; the product's initial version-ZIP download cache must still be empty.
Browser dependencies can be set with DEEPWHITE_VERIFY_NODE,
DEEPWHITE_VERIFY_PLAYWRIGHT and DEEPWHITE_VERIFY_CHROMIUM.

No credentials, API generation, mocks, prefilled download caches, or live user
configuration writes are used. All artifacts, backups and logs are retained.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import time
from urllib.parse import urljoin, urlsplit
import zipfile

import httpx
import build_windows_release as build
from check_customer_mcp_release import CustomerInstallation, file_digest
from check_portable_release import read, wait_for
from sign_release import canonical

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from studio_update_core import verify_manifest

REPOSITORY = "https://github.com/344996/deepwhite-studio-collab"
DEFAULT_FEED = REPOSITORY + "/releases/latest/download/update-stable.json"
OLD_VERSION = "0.10.2-studio.16"
OLD_NAME = "deepwhite-" + OLD_VERSION + "-windows-x64-portable.zip"
OLD_URL = REPOSITORY + "/releases/download/v" + OLD_VERSION + "/" + OLD_NAME
OLD_SHA256 = "fd34e6d7133e461bcb0ef7965a6ce815ac671db4986cddea29074ebc4f6ce8b5"
OLD_SIZE = 116813066
DOWNLOAD_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
ROOT_NAME = "公开旧版升级 中文 & (保留数据)"
FRESH_NAME = "公开新版直装 中文 & (新客户)"
SENTINEL = "客户自有文件：在线更新与回退均需保留。\n".encode("utf-8")
SOURCE_ROOT = Path(__file__).resolve().parents[1]


class PublicInstallation(CustomerInstallation):
    def __init__(self, root, workspace, report, codex_home, report_name):
        super().__init__(root, workspace, report, codex_home)
        self.report_name = report_name

    def record(self, name, **details):
        self.report["checks"].append({"name": name, "passed": True, **details})
        (self.workspace / self.report_name).write_bytes(canonical(self.report))
        print("Passed:", name, flush=True)

    def install(self, version, phase, action="install"):
        response = self.http.post("/api/studio/updates/install", json={
            "action": action, "saved_and_closed": True,
        })
        response.raise_for_status()
        def completed():
            response = self.http.get("/api/studio/updates/status")
            response.raise_for_status()
            status = response.json()
            if status["phase"] == "failed" or (
                    status["phase"] == "rolled_back" and status.get("error")):
                raise RuntimeError("The actual updater failed: " + str(status.get("error", "")))
            return status if status["phase"] == phase and self.health(version) else False
        return wait_for(completed, timeout=150, label=action + " " + version)

    def restart_current(self, version):
        """Use the customer restart API; never substitute a test process kill."""
        response = self.http.get("/api/studio/updates/status")
        response.raise_for_status()
        before = response.json()
        assert before["current_version"] == version and before["restart_required"] is True
        assert before["supervisor_version"] != version
        assert before["can_install"] is False and before["can_rollback"] is False
        supervisor, server = self.owned("supervisor.json"), self.owned("server-process.json")
        old = {"supervisor_pid": supervisor.pid, "supervisor_created": supervisor.create_time(),
               "server_pid": server.pid, "server_created": server.create_time(),
               "supervisor_version": before["supervisor_version"]}
        data_before = snapshot_files(self.root / "userdata")
        response = self.http.post("/api/studio/updates/restart", json={"saved_and_closed": True})
        response.raise_for_status()
        assert response.json() == {"accepted": True, "phase": "restarting"}

        def completed():
            response = self.http.get("/api/studio/updates/status")
            response.raise_for_status()
            status = response.json()
            if status["phase"] == "failed":
                raise RuntimeError("The actual restart helper failed: " + str(status.get("error", "")))
            return status if (status["phase"] == "restarted"
                              and status.get("restart_required") is False
                              and status.get("supervisor_version") == version
                              and self.health(version)) else False
        status = wait_for(completed, timeout=150, label="customer API hands off to the new supervisor")
        supervisor.wait(timeout=5)
        server.wait(timeout=5)
        assert not supervisor.is_running() and not server.is_running()
        replacement = self.owned("supervisor.json")
        assert replacement.pid != supervisor.pid
        assert Path(replacement.exe()).resolve() == (
            self.root / "versions" / version / "python" / "python.exe"
        ).resolve()
        data_after = snapshot_files(self.root / "userdata")
        assert data_after == data_before, "Customer files changed during the restart-only operation"
        return {"old_processes": old, "new_supervisor_pid": replacement.pid,
                "new_supervisor_created": replacement.create_time(),
                "supervisor_executable": str(Path(replacement.exe()).resolve()),
                "userdata_hashed_files": len(data_after), "userdata_sha256": manifest_digest(data_after),
                "restart_required": status["restart_required"], "old_processes_exited": True}


def snapshot_files(root):
    result = {}
    assert root.is_dir() and not root.is_symlink() and not root.is_junction()
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            path = Path(directory) / name
            assert not path.is_symlink() and not path.is_junction(), "Unexpected filesystem link"
        for name in files:
            path = Path(directory) / name
            assert path.is_file()
            result[path.relative_to(root).as_posix()] = {
                "size": path.stat().st_size, "sha256": build.sha256(path),
            }
    return result


def manifest_digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def signed_package_files(archive_path, artifact):
    assert archive_path.stat().st_size == artifact["size"]
    assert build.sha256(archive_path) == artifact["sha256"]
    result = {}
    with zipfile.ZipFile(archive_path) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = PurePosixPath(entry.filename).as_posix()
            assert name not in result, "Duplicate file in signed version ZIP"
            with archive.open(entry) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            result[name] = {"size": entry.file_size, "sha256": digest}
    return result


def assert_release_unchanged(instance, version, expected, label):
    actual = snapshot_files(instance.root / "versions" / version)
    comparison = {
        "missing": sorted(expected.keys() - actual.keys()),
        "extra": sorted(actual.keys() - expected.keys()),
        "changed": sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name]),
    }
    evidence = instance.workspace / (label + "-release-files.json")
    evidence.write_bytes(canonical({"expected_files": len(expected), "actual_files": len(actual),
                                    "expected_sha256": manifest_digest(expected),
                                    "actual_sha256": manifest_digest(actual), **comparison}))
    assert not any(comparison.values()), "The running release tree differs from its signed ZIP: " + str(comparison)
    return {"files": len(actual), "sha256": manifest_digest(actual), "evidence": evidence.name}


BROWSER_CHECK = r"""
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { chromium } = require(input.playwright);
(async () => {
  const browser = await chromium.launch({
    headless: true, ...(input.chromium ? { executablePath: input.chromium } : {})
  });
  const result = { pages: [], page_errors: [], blocked_external_hosts: [] };
  try {
    const context = await browser.newContext();
    const blocked = new Set();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === input.base || ['data:', 'blob:'].includes(url.protocol)) {
        return route.continue();
      }
      blocked.add(url.hostname);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', error => result.page_errors.push(String(error)));
    for (const path of ['/', '/settings', '/static/index.html', '/static/studio-updates.html']) {
      const response = await page.goto(input.base + path, { waitUntil: 'networkidle', timeout: 30000 });
      if (response.status() !== 200) throw Error(path + ' returned HTTP ' + response.status());
      await page.locator('body').waitFor({ state: 'visible' });
      const item = { path, status: response.status(), title: await page.title() };
      if (path === '/static/studio-updates.html') {
        await page.waitForFunction(expected => {
          const element = document.getElementById('current');
          return element && element.textContent === expected;
        }, input.version);
        item.restart_visible = await page.locator('#restart').isVisible();
        item.restart_enabled = await page.locator('#restart').isEnabled();
        if (item.restart_visible !== input.restartRequired) {
          throw Error('Restart button disagrees with the required supervisor transition');
        }
        if (input.restartRequired && !item.restart_enabled) throw Error('Restart action is disabled');
      }
      result.pages.push(item);
    }
    result.blocked_external_hosts = [...blocked].sort();
    await context.close();
    if (result.page_errors.length) throw Error('Browser page errors: ' + result.page_errors.join('\n'));
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = String(error);
  } finally {
    await browser.close();
  }
  process.stdout.write(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
"""


def browser_visit(instance, version, label, *, restart_required=False):
    node = os.environ.get("DEEPWHITE_VERIFY_NODE") or shutil.which("node")
    playwright = Path(os.environ.get("DEEPWHITE_VERIFY_PLAYWRIGHT", str(
        SOURCE_ROOT.parent / "browser-tools" / "node_modules" / "playwright"
    ))).resolve()
    chromium = os.environ.get("DEEPWHITE_VERIFY_CHROMIUM")
    assert node and Path(node).is_file() and playwright.is_dir(), "Install Node/Playwright for the browser acceptance check"
    result = subprocess.run(
        [node, "-e", BROWSER_CHECK], input=json.dumps({
            "base": instance.base, "version": version, "restartRequired": restart_required,
            "playwright": str(playwright), "chromium": chromium,
        }), text=True, encoding="utf-8", capture_output=True, timeout=150,
        env=instance.environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    evidence = instance.workspace / (label + "-browser.json")
    try:
        report = json.loads(result.stdout)
    except ValueError:
        report = {"passed": False, "returncode": result.returncode,
                  "stdout": result.stdout, "stderr": result.stderr}
    evidence.write_bytes(canonical(report))
    assert result.returncode == 0 and report.get("passed"), (
        "Browser acceptance failed; see " + str(evidence)
    )
    return {"evidence": evidence.name, "pages": len(report["pages"]),
            "external_requests": "blocked, not mocked", "fresh_browser_profile": True}


def valid_public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in DOWNLOAD_HOSTS or parsed.username or parsed.password:
        raise ValueError("Expected an approved public HTTPS release download")
    return parsed


@contextmanager
def public_response(client, url):
    current = url
    for _ in range(6):
        parsed = valid_public_url(current)
        with client.stream("GET", current) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                current = urljoin(current, response.headers["location"])
                continue
            if response.status_code != 200:
                raise RuntimeError(f"Public download HTTP {response.status_code} from {parsed.hostname}")
            # Never put a signed CDN query string in logs or the report.
            yield response, parsed.hostname
            return
    raise RuntimeError("Too many public download redirects")


def get_small(client, url, limit=1024 * 1024):
    chunks, length = [], 0
    with public_response(client, url) as (response, hostname):
        for chunk in response.iter_bytes():
            length += len(chunk)
            if length > limit:
                raise RuntimeError("Published metadata exceeded its size limit")
            chunks.append(chunk)
    return b"".join(chunks), hostname


def download(client, url, destination, expected_size, expected_sha256):
    partial = destination.with_suffix(destination.suffix + ".partial")
    digest, total, displayed = hashlib.sha256(), 0, 0
    print("Downloading public ZIP:", destination.name, flush=True)
    with public_response(client, url) as (response, hostname), partial.open("xb") as stream:
        for chunk in response.iter_bytes(1024 * 1024):
            total += len(chunk)
            if total > expected_size:
                raise RuntimeError("Published ZIP exceeded its recorded size")
            stream.write(chunk)
            digest.update(chunk)
            if total - displayed >= 20 * 1024 * 1024:
                print("Public ZIP bytes:", total, "/", expected_size, flush=True)
                displayed = total
        stream.flush()
        os.fsync(stream.fileno())
    assert total == expected_size and digest.hexdigest() == expected_sha256, (
        "Published ZIP checksum/size did not match the release metadata"
    )
    partial.replace(destination)
    return {"url": url, "final_host": hostname, "size": total, "sha256": digest.hexdigest()}


def unpack(archive_path, installation, expected_version):
    assert not installation.exists()
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert {"Start.cmd", "Start.ps1", "current.json", "userdata/", "updates/"} <= set(names)
        for name in names:
            path = PurePosixPath(name)
            assert not path.is_absolute() and ".." not in path.parts
            assert "\\" not in name and ":" not in name
            assert (installation / name).resolve().is_relative_to(installation)
            if name.startswith("versions/"):
                relative_to_version = PurePosixPath(*path.parts[2:]).as_posix()
                assert not build.forbidden(relative_to_version), (
                    "Unexpected private/runtime data in public ZIP"
                )
        archive.extractall(installation)
    assert read(installation / "current.json")["version"] == expected_version


def checksums(raw):
    result = {}
    for line in raw.decode("utf-8-sig").splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        assert len(digest) == 64 and all(character in "0123456789abcdef" for character in digest)
        result[name.lstrip("*").strip()] = digest
    return result


def publication_metadata(publication):
    built = read(publication / "build-report.json")
    manifest_raw = (publication / "update-stable.json").read_bytes()
    envelope = json.loads(manifest_raw)
    local_sums = checksums((publication / "SHA256SUMS.txt").read_bytes())
    signed = envelope["signed"]
    assert signed["version"] == built["version"] and signed["commit"] == built["commit"]
    portable_name, = [name for name in built["files"] if name.endswith("-portable.zip")]
    portable = built["files"][portable_name]
    assert portable["sha256"] == local_sums[portable_name]
    version_name = signed["artifact"]["url"].rsplit("/", 1)[1]
    assert signed["artifact"]["sha256"] == local_sums[version_name]
    assert signed["artifact"]["size"] == built["files"][version_name]["size"]
    assert hashlib.sha256(manifest_raw).hexdigest() == local_sums["update-stable.json"]
    trust = read(Path(__file__).resolve().parents[1] / "app" / "update-trust.json")
    verify_manifest(envelope, trust, current=OLD_VERSION)
    return built, envelope, manifest_raw, local_sums, portable_name


def verify_public_metadata(client, feed, expected_raw, expected_sums, artifact_url, workspace, prefix):
    actual, host = get_small(client, feed)
    assert actual == expected_raw, "Public signed manifest differs from the approved publication"
    (workspace / (prefix + "-public-manifest.json")).write_bytes(actual)
    checksum_url = artifact_url.rsplit("/", 1)[0] + "/SHA256SUMS.txt"
    remote_sums, sums_host = get_small(client, checksum_url)
    assert checksums(remote_sums) == expected_sums
    (workspace / (prefix + "-public-SHA256SUMS.txt")).write_bytes(remote_sums)
    return {"manifest_url": feed, "manifest_final_host": host,
            "checksums_url": checksum_url, "checksums_final_host": sums_host}


def check_update(instance, expected_version):
    response = instance.http.post("/api/studio/updates/check", timeout=90)
    response.raise_for_status()
    status = response.json()
    assert status["latest_version"] == expected_version
    assert status["phase"] in {"available", "latest"}
    return status


def real_download(instance, signed):
    cache = instance.root / "updates" / "downloads"
    assert not cache.exists() or not any(cache.iterdir()), "Initial download cache must be empty"
    response = instance.http.post("/api/studio/updates/download")
    response.raise_for_status()
    progress, previous = [], [None, -1]
    def completed():
        response = instance.http.get("/api/studio/updates/status")
        response.raise_for_status()
        status = response.json()
        phase, received = status["phase"], status.get("bytes", 0)
        if phase != previous[0] or received - previous[1] > 20 * 1024 * 1024:
            progress.append({"phase": phase, "bytes": received, "at": int(time.time())})
            previous[:] = [phase, received]
            print("Update download:", phase, received, flush=True)
        if phase.endswith("_failed"):
            raise RuntimeError("The actual update API reported " + phase)
        return status if phase == "ready" else False
    status = wait_for(completed, timeout=600, label="real HTTPS product download")
    artifact = signed["artifact"]
    downloaded = cache / (artifact["sha256"] + ".zip")
    assert downloaded.stat().st_size == artifact["size"]
    assert build.sha256(downloaded) == artifact["sha256"]
    assert status["bytes"] == artifact["size"]
    return {"origin_url": artifact["url"], "cache_initially_empty": True,
            "size": artifact["size"], "sha256": artifact["sha256"], "progress": progress}


def verify_backup(instance, status):
    backup = instance.root / "updates" / "backups" / status["backup"]
    assert backup.resolve().is_relative_to(instance.root / "updates" / "backups")
    manifest = read(backup / "manifest.json")
    actual = {}
    for path in (backup / "userdata").rglob("*"):
        assert not path.is_symlink()
        if path.is_file():
            actual[path.relative_to(backup / "userdata").as_posix()] = {
                "size": path.stat().st_size, "sha256": build.sha256(path),
            }
    assert actual == manifest["files"]
    assert (backup / "userdata" / "verification-sentinel.txt").read_bytes() == SENTINEL
    assert (instance.root / "userdata" / "verification-sentinel.txt").read_bytes() == SENTINEL
    return {"backup": status["backup"], "hashed_files": len(actual)}


def reuse_old_public_download(archive):
    archive = archive.resolve()
    assert archive.name == OLD_NAME and archive.stat().st_size == OLD_SIZE
    assert build.sha256(archive) == OLD_SHA256
    evidence = archive.parent.parent / "verification.json"
    previous = read(evidence)["old_portable_download"]
    assert previous["url"] == OLD_URL and previous["size"] == OLD_SIZE
    assert previous["sha256"] == OLD_SHA256 and previous["final_host"] in DOWNLOAD_HOSTS
    return {"url": OLD_URL, "final_host": previous["final_host"], "size": OLD_SIZE,
            "sha256": OLD_SHA256, "reused_verified_public_zip": str(archive),
            "original_download_evidence": str(evidence)}


def run(publication, workspace, feed_url=DEFAULT_FEED, stable_existing=False,
        resume_downloads=False, reuse_old_download=None):
    assert os.name == "nt", "This verifier requires Windows portable launchers"
    publication, workspace = publication.resolve(), workspace.resolve()
    built, envelope, manifest_raw, sums, portable_name = publication_metadata(publication)
    version, signed = built["version"], envelope["signed"]
    valid_public_url(feed_url)
    assert not urlsplit(feed_url).query, "Use a clean public release feed URL"
    report_name = "stable-verification.json" if stable_existing else "verification.json"
    previous = None
    assert not (stable_existing and resume_downloads)
    assert not (stable_existing and reuse_old_download)
    reused_old = reuse_old_public_download(reuse_old_download) if reuse_old_download else None
    if stable_existing:
        assert feed_url == DEFAULT_FEED
        previous = read(workspace / "verification.json")
        assert previous["passed"] and previous["commit"] == built["commit"]
        assert previous["portable_sha256"] == sums[portable_name]
        assert not (workspace / report_name).exists(), "Previous stable evidence must be preserved"
    elif resume_downloads:
        previous = read(workspace / "verification.json")
        assert not previous["passed"] and previous["commit"] == built["commit"]
        assert not (workspace / ROOT_NAME).exists() and not (workspace / FRESH_NAME).exists()
        # An explicit retry can reuse only complete, verified public downloads,
        # never the application's update cache or a partially extracted install.
        for name, expected_size, expected_digest in (
            (OLD_NAME, OLD_SIZE, OLD_SHA256),
            (portable_name, built["files"][portable_name]["size"], sums[portable_name]),
        ):
            artifact = (reuse_old_download if name == OLD_NAME and reuse_old_download
                        else workspace / "public-downloads" / name)
            assert artifact.stat().st_size == expected_size
            assert build.sha256(artifact) == expected_digest
        archive = workspace / ("verification-before-retry-" + str(time.time_ns()) + ".json")
        (workspace / "verification.json").rename(archive)
    else:
        assert not workspace.exists(), "Use a new verification workspace"
        # Retain the old/new trees, prepared tree, two fresh reinstallation
        # stages, fresh install, both public ZIPs and an update download.
        needed = (signed["artifact"]["unpacked_size"] * 6 + signed["artifact"]["size"]
                  + built["files"][portable_name]["size"] + (0 if reused_old else OLD_SIZE)
                  + 500 * 1024**2)
        storage = workspace.parent
        while not storage.exists():
            storage = storage.parent
        assert shutil.disk_usage(storage).free > needed, (
            f"At least {needed} free bytes are needed to retain all verification evidence"
        )
        workspace.mkdir(parents=True, exist_ok=False)
    root, fresh = workspace / ROOT_NAME, workspace / FRESH_NAME
    actual_config = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    config_before = file_digest(actual_config)
    report = {"passed": False, "checks": [], "version": version, "commit": built["commit"],
              "portable_sha256": sums[portable_name], "feed_url": feed_url,
              "mode": "stable-existing" if stable_existing else "published-chain",
              "https_transport": "real", "mock_transport_used": False,
              "provider_generation_used": False, "inference_used": False,
              "other_computer_verified": False}
    instance = fresh_instance = None
    try:
        with httpx.Client(timeout=httpx.Timeout(60, connect=30), trust_env=False,
                          headers={"User-Agent": "DeepWhite-public-release-verification"}) as client:
            report["public_metadata"] = verify_public_metadata(
                client, feed_url, manifest_raw, sums, signed["artifact"]["url"],
                workspace, "stable" if stable_existing else "tagged",
            )
            if not stable_existing:
                downloads = workspace / "public-downloads"
                if resume_downloads:
                    report["old_portable_download"] = previous["old_portable_download"]
                    report["new_portable_download"] = previous["new_portable_download"]
                    report["verified_public_downloads_reused_after_verifier_failure"] = True
                else:
                    downloads.mkdir()
                    report["old_portable_download"] = reused_old or download(
                        client, OLD_URL, downloads / OLD_NAME, OLD_SIZE, OLD_SHA256)
                    new_url = signed["artifact"]["url"].rsplit("/", 1)[0] + "/" + portable_name
                    report["new_portable_download"] = download(
                        client, new_url, downloads / portable_name,
                        built["files"][portable_name]["size"], sums[portable_name],
                    )
                unpack(reuse_old_download or downloads / OLD_NAME, root, OLD_VERSION)
                unpack(downloads / portable_name, fresh, version)

        instance = PublicInstallation(root, workspace, report, workspace / "isolated-codex", report_name)
        instance.record("Real public manifest signature, published checksums and HTTPS downloads verified")
        override = root / "versions" / OLD_VERSION / "app" / "update-config.json"
        if stable_existing:
            if previous.get("feed_override_sha256"):
                assert override.is_file() and file_digest(override) == previous["feed_override_sha256"]
                assert override.resolve().is_relative_to(root.resolve())
                override.unlink()  # Only the exact fixture override written by this verifier.
            assert not override.exists()
            assert not (root / "versions" / version / "app" / "update-config.json").exists()
            report["fixture_feed_override_removed"] = True
        elif feed_url != DEFAULT_FEED:
            assert not override.exists()
            override.write_bytes(canonical({"manifest_url": feed_url, "channel": "stable"}))
            report["feed_override_sha256"] = file_digest(override)
            report["fixture_feed_override"] = "old extracted app only"

        instance.launch()
        initial_version = version if stable_existing else OLD_VERSION
        wait_for(lambda: instance.health(initial_version), label="published portable startup")
        if stable_existing:
            before, after = previous["before_canvas"], previous["after_canvas"]
            instance.assert_canvas(before)
            instance.assert_canvas(after)
            assert check_update(instance, version)["phase"] == "latest"
            instance.record("Published new version checks the default latest feed without an override")
            status = instance.install(OLD_VERSION, "rolled_back", action="rollback")
            verify_backup(instance, status)
        else:
            before = instance.canvas("公网更新前创建 · 保留项目")
            (root / "userdata" / "verification-sentinel.txt").write_bytes(SENTINEL)
            report["before_canvas"] = before
            instance.record("Published old portable starts with its bundled runtime, isolated data and a saved canvas")

        assert check_update(instance, version)["phase"] == "available"
        assert read(root / "updates" / "available.json") == envelope
        instance.record("Published old runtime verifies the real signed manifest and advertises the update",
                        default_feed=feed_url == DEFAULT_FEED)
        if not stable_existing:
            report["product_download"] = real_download(instance, signed)
            instance.record("Product HTTP update API downloads and verifies the actual public version ZIP",
                            cache_initially_empty=True, size=signed["artifact"]["size"])
        else:
            archive = root / "updates" / "downloads" / (signed["artifact"]["sha256"] + ".zip")
            assert archive.stat().st_size == signed["artifact"]["size"]
            assert build.sha256(archive) == signed["artifact"]["sha256"]
            report["previously_verified_download_reused"] = True
        archive = root / "updates" / "downloads" / (signed["artifact"]["sha256"] + ".zip")
        expected_files = signed_package_files(archive, signed["artifact"])

        status = instance.install(version, "installed")
        backup = verify_backup(instance, status)
        instance.assert_canvas(before)
        instance.record("Actual supervisor installs the published update and verifies its full data backup", **backup)
        if stable_existing:
            instance.assert_canvas(after)
            assert status["restart_required"] is False and status["supervisor_version"] == version
        else:
            after = instance.canvas("公网更新后创建 · 回退也要保留")
            report["after_canvas"] = after
            # Exercise the real product handoff before rollback. Killing the
            # fixture supervisor here would hide an unusable customer flow.
            browser = browser_visit(instance, version, "before-restart", restart_required=True)
            unchanged = assert_release_unchanged(instance, version, expected_files, "before-restart")
            instance.record("Updated app exposes the restart action and browser visits preserve signed files",
                            browser=browser, release=unchanged)
            restarted = instance.restart_current(version)
            instance.assert_canvas(before)
            instance.assert_canvas(after)
            instance.record("Customer restart API gracefully exits the old processes and starts the new supervisor",
                            **restarted)
            assert_release_unchanged(instance, version, expected_files, "after-customer-restart")
            status = instance.install(OLD_VERSION, "rolled_back", action="rollback")
            backup = verify_backup(instance, status)
            instance.assert_canvas(before)
            instance.assert_canvas(after)
            instance.record("Manual rollback to published old version preserves pre-update and new work", **backup)
            assert check_update(instance, version)["phase"] == "available"
            status = instance.install(version, "installed")
            backup = verify_backup(instance, status)
            instance.assert_canvas(before)
            instance.assert_canvas(after)
            assert status["restart_required"] is False and status["supervisor_version"] == version
            assert instance.owned("supervisor.json").pid == restarted["new_supervisor_pid"]
            instance.record("Re-upgrade preserves both canvases and reuses the unchanged running version in place",
                            **backup, supervisor_pid=restarted["new_supervisor_pid"])
        instance.stop()
        instance.launch()
        wait_for(lambda: instance.health(version), label="updated portable restart")
        instance.assert_canvas(before)
        instance.assert_canvas(after)
        assert (root / "userdata" / "verification-sentinel.txt").read_bytes() == SENTINEL
        instance.record("Restart retains the selected version, both canvases and the customer sentinel")
        label = "stable-reopened" if stable_existing else "tagged-reopened"
        browser = browser_visit(instance, version, label)
        unchanged = assert_release_unchanged(instance, version, expected_files, label)
        instance.record("Reopened updated installation renders in Chromium without changing any signed file",
                        browser=browser, release=unchanged)

        fresh_instance = PublicInstallation(
            fresh, workspace, report, workspace / "isolated-fresh-codex", report_name
        )
        fresh_instance.launch()
        wait_for(lambda: fresh_instance.health(version), label="fresh public portable")
        assert fresh_instance.http.get("/settings").status_code == 200
        assert fresh_instance.http.get("/api/studio/control/codex").json()["state"] == "missing"
        assert (fresh / "客户使用说明.txt").is_file()
        assert (fresh / "versions" / version / "references" / "docs" / "客户安装与Codex连接.md").is_file()
        if stable_existing:
            assert check_update(fresh_instance, version)["phase"] == "latest"
        fresh_instance.record("Fresh public portable starts with customer guides and automatic Codex setup",
                              default_latest_checked=stable_existing)
        label = "stable-fresh" if stable_existing else "tagged-fresh"
        browser = browser_visit(fresh_instance, version, label)
        unchanged = assert_release_unchanged(fresh_instance, version, expected_files, label)
        fresh_instance.record("Fresh public installation renders in Chromium and exactly matches the signed version ZIP",
                              browser=browser, release=unchanged)
        assert file_digest(actual_config) == config_before
        report["passed"] = True
    except Exception as exc:
        # URLs with signed CDN query parameters are intentionally not serialized.
        report["failure_type"] = type(exc).__name__
        raise
    finally:
        stopped = False
        try:
            if fresh_instance:
                fresh_instance.stop()
            if instance:
                instance.stop()
            stopped = True
        finally:
            for item in (instance, fresh_instance):
                if item:
                    item.http.close()
            report["real_user_config_unchanged"] = file_digest(actual_config) == config_before
            report["temporary_processes_stopped"] = stopped
            if not stopped or not report["real_user_config_unchanged"]:
                report["passed"] = False
            (workspace / report_name).write_bytes(canonical(report))
    assert report["real_user_config_unchanged"]
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publication", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feed-url", default=DEFAULT_FEED)
    parser.add_argument("--verify-stable-existing", action="store_true")
    parser.add_argument("--resume-downloaded", action="store_true",
                        help="Retry a verifier failure before extraction, rechecking preserved public ZIPs")
    parser.add_argument("--reuse-old-download", type=Path,
                        help="Reuse a previous verified public .16 ZIP and its adjacent verification evidence")
    args = parser.parse_args()
    result = run(args.publication, args.workspace, args.feed_url,
                 args.verify_stable_existing, args.resume_downloaded, args.reuse_old_download)
    print(json.dumps(result, ensure_ascii=False, indent=2))
