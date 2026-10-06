from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.captions.service import CaptionService, get_caption_service
from app.core.config import Settings, get_settings
from app.core.jobs import jobs
from app.projects.router import StoreDep

router = APIRouter(tags=["captions"])


def get_service(settings: Annotated[Settings, Depends(get_settings)]) -> CaptionService:
    return get_caption_service(settings)


ServiceDep = Annotated[CaptionService, Depends(get_service)]


class CaptionRequest(BaseModel):
    # The voiceover file in the project's media folder.
    file: str
    # The text that was read; captions use its spelling when the voiceover follows it.
    script: str | None = Field(default=None, max_length=20_000)


@router.post("/api/projects/{project_id}/captions")
def start_captions(project_id: str, body: CaptionRequest, store: StoreDep, service: ServiceDep) -> dict[str, Any]:
    audio = store.media_file(project_id, body.file)
    job = jobs.submit("captions", lambda job: service.generate(audio, body.file, body.script, job))
    return job.to_dict()
