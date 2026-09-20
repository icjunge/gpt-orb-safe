#!/usr/bin/env python3
"""Package source and browser-extension archives; retain legacy portable packaging.

Requires Python 3.10+. Run: python scripts/package_windows.py --source-only --extension-zip
Version 2.1+ Windows installers are built separately with npm run build:win.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import urllib.request
import zipfile


PROJECT = Path(__file__).resolve().parent.parent
LOCK = json.loads((PROJECT / "scripts/runtime-lock.json").read_text(encoding="utf-8"))
EXCLUDED_PARTS = {"__pycache__", "node_modules", "vendor", "build", "dist"}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def commit_file(partial: Path, target: Path) -> None:
    """Durably finish writes before publishing the final filename."""
    with partial.open("r+b") as handle:
        handle.flush()
        os.fsync(handle.fileno())
    partial.replace(target)
    if hasattr(os, "O_DIRECTORY"):
        descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def write_text(target: Path, contents: str) -> None:
    partial = target.with_name(target.name + ".partial")
    partial.write_text(contents, encoding="utf-8")
    commit_file(partial, target)


def verified_download(spec: dict, target: Path) -> None:
    if target.is_file() and digest(target) == spec["sha256"]:
        print(f"Verified cached {target.name}", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    print(f"Downloading {target.name}", flush=True)
    with urllib.request.urlopen(spec["url"], timeout=90) as response, partial.open("wb") as handle:
        shutil.copyfileobj(response, handle, length=1024 * 1024)
    if digest(partial) != spec["sha256"]:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Electron archive checksum mismatch")
    commit_file(partial, target)


def permitted_file(path: Path, directory: Path) -> bool:
    relative = path.relative_to(directory)
    return (path.is_file() and not path.is_symlink()
            and not any(part.startswith(".") or part in EXCLUDED_PARTS for part in relative.parts)
            and path.suffix not in {".pyc", ".pyo"})


def copy_tree(source: Path, destination: Path) -> None:
    for path in sorted(source.rglob("*")):
        if permitted_file(path, source):
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def verify_extension() -> None:
    manifest = json.loads((PROJECT / "extension/manifest.json").read_text(encoding="utf-8"))
    identity = json.loads((PROJECT / "extension-identity.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3 or manifest.get("key") != identity["publicKey"]:
        raise RuntimeError("Extension identity or manifest version mismatch")
    package = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))
    if manifest.get("version") != package["version"]:
        raise RuntimeError("Extension and application versions do not match")
    key_bytes = base64.b64decode(identity["publicKey"], validate=True)
    expected_id = "".join(chr(ord("a") + int(character, 16)) for character in hashlib.sha256(key_bytes).hexdigest()[:32])
    if identity["id"] != expected_id:
        raise RuntimeError("Extension public key does not match its fixed ID")
    expected_keys = {"manifest_version", "name", "version", "minimum_chrome_version",
                     "description", "key", "permissions", "host_permissions", "optional_host_permissions",
                     "background", "action", "content_security_policy"}
    if set(manifest) != expected_keys:
        raise RuntimeError("Unexpected extension manifest schema")
    if manifest.get("permissions", []) != ["activeTab", "scripting", "storage", "alarms"]:
        raise RuntimeError("Unexpected extension permission")
    if manifest.get("host_permissions", []) != ["http://127.0.0.1/*"]:
        raise RuntimeError("Unexpected extension host permission")
    if manifest.get("optional_host_permissions", []) != ["https://chatgpt.com/*"]:
        raise RuntimeError("Unexpected optional extension host permission")
    if manifest.get("externally_connectable") or manifest.get("web_accessible_resources"):
        raise RuntimeError("Unexpected externally exposed extension resource")


def copy_app(destination: Path) -> None:
    destination.mkdir(parents=True)
    for name in ("src", "assets", "extension"):
        copy_tree(PROJECT / name, destination / name)
    for name in ("package.json", "extension-identity.json", "LICENSE", "README.md", "README.html", "SECURITY.md"):
        shutil.copy2(PROJECT / name, destination / name)


def finish_archive(partial: Path, final: Path) -> None:
    with zipfile.ZipFile(partial) as archive:
        bad_entry = archive.testzip()
        if bad_entry:
            raise RuntimeError(f"Archive CRC verification failed: {bad_entry}")
    checksum = digest(partial)
    commit_file(partial, final)
    write_text(final.with_suffix(".zip.sha256"), f"{checksum}  {final.name}\n")
    print(f"Built {final} ({final.stat().st_size:,} bytes)\nSHA256 {checksum}", flush=True)


def source_archive(output_dir: Path, version: str) -> Path:
    name = f"GPT-Orb-{version}-Source"
    target = output_dir / f"{name}.zip"
    partial = target.with_suffix(".zip.partial")
    files = []
    for entry in ("package.json", "package-lock.json", "extension-identity.json", "README.md", "README.html", "SECURITY.md", "LICENSE", "CHANGELOG.md", "UPDATE.txt", "UPDATES.md", "RELEASE.md", "electron-builder.yml", "update-config.json", ".gitignore", ".gitattributes"):
        path = PROJECT / entry
        if path.is_file():
            files.append(path)
    for entry in ("src", "assets", "extension", "scripts", "test", ".github"):
        directory = PROJECT / entry
        files.extend(path for path in directory.rglob("*") if permitted_file(path, directory))
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(set(files)):
            archive.write(path, PurePosixPath(name) / path.relative_to(PROJECT).as_posix())
    finish_archive(partial, target)
    return target


def extension_archive(output_dir: Path, version: str) -> Path:
    """Build a small update usable with the existing 2.0.0 desktop program."""
    verify_extension()
    target = output_dir / f"GPT-Orb-{version}-Browser-Extension.zip"
    partial = target.with_suffix(".zip.partial")
    directory = PROJECT / "extension"
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(directory.rglob("*")):
            if permitted_file(path, directory):
                archive.write(path, PurePosixPath("Browser-Extension") / path.relative_to(directory).as_posix())
        archive.write(PROJECT / "UPDATE.txt", "UPDATE.txt")
        archive.write(PROJECT / "LICENSE", "LICENSE.txt")
    finish_archive(partial, target)
    return target


def write_manifest(staging: Path) -> None:
    lines = []
    for path in sorted(staging.rglob("*")):
        if path.is_file() and path.name != "FILE-CHECKSUMS.sha256":
            lines.append(f"{digest(path)}  {path.relative_to(staging).as_posix()}")
    write_text(staging / "FILE-CHECKSUMS.sha256", "\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=PROJECT.parent / "build")
    parser.add_argument("--output", type=Path, default=PROJECT.parent / "artifacts")
    parser.add_argument("--no-zip", action="store_true")
    parser.add_argument("--source-zip", action="store_true")
    parser.add_argument("--extension-zip", action="store_true", help="Also build a small browser-extension update")
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    args.cache, args.output = args.cache.resolve(), args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    package = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))
    if args.source_only:
        source_archive(args.output, package["version"])
        if args.extension_zip:
            extension_archive(args.output, package["version"])
        return
    if tuple(int(part) for part in package["version"].split(".")) >= (2, 1, 0):
        raise RuntimeError("Version 2.1+ uses the NSIS installer: run npm run build:win. Use --source-only for source/extension archives.")
    verify_extension()
    release_name = f"GPT-Orb-{package['version']}-Windows-x64"
    staging = args.output / release_name
    if staging.exists():
        if staging.parent != args.output or staging.name != release_name or staging.is_symlink():
            raise RuntimeError("Invalid release staging path")
        shutil.rmtree(staging)
    spec = LOCK["electron"]
    archive = args.cache / spec["archive"]
    verified_download(spec, archive)
    with zipfile.ZipFile(archive) as runtime:
        for entry in runtime.infolist():
            relative = PurePosixPath(entry.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Invalid path in Electron runtime archive")
        runtime.extractall(staging)
        for entry in runtime.infolist():
            if not entry.is_dir() and (staging / entry.filename).stat().st_size != entry.file_size:
                raise RuntimeError(f"Incomplete runtime extraction: {entry.filename}")
    (staging / "electron.exe").rename(staging / "GPT-Orb.exe")
    (staging / "resources/default_app.asar").unlink(missing_ok=True)
    copy_app(staging / "resources/app")
    copy_tree(PROJECT / "extension", staging / "Browser-Extension")
    for name in ("README.md", "README.html", "SECURITY.md"):
        shutil.copy2(PROJECT / name, staging / name)
    shutil.copy2(PROJECT / "LICENSE", staging / "APP-LICENSE.txt")
    shutil.copy2(PROJECT / "scripts/verify_release.py", staging / "Verify-Release.py")
    write_text(staging / "RUNTIME-VERSIONS.json", json.dumps(LOCK, indent=2) + "\n")
    write_manifest(staging)
    print(f"Assembled {staging}", flush=True)
    if args.source_zip:
        source_archive(args.output, package["version"])
    if args.extension_zip:
        extension_archive(args.output, package["version"])
    if args.no_zip:
        return
    final = args.output / f"{release_name}.zip"
    partial = final.with_suffix(".zip.partial")
    print(f"Compressing {final.name}", flush=True)
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for item in sorted(staging.rglob("*")):
            if item.is_file():
                output.write(item, item.relative_to(args.output))
    finish_archive(partial, final)


if __name__ == "__main__":
    main()
