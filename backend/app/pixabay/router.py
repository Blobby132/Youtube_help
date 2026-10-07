from __future__ import annotations

import threading
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query

from app.core.config import Settings, get_settings
from app.core.jobs import Job, jobs
from app.library.router import LibraryDep
from app.library.store import Library
from app.pixabay import service
from app.pixabay.client import PixabayClient

router = APIRouter(prefix="/api/pixabay", tags=["pixabay"])


def get_pixabay(settings: Annotated[Settings, Depends(get_settings)]) -> PixabayClient:
    return PixabayClient(settings.pixabay_api_key, settings.data_dir / "cache" / "pixabay")


PixabayDep = Annotated[PixabayClient, Depends(get_pixabay)]

# One download per Pixabay video at a time, so a double click doesn't add it twice.
_downloads: dict[tuple[str, int], str] = {}
_downloads_lock = threading.Lock()


def library_index(library: Library) -> dict[int, str]:
    """Pixabay video id -> library item id, for videos already downloaded."""
    return {
        item["pixabay"]["videoId"]: item["id"]
        for item in library.list()
        if isinstance(item.get("pixabay"), dict) and isinstance(item["pixabay"].get("videoId"), int)
    }


@router.get("/search")
def search(
    pixabay: PixabayDep,
    library: LibraryDep,
    query: Annotated[str, Query(min_length=1, max_length=100)],
    page: Annotated[int, Query(ge=1, le=25)] = 1,
    orientation: Literal["portrait", "landscape", "any"] = "portrait",
) -> dict[str, Any]:
    return service.search(pixabay, query.strip(), orientation, page, library_index(library))


@router.post("/{video_id}/add")
def start_add(video_id: int, pixabay: PixabayDep, library: LibraryDep) -> dict[str, Any]:
    pixabay.require_key()
    key = (str(library.root.resolve()), video_id)
    with _downloads_lock:
        running = jobs.get(_downloads[key]) if key in _downloads else None
        if running and running.status in ("queued", "running"):
            return running.to_dict()

        def work(job: Job) -> dict[str, Any]:
            try:
                return service.add_video(pixabay, library, video_id, job.update, tag=job.id)
            finally:
                with _downloads_lock:
                    _downloads.pop(key, None)

        job = jobs.submit("pixabay", work, pool="media")
        _downloads[key] = job.id
        return job.to_dict()
