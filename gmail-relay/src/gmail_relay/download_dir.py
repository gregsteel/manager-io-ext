"""Jailed scratch-file allocation for in-flight attachment downloads.

Email attachment filenames are attacker-influenced (any sender can pick one),
so rather than sanitizing and re-verifying a caller-supplied name, every path
this allocates is a fresh uuid4 stem inside the jail directory — a caller-
supplied filename/mimeType is never used to construct a path at all."""

from __future__ import annotations

import uuid
from pathlib import Path


class JailedTempFile:
    def __init__(self, jail_dir: Path) -> None:
        self._jail_dir = jail_dir.resolve()
        self._jail_dir.mkdir(parents=True, exist_ok=True)
        self._stem = uuid.uuid4().hex

    def named(self, suffix: str) -> Path:
        return self._jail_dir / f"{self._stem}{suffix}"

    def cleanup(self) -> None:
        for path in self._jail_dir.glob(f"{self._stem}*"):
            path.unlink(missing_ok=True)
