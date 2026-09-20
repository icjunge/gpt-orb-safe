#!/usr/bin/env python3
"""Detect changed release files. An unsigned manifest is not proof of publisher identity."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path, PurePosixPath


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    root = args.directory.resolve()
    manifest = root / "FILE-CHECKSUMS.sha256"
    if not manifest.is_file():
        parser.error("FILE-CHECKSUMS.sha256 was not found in the release directory")
    entries = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        expected, separator, name = line.partition("  ")
        relative = PurePosixPath(name)
        if not separator or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            parser.error("Invalid checksum entry")
        if not name or relative.is_absolute() or ".." in relative.parts or "\\" in name or name in entries:
            parser.error("Invalid or duplicate file path in checksum manifest")
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            parser.error("Checksum entry escapes release directory")
        entries[name] = expected
    failures = []
    for name, expected in entries.items():
        path = root / name
        if not path.is_file():
            failures.append(f"MISSING: {name}")
        elif sha256(path) != expected:
            failures.append(f"CHANGED: {name}")
    known = set(entries) | {"FILE-CHECKSUMS.sha256"}
    for path in root.rglob("*"):
        if path.is_file() and path.relative_to(root).as_posix() not in known:
            failures.append(f"EXTRA: {path.relative_to(root).as_posix()}")
    if failures:
        print("\n".join(failures))
        raise SystemExit(1)
    print(f"Verified {len(entries)} files. This detects changes; it does not authenticate the publisher.")


if __name__ == "__main__":
    main()
