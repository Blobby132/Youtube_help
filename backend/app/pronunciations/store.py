"""The pronunciation list lives in data/pronunciations.json, outside any project, because the
same terms come up in every video."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from app.core.errors import AppError
from app.core.files import atomic_write_text
from app.voiceover.normalize import Pronunciation

log = logging.getLogger("shorts.pronunciations")

FILE_NAME = "pronunciations.json"
MAX_ENTRIES = 500
MAX_WRITTEN = 100
MAX_SPOKEN = 300


class PronunciationStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / FILE_NAME

    def load(self) -> list[Pronunciation]:
        if not self.path.is_file():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return [Pronunciation(str(e.get("written", "")), str(e.get("spoken", ""))) for e in raw["entries"]]
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            # A broken file must not stop voiceovers. Keep a copy, because the next save
            # from the app replaces it.
            backup = self.path.with_suffix(".broken.json")
            log.warning("Ignoring unreadable %s (%s); a copy is kept as %s", self.path, exc, backup.name)
            if not backup.exists():
                shutil.copyfile(self.path, backup)
            return []

    def save(self, entries: list[Pronunciation]) -> list[Pronunciation]:
        if len(entries) > MAX_ENTRIES:
            raise AppError(f"Too many pronunciations (at most {MAX_ENTRIES}).", 400)
        for entry in entries:
            if len(entry.written) > MAX_WRITTEN or len(entry.spoken) > MAX_SPOKEN:
                raise AppError(
                    f"A pronunciation is too long (written text up to {MAX_WRITTEN} characters, "
                    f"spoken up to {MAX_SPOKEN}).",
                    400,
                )
        payload = {"entries": [{"written": e.written, "spoken": e.spoken} for e in entries]}
        atomic_write_text(self.path, json.dumps(payload, indent=2, ensure_ascii=False))
        return entries
