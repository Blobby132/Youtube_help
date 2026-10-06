from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends

from app.core.config import Settings, get_settings
from app.projects.store import ProjectStore

router = APIRouter(prefix="/api/projects", tags=["projects"])


def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> ProjectStore:
    return ProjectStore(settings.projects_dir)


StoreDep = Annotated[ProjectStore, Depends(get_store)]


@router.get("")
def list_projects(store: StoreDep) -> list[dict[str, Any]]:
    return store.list()


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
