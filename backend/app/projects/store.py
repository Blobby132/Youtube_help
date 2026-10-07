"""File-based project storage.

Each project lives in its own folder, with its own media (voiceovers, music, later renders)
next to its JSON. Video clips live in the shared media library instead (app/library).

    projects/<id>/project.json
    projects/<id>/media/
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core.errors import AppError
from app.core.files import atomic_write_text

log = logging.getLogger("shorts.projects")

PROJECT_FILE = "project.json"
MEDIA_DIR = "media"
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MEDIA_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# Generated media is deleted once the project no longer references it. The grace period
# covers a file that was just created but whose project change hasn't been saved yet.
_GENERATED_PREFIXES = ("voiceover-", "music-")
_GARBAGE_GRACE_SECONDS = 600


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_project_id(project_id: str) -> str:
    if not _ID_PATTERN.fullmatch(project_id):
        raise AppError(f"Invalid project id: {project_id!r}", status_code=400)
    return project_id


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def project_dir(self, project_id: str) -> Path:
        return self.root / validate_project_id(project_id)

    def _project_file(self, project_id: str) -> Path:
        return self.project_dir(project_id) / PROJECT_FILE

    def media_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / MEDIA_DIR

    def media_file(self, project_id: str, name: str) -> Path:
        if not _MEDIA_NAME.fullmatch(name) or ".." in name:
            raise AppError(f"Invalid media file name: {name!r}", 400)
        path = self.media_dir(project_id) / name
        if not path.is_file():
            raise AppError(f"Media file {name} was not found", 404)
        return path

    def list(self) -> list[dict[str, Any]]:
        return [summary for summary, _ in self.list_with_data()]

    def list_with_data(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Every readable project as (summary, full data), newest first."""
        if not self.root.is_dir():
            return []
        found = []
        for path in self.root.glob(f"*/{PROJECT_FILE}"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                log.warning("Skipping unreadable project %s: %s", path, exc)
                continue
            if isinstance(data, dict):
                found.append((summarize(path.parent.name, data), data))
        found.sort(key=lambda pair: pair[0]["updatedAt"] or "", reverse=True)
        return found

    def load(self, project_id: str) -> dict[str, Any]:
        path = self._project_file(project_id)
        if not path.is_file():
            raise AppError(f"Project {project_id!r} was not found", status_code=404)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise AppError(f"Project {project_id!r} is not valid JSON: {exc}", 500) from exc

    def save(self, project_id: str, data: dict[str, Any]) -> dict[str, Any]:
        validate_project_id(project_id)
        if data.get("id") != project_id:
            raise AppError("Project id in the body does not match the URL", status_code=400)
        if not isinstance(data.get("name"), str):
            raise AppError("Project needs a name", status_code=400)

        now = utc_now()
        data = {**data, "updatedAt": now}
        data.setdefault("createdAt", now)

        folder = self.project_dir(project_id)
        folder.mkdir(parents=True, exist_ok=True)
        atomic_write_text(folder / PROJECT_FILE, json.dumps(data, indent=2, ensure_ascii=False))
        collect_garbage(folder / MEDIA_DIR, referenced_media(data))
        return summarize(project_id, data)


def summarize(project_id: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": project_id,
        "name": data.get("name") or "Untitled",
        "createdAt": data.get("createdAt"),
        "updatedAt": data.get("updatedAt"),
    }


def referenced_media(data: dict[str, Any]) -> set[str]:
    files: set[str] = set()
    voiceover = data.get("voiceover")
    if isinstance(voiceover, dict) and isinstance(voiceover.get("file"), str):
        files.add(voiceover["file"])
    music = (data.get("mix") or {}).get("music")
    if isinstance(music, dict) and isinstance(music.get("file"), str):
        files.add(music["file"])
    return files


def collect_garbage(media: Path, referenced: set[str], now: float | None = None) -> None:
    """Deletes old generated voiceovers/music that the project no longer uses, and stale uploads."""
    if not media.is_dir():
        return
    now = time.time() if now is None else now
    for path in media.iterdir():
        name = path.name
        stale_upload = name.startswith(".upload-")
        unused = name.startswith(_GENERATED_PREFIXES) and name not in referenced
        if not (stale_upload or unused) or not path.is_file():
            continue
        try:
            if now - path.stat().st_mtime > (3600 if stale_upload else _GARBAGE_GRACE_SECONDS):
                path.unlink()
                log.info("Removed unused media file %s", path)
        except OSError as exc:
            log.warning("Could not remove %s: %s", path, exc)
