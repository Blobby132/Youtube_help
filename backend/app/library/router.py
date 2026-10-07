from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.jobs import jobs
from app.core.uploads import save_upload
from app.library.probe import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from app.library.store import MAX_NAME, ClipMetadata, Library
from app.library.usage import disclosure, projects_using
from app.projects.router import StoreDep

router = APIRouter(tags=["library"])

IMPORT_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS
MAX_IMPORT_BYTES = 4 << 30


def get_library(settings: Annotated[Settings, Depends(get_settings)]) -> Library:
    return Library(settings.library_dir)


LibraryDep = Annotated[Library, Depends(get_library)]


@router.get("/api/library")
def list_items(library: LibraryDep) -> list[dict[str, Any]]:
    return library.list()


@router.post("/api/library/import")
async def import_file(
    library: LibraryDep,
    file: Annotated[UploadFile, File()],
    aiGenerated: Annotated[bool, Form()] = False,
    name: Annotated[str | None, Form(max_length=MAX_NAME)] = None,
) -> dict[str, Any]:
    """Imports your own clip or image. Converting it for the browser can take a while, so the
    work runs as a job; poll /api/jobs/{id} for the new library item."""
    temp = await save_upload(file, library.incoming_dir, IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, "video or image")
    original = file.filename or temp.name
    metadata = ClipMetadata(
        name=name or original.rsplit(".", 1)[0],
        ai_generated=aiGenerated,
        original_name=original,
    )

    def work(job):
        try:
            job.update(0.0, f"Reading {original}…")
            return library.add_clip(temp, "upload", metadata, lambda p: job.update(p, f"Converting {original}…"))
        finally:
            temp.unlink(missing_ok=True)

    return jobs.submit("import", work, pool="media").to_dict()


@router.get("/api/library/{item_id}/file")
def item_file(item_id: str, library: LibraryDep) -> FileResponse:
    # Supports Range requests, so the preview can seek in long clips.
    return FileResponse(library.file_path(item_id), headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/api/library/{item_id}/thumbnail")
def item_thumbnail(item_id: str, library: LibraryDep) -> FileResponse:
    return FileResponse(library.thumbnail_path(item_id), headers={"Cache-Control": "public, max-age=31536000, immutable"})


class ItemChanges(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    aiGenerated: bool | None = None


@router.patch("/api/library/{item_id}")
def update_item(item_id: str, changes: ItemChanges, library: LibraryDep) -> dict[str, Any]:
    return library.update(item_id, name=changes.name, ai_generated=changes.aiGenerated)


@router.delete("/api/library/{item_id}")
def delete_item(item_id: str, library: LibraryDep, store: StoreDep, force: bool = False) -> dict[str, Any]:
    library.get(item_id)
    users = projects_using(store, item_id)
    if users and not force:
        names = ", ".join(f"“{p['name']}”" for p in users[:3]) + (f" and {len(users) - 3} more" if len(users) > 3 else "")
        raise AppError(f"This clip is used in {names}. Deleting it leaves a gap in those timelines.", 409)
    library.delete(item_id)
    return {"deleted": item_id, "usedIn": [p["id"] for p in users]}


@router.get("/api/projects/{project_id}/disclosure")
def project_disclosure(project_id: str, store: StoreDep, library: LibraryDep) -> dict[str, Any]:
    """Whether the saved project's timeline contains AI-generated clips (and which)."""
    return disclosure(store.load(project_id), library.list())
