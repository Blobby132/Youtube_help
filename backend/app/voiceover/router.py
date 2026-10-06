from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.jobs import jobs
from app.core.uploads import save_upload
from app.projects.router import StoreDep
from app.voiceover.service import MAX_SPEED, MIN_SPEED, VoiceoverService, get_voiceover_service, require_voice
from app.voiceover.voices import voices_payload

router = APIRouter(tags=["voiceover"])

VOICEOVER_EXTENSIONS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".webm", ".mp4"})
MAX_VOICEOVER_BYTES = 300 << 20
SCRIPT_MAX_CHARS = 5000


def get_service(settings: Annotated[Settings, Depends(get_settings)]) -> VoiceoverService:
    return get_voiceover_service(settings)


ServiceDep = Annotated[VoiceoverService, Depends(get_service)]


class AiReadRequest(BaseModel):
    text: str = Field(max_length=SCRIPT_MAX_CHARS)
    voiceId: str
    speed: float = Field(default=1.0, ge=MIN_SPEED, le=MAX_SPEED)


@router.get("/api/voices")
def list_voices() -> list[dict[str, str]]:
    return voices_payload()


@router.get("/api/voices/{voice_id}/preview")
def voice_preview(voice_id: str, service: ServiceDep) -> FileResponse:
    return FileResponse(service.voice_preview(voice_id), media_type="audio/wav")


@router.post("/api/projects/{project_id}/voiceover/ai")
def start_ai_read(project_id: str, body: AiReadRequest, store: StoreDep, service: ServiceDep) -> dict[str, Any]:
    require_voice(body.voiceId)
    if not body.text.strip():
        raise AppError("Write a script first: the AI read speaks it word for word.", 400)
    media = store.media_dir(project_id)
    media.mkdir(parents=True, exist_ok=True)
    job = jobs.submit(
        "voiceover",
        lambda job: service.generate_ai_read(media, body.text, body.voiceId, body.speed, job),
    )
    return job.to_dict()


@router.post("/api/projects/{project_id}/voiceover/upload")
async def upload_voiceover(
    project_id: str,
    store: StoreDep,
    service: ServiceDep,
    file: Annotated[UploadFile, File()],
    source: Annotated[str, Form()] = "upload",
) -> dict[str, Any]:
    if source not in ("upload", "recording"):
        raise AppError("source must be 'upload' or 'recording'", 400)
    media = store.media_dir(project_id)
    temp = await save_upload(file, media, VOICEOVER_EXTENSIONS, MAX_VOICEOVER_BYTES, "audio")
    try:
        name = "Recording" if source == "recording" else (file.filename or "Voiceover")
        return await run_in_threadpool(service.import_audio, media, temp, name, source)
    finally:
        temp.unlink(missing_ok=True)
