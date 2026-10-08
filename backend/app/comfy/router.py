from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.comfy.service import MAX_SECONDS, MAX_SEED, MAX_VARIATIONS, MIN_SECONDS, GenerationService, get_generation_service
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/api/comfy", tags=["comfy"])


def get_service(settings: Annotated[Settings, Depends(get_settings)]) -> GenerationService:
    return get_generation_service(settings)


ServiceDep = Annotated[GenerationService, Depends(get_service)]


class SceneRef(BaseModel):
    """The project and scene a preview is for (the Scenes tab)."""

    projectId: str = Field(min_length=1, max_length=64)
    sceneId: str = Field(min_length=1, max_length=64)


class ShotRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    duration: int = Field(default=3, ge=MIN_SECONDS, le=MAX_SECONDS)
    quality: Literal["draft", "final"] = "draft"
    variations: int = Field(default=1, ge=1, le=MAX_VARIATIONS)
    # Only for one variation: reuse a seed (e.g. "Final quality" of a draft).
    seed: int | None = Field(default=None, ge=1, le=MAX_SEED)
    # The library clip this one is based on (Generate again, Final quality).
    basedOn: str | None = Field(default=None, max_length=64)
    # Set for a scene's previews: they're tracked like any shot and tagged with the scene.
    scene: SceneRef | None = None


@router.get("/status")
def status(service: ServiceDep) -> dict[str, Any]:
    """Whether ComfyUI answers (checked now) and the workflow file can be used."""
    return service.status()


@router.get("/shots")
def list_shots(service: ServiceDep) -> dict[str, Any]:
    return {"jobs": service.list()}


@router.post("/shots")
def generate(body: ShotRequest, service: ServiceDep) -> dict[str, Any]:
    """Queues the shot's variations in ComfyUI. They're added to the library when they finish."""
    scene = body.scene.model_dump() if body.scene else None
    jobs = service.generate(body.prompt, body.duration, body.quality, body.variations, body.seed, body.basedOn, scene)
    return {"jobs": jobs}


@router.post("/shots/{job_id}/cancel")
def cancel(job_id: str, service: ServiceDep) -> dict[str, Any]:
    return service.cancel(job_id)


@router.delete("/shots/{job_id}")
def dismiss(job_id: str, service: ServiceDep) -> dict[str, Any]:
    service.dismiss(job_id)
    return {"deleted": job_id}


@router.post("/shots/clear")
def clear(service: ServiceDep) -> dict[str, Any]:
    service.clear_finished()
    return {"jobs": service.list()}
