from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import FileResponse

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.library.store import Library
from app.library.usage import ai_clips
from app.projects.store import ProjectStore

log = logging.getLogger("shorts.projects")

router = APIRouter(prefix="/api/projects", tags=["projects"])


def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> ProjectStore:
    return ProjectStore(settings.projects_dir)


StoreDep = Annotated[ProjectStore, Depends(get_store)]


@router.get("")
def list_projects(store: StoreDep, settings: Annotated[Settings, Depends(get_settings)]) -> list[dict[str, Any]]:
    """Saved projects, newest first, each with the number of AI-generated clips on its timeline
    (null if the media library can't be read)."""
    try:
        items: list[dict[str, Any]] | None = Library(settings.library_dir).list()
    except AppError as exc:
        log.warning("Project list without AI flags: %s", exc.message)
        items = None
    return [
        {**summary, "aiClips": None if items is None else len(ai_clips(data, items))}
        for summary, data in store.list_with_data()
    ]


@router.get("/{project_id}")
def get_project(project_id: str, store: StoreDep) -> dict[str, Any]:
    return store.load(project_id)


@router.put("/{project_id}")
def save_project(
    project_id: str,
    store: StoreDep,
    project: Annotated[dict[str, Any], Body()],
) -> dict[str, Any]:
    return store.save(project_id, project)


@router.get("/{project_id}/media/{name}")
def get_media(project_id: str, name: str, store: StoreDep) -> FileResponse:
    # Media names are unique per file, so browsers may cache them forever.
    return FileResponse(
        store.media_file(project_id, name),
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
