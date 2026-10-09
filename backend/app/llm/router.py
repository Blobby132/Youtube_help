from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.llm.service import LlmService, get_llm_service

router = APIRouter(prefix="/api/llm", tags=["llm"])


def get_service(settings: Annotated[Settings, Depends(get_settings)]) -> LlmService:
    return get_llm_service(settings)


ServiceDep = Annotated[LlmService, Depends(get_service)]

SceneField = Literal["source", "description", "searchText", "prompt"]


class Word(BaseModel):
    text: str = Field(max_length=200)
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class SceneIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    # The narration's words in the scene's time, with their times (where a split can cut).
    words: list[Word] = Field(default_factory=list, max_length=2000)
    source: Literal["ai", "stock", "none"]
    description: str = Field(default="", max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    searchText: str = Field(default="", max_length=100)
    # The fields you've edited (not left as the AI last wrote them): never overwritten.
    edited: list[SceneField] = Field(default_factory=list)


class WriteRequest(BaseModel):
    script: str = Field(default="", max_length=20_000)
    scenes: list[SceneIn] = Field(min_length=1, max_length=200)


class PromptScene(BaseModel):
    number: int = Field(ge=1)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    narration: str = Field(default="", max_length=5000)
    description: str = Field(default="", max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    # What the scenes before and after show, to keep the look consistent.
    before: str | None = Field(default=None, max_length=2000)
    after: str | None = Field(default=None, max_length=2000)


class PromptRequest(BaseModel):
    script: str = Field(default="", max_length=20_000)
    scene: PromptScene


@router.get("/status")
def status(service: ServiceDep) -> dict[str, Any]:
    """Whether the language model server answers and has the model, and what ComfyUI is doing."""
    return service.status()


@router.post("/scenes")
def write_scenes(body: WriteRequest, service: ServiceDep) -> dict[str, Any]:
    """Write scenes with AI: poll /api/jobs/{id}. Refused straight away while ComfyUI is generating."""
    return service.write_scenes(body.script, [scene.model_dump() for scene in body.scenes]).to_dict()


@router.post("/prompt")
def rewrite_prompt(body: PromptRequest, service: ServiceDep) -> dict[str, Any]:
    """Rewrite prompt for one scene: poll /api/jobs/{id}."""
    return service.rewrite_prompt(body.script, body.scene.model_dump()).to_dict()
