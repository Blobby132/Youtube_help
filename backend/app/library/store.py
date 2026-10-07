"""The media library: one collection of clips and images shared by every project.

    library/library.json      the index (one entry per item, newest first)
    library/clips/<id>.<ext>  the media files
    library/thumbs/<id>.jpg   small thumbnails

Projects refer to items by id, so a clip downloaded once can be used in any number of videos.
Everything enters through `Library.add_clip`, whatever made the file (a Pexels download, an
import, or later an AI shot from ComfyUI).
"""

from __future__ import annotations

import json
import logging
import secrets
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, get_args

from app.core.errors import AppError
from app.core.files import atomic_write_text
from app.library.probe import MediaInfo, make_playable, make_thumbnail, probe
from app.projects.store import utc_now

log = logging.getLogger("shorts.library")

Source = Literal["pexels", "upload", "ai"]
SOURCES: tuple[str, ...] = get_args(Source)

INDEX_FILE = "library.json"
CLIPS_DIR = "clips"
THUMBS_DIR = "thumbs"
INCOMING_DIR = ".incoming"
MAX_NAME = 120
# Below this width a clip has to be scaled up to fill the 1080-pixel-wide frame.
FULL_HD_WIDTH = 1080
_STALE_INCOMING_SECONDS = 6 * 3600

_locks: dict[Path, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(root: Path) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(root.resolve(), threading.RLock())


@dataclass(frozen=True)
class PexelsCredit:
    video_id: int
    url: str
    photographer: str
    photographer_url: str | None = None


@dataclass(frozen=True)
class ClipMetadata:
    """What is known about a file besides its contents."""

    name: str
    ai_generated: bool = False
    original_name: str | None = None
    pexels: PexelsCredit | None = None
    # How an AI shot was made (prompt, model, seed, ...), kept as given.
    generation: dict[str, Any] | None = field(default=None)


def new_item_id() -> str:
    return f"m-{secrets.token_hex(5)}"


def clean_name(name: str) -> str:
    name = " ".join(name.split())[:MAX_NAME]
    return name or "Untitled clip"


class Library:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = _lock_for(root)

    # Paths ---------------------------------------------------------------------------------

    @property
    def index_path(self) -> Path:
        return self.root / INDEX_FILE

    @property
    def incoming_dir(self) -> Path:
        """Where uploads and downloads wait until `add_clip` takes them in."""
        folder = self.root / INCOMING_DIR
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def file_path(self, item_id: str) -> Path:
        path = self.root / CLIPS_DIR / self.get(item_id)["file"]
        if not path.is_file():
            raise AppError(f"The file of library item {item_id} is missing from {path.parent}", 404)
        return path

    def thumbnail_path(self, item_id: str) -> Path:
        thumbnail = self.get(item_id).get("thumbnail")
        path = self.root / THUMBS_DIR / thumbnail if thumbnail else None
        if path is None or not path.is_file():
            raise AppError(f"Library item {item_id} has no thumbnail", 404)
        return path

    # Index ---------------------------------------------------------------------------------

    def _read(self) -> list[dict[str, Any]]:
        if not self.index_path.is_file():
            return []
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
            items = data["items"]
            if not isinstance(items, list):
                raise TypeError("items is not a list")
            return [item for item in items if isinstance(item, dict) and isinstance(item.get("id"), str)]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise AppError(f"The media library index {self.index_path} can't be read: {exc}", 500) from exc

    def _write(self, items: list[dict[str, Any]]) -> None:
        atomic_write_text(self.index_path, json.dumps({"version": 1, "items": items}, indent=2, ensure_ascii=False))

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read()

    def get(self, item_id: str) -> dict[str, Any]:
        for item in self.list():
            if item["id"] == item_id:
                return item
        raise AppError(f"Library item {item_id!r} was not found. Was it deleted?", 404)

    def find_pexels(self, video_id: int) -> dict[str, Any] | None:
        for item in self.list():
            if (item.get("pexels") or {}).get("videoId") == video_id:
                return item
        return None

    def ai_flags(self) -> dict[str, bool]:
        return {item["id"]: bool(item.get("aiGenerated")) for item in self.list()}

    # Changes -------------------------------------------------------------------------------

    def add_clip(
        self,
        file: Path,
        source: Source,
        metadata: ClipMetadata,
        on_progress: Callable[[float], None] | None = None,
    ) -> dict[str, Any]:
        """Adds a video or image file to the library and returns its entry.

        The one way into the library, for every source: it reads the file's size, length and
        codecs, converts it if the browser can't play it, makes a thumbnail and records where it
        came from. The file is moved (or converted) into the library, so pass a temporary copy.
        """
        if source not in SOURCES:
            raise AppError(f"Unknown clip source {source!r}; use one of {', '.join(SOURCES)}.", 400)
        if not file.is_file():
            raise AppError(f"{file} does not exist", 400)

        try:
            info = probe(file)
            item_id = new_item_id()
            clips, thumbs = self.root / CLIPS_DIR, self.root / THUMBS_DIR
            stored = make_playable(file, clips, item_id, info, on_progress)
            try:
                if stored.suffix.lower() != file.suffix.lower() or info.kind == "image":
                    info = probe(stored)  # converting can change the length by a frame
                thumbnail = thumbs / f"{item_id}.jpg"
                make_thumbnail(stored, thumbnail, info)
            except BaseException:
                stored.unlink(missing_ok=True)
                raise
        except AppError as exc:
            # Errors name the temporary file; name the one you picked instead.
            shown = metadata.original_name or file.name
            message = exc.message.replace(str(file), shown).replace(file.name, shown)
            raise AppError(message, exc.status_code) from exc

        item = entry(item_id, stored, thumbnail.name, info, source, metadata)
        with self._lock:
            self._write([item, *self._read()])
        log.info(
            "Added %s to the library: %s (%dx%d, %s, source %s%s)",
            item_id, item["name"], info.width, info.height,
            f"{info.duration:.1f} s" if info.duration else "image", source,
            ", AI-generated" if item["aiGenerated"] else "",
        )
        self.clean_incoming()
        return item

    def update(self, item_id: str, *, name: str | None = None, ai_generated: bool | None = None) -> dict[str, Any]:
        with self._lock:
            items = self._read()
            for item in items:
                if item["id"] != item_id:
                    continue
                if name is not None:
                    item["name"] = clean_name(name)
                if ai_generated is not None:
                    item["aiGenerated"] = ai_generated
                self._write(items)
                return item
        raise AppError(f"Library item {item_id!r} was not found. Was it deleted?", 404)

    def delete(self, item_id: str) -> None:
        with self._lock:
            items = self._read()
            item = next((i for i in items if i["id"] == item_id), None)
            if item is None:
                raise AppError(f"Library item {item_id!r} was not found. Was it deleted?", 404)
            self._write([i for i in items if i["id"] != item_id])
        for path in (self.root / CLIPS_DIR / item["file"], self.root / THUMBS_DIR / (item.get("thumbnail") or "")):
            if path.is_file():
                try:
                    path.unlink()
                except OSError as exc:  # e.g. still open in a player on Windows
                    log.warning("Could not delete %s: %s", path, exc)
        log.info("Deleted %s (%s) from the library", item_id, item.get("name"))

    def clean_incoming(self) -> None:
        """Removes half-finished uploads and downloads left behind by a crash."""
        folder = self.root / INCOMING_DIR
        if not folder.is_dir():
            return
        cutoff = time.time() - _STALE_INCOMING_SECONDS
        for path in folder.iterdir():
            try:
                if path.stat().st_mtime < cutoff:
                    shutil.rmtree(path) if path.is_dir() else path.unlink()
            except OSError:
                pass


def entry(
    item_id: str,
    stored: Path,
    thumbnail: str,
    info: MediaInfo,
    source: str,
    metadata: ClipMetadata,
) -> dict[str, Any]:
    """The JSON entry for one library item (camelCase, like the project file)."""
    pexels = metadata.pexels
    return {
        "id": item_id,
        "kind": info.kind,
        "name": clean_name(metadata.name),
        "file": stored.name,
        "thumbnail": thumbnail,
        "width": info.width,
        "height": info.height,
        "duration": info.duration,
        "fps": info.fps,
        "hasAudio": info.has_audio,
        "size": stored.stat().st_size,
        "source": source,
        # AI shots are always AI-generated; for other sources it's what you said (and you can
        # change it later).
        "aiGenerated": bool(metadata.ai_generated or source == "ai"),
        "lowRes": info.width < FULL_HD_WIDTH,
        "originalName": metadata.original_name,
        "addedAt": utc_now(),
        "pexels": None
        if pexels is None
        else {
            "videoId": pexels.video_id,
            "url": pexels.url,
            "photographer": pexels.photographer,
            "photographerUrl": pexels.photographer_url,
        },
        "generation": metadata.generation,
    }
