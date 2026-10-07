from __future__ import annotations

import threading
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query

from app.core.config import Settings, get_settings
from app.core.jobs import Job, jobs
from app.library.router import LibraryDep
from app.library.store import Library
from app.pexels.client import PexelsClient, summarize_search
from app.pexels.service import add_video

router = APIRouter(prefix="/api/pexels", tags=["pexels"])


def get_pexels(settings: Annotated[Settings, Depends(get_settings)]) -> PexelsClient:
    return PexelsClient(settings.pexels_api_key)


PexelsDep = Annotated[PexelsClient, Depends(get_pexels)]

# One download per Pexels video at a time, so a double click doesn't add it twice.
_downloads: dict[tuple[str, int], str] = {}
_downloads_lock = threading.Lock()


def library_index(library: Library) -> dict[int, str]:
    """Pexels video id -> library item id, for videos already downloaded."""
    return {
        item["pexels"]["videoId"]: item["id"]
        for item in library.list()
        if isinstance(item.get("pexels"), dict) and isinstance(item["pexels"].get("videoId"), int)
    }


@router.get("/search")
def search(
    pexels: PexelsDep,
    library: LibraryDep,
    query: Annotated[str, Query(min_length=1, max_length=100)],
    page: Annotated[int, Query(ge=1, le=100)] = 1,
    orientation: Literal["portrait", "any"] = "portrait",
) -> dict[str, Any]:
    data = pexels.search(query.strip(), page=page, orientation=None if orientation == "any" else orientation)
    return summarize_search(data, library_index(library), portrait_first=orientation == "any")


@router.post("/{video_id}/add")
def start_add(video_id: int, pexels: PexelsDep, library: LibraryDep) -> dict[str, Any]:
    pexels.require_key()
    key = (str(library.root.resolve()), video_id)
    with _downloads_lock:
        running = jobs.get(_downloads[key]) if key in _downloads else None
        if running and running.status in ("queued", "running"):
            return running.to_dict()

        def work(job: Job) -> dict[str, Any]:
            try:
                return add_video(pexels, library, video_id, job.update, tag=job.id)
            finally:
                with _downloads_lock:
                    _downloads.pop(key, None)

        job = jobs.submit("pexels", work, pool="media")
        _downloads[key] = job.id
        return job.to_dict()
