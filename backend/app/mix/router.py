from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, File, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.core.errors import AppError
from app.core.media import probe_duration
from app.core.uploads import save_upload
from app.projects.router import StoreDep
from app.voiceover.service import new_media_name

router = APIRouter(tags=["mix"])

# Formats browsers can play directly, so the file is kept as uploaded.
MUSIC_EXTENSIONS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"})
MAX_MUSIC_BYTES = 200 << 20


@router.post("/api/projects/{project_id}/music/upload")
async def upload_music(
    project_id: str,
    store: StoreDep,
    file: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    media = store.media_dir(project_id)
    temp = await save_upload(file, media, MUSIC_EXTENSIONS, MAX_MUSIC_BYTES, "music")
    try:
        duration = await run_in_threadpool(probe_duration, temp)
        if duration < 1:
            raise AppError("That music file is shorter than a second.", 400)
        name = new_media_name("music", temp.suffix)
        temp.replace(media / name)
    finally:
        temp.unlink(missing_ok=True)
    return {"file": name, "name": file.filename or "Music", "duration": round(duration, 3)}
