"""Render API: check a project, render it in the background, cancel, and open the result.

    POST /api/render/check         {project} -> length, frame rate, qualities, warnings
    POST /api/render               multipart: request (JSON), manifest (JSON), overlays (PNGs)
    POST /api/render/{job}/cancel  stops FFmpeg and deletes the partial file
    POST /api/render/open          {file, action: "play" | "folder"}

The frontend sends the project as it is in the editor (not the last autosave), so the render
shows exactly what the preview shows.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile
from pydantic import BaseModel

from app.core.config import CANVAS_HEIGHT, CANVAS_WIDTH, Settings, get_settings
from app.core.errors import AppError
from app.core.jobs import Job, jobs
from app.core.media import probe_duration
from app.library.store import Library
from app.library.usage import disclosure
from app.projects.store import ProjectStore, validate_project_id
from app.render import encoders, service
from app.render.plan import checks, fps_label, make_plan, output_path

log = logging.getLogger("shorts.render")

router = APIRouter(prefix="/api/render", tags=["render"])

SettingsDep = Annotated[Settings, Depends(get_settings)]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_OVERLAY_BYTES = 1 << 30

_tasks: dict[str, service.RenderTask] = {}
_tasks_lock = threading.Lock()


def _project(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        raise AppError("That is not a Shorts Creator project.", 400)
    validate_project_id(raw["id"])
    return raw


def _prepare(project: dict[str, Any], settings: Settings):
    library = Library(settings.library_dir)
    items = library.list()
    media_dir = ProjectStore(settings.projects_dir).media_dir(project["id"])
    plan = make_plan(project, items, library.root)
    warnings, blockers = checks(project, plan, items, media_dir)
    return plan, items, media_dir, warnings, blockers


@router.post("/check")
def check(settings: SettingsDep, project: Annotated[dict[str, Any], Body(embed=True)]) -> dict[str, Any]:
    """Everything the render dialog shows before you start: problems to know about, the output
    length and frame rate, and the qualities this PC can render with."""
    project = _project(project)
    plan, items, _, warnings, blockers = _prepare(project, settings)
    return {
        "duration": round(plan.duration, 3),
        "frames": plan.frames,
        "fps": {"num": plan.fps.numerator, "den": plan.fps.denominator, "label": fps_label(plan.fps)},
        "width": CANVAS_WIDTH,
        "height": CANVAS_HEIGHT,
        "qualities": [{"id": q.id, "label": q.label, "description": q.description} for q in encoders.qualities()],
        "warnings": warnings,
        "blockers": blockers,
        **disclosure(project, items),
    }


class RenderRequest(BaseModel):
    project: dict[str, Any]
    quality: str = "best"
    # The frame rate and length the overlays were drawn for (from /check).
    fps: dict[str, int]
    frames: int


def _read_overlays(data: bytes, manifest: Any, frames: int, work_dir: Path) -> list[service.Overlay]:
    if not isinstance(manifest, list):
        raise AppError("The overlay list is not valid.", 400)
    overlays = []
    offset = 0
    for number, entry in enumerate(manifest):
        try:
            first, end, size = int(entry["first"]), int(entry["end"]), int(entry["size"])
        except (KeyError, TypeError, ValueError) as exc:
            raise AppError(f"Overlay {number} is not valid.", 400) from exc
        chunk = data[offset:offset + size]
        offset += size
        if len(chunk) != size or not chunk.startswith(PNG_SIGNATURE) or not 0 <= first < end <= frames:
            raise AppError(f"Overlay {number} is not a PNG for frames inside the video.", 400)
        path = work_dir / f"overlay-{number:05d}.png"
        path.write_bytes(chunk)
        overlays.append(service.Overlay(first, end, path))
    if offset != len(data):
        raise AppError("The overlay images don't match their list.", 400)
    return overlays


@router.post("")
async def start_render(
    settings: SettingsDep,
    request: Annotated[str, Form()],
    manifest: Annotated[str, Form()] = "[]",
    overlays: Annotated[UploadFile | None, File()] = None,
) -> dict[str, Any]:
    try:
        body = RenderRequest.model_validate_json(request)
        entries = json.loads(manifest)
    except ValueError as exc:
        raise AppError(f"The render request is not valid: {exc}", 400) from exc
    project = _project(body.project)
    plan, items, media_dir, _, blockers = _prepare(project, settings)
    if blockers:
        raise AppError(" ".join(blockers), 400)
    if (plan.fps.numerator, plan.fps.denominator) != (body.fps.get("num"), body.fps.get("den")) or plan.frames != body.frames:
        raise AppError("The timeline changed while the render was being prepared. Click Render again.", 409)
    quality = encoders.get_quality(body.quality)
    if quality is None:
        raise AppError(f"This PC can't render with “{body.quality}”.", 400)

    data = b""
    if overlays is not None:
        data = await overlays.read(MAX_OVERLAY_BYTES + 1)
        if len(data) > MAX_OVERLAY_BYTES:
            raise AppError("The text overlays are too large.", 413)
    work_dir = service.new_work_dir()
    try:
        layers = _read_overlays(data, entries, plan.frames, work_dir)
    except BaseException:
        service.remove_work_dir(work_dir)
        raise
    task = service.RenderTask()
    contains_ai = disclosure(project, items)

    def work(job: Job) -> dict[str, Any]:
        try:
            output = output_path(settings.exports_dir, project.get("name"))
            job.update(0.0, "Rendering…")
            service.render(project, plan, media_dir, layers, work_dir, quality, output, task,
                           lambda p: job.update(p, "Rendering…"))
            job.update(1.0, "Finishing…")
            return {
                "file": str(output.resolve()),
                "name": output.name,
                "folder": str(output.parent.resolve()),
                "size": output.stat().st_size,
                "duration": round(probe_duration(output), 3),
                "width": CANVAS_WIDTH,
                "height": CANVAS_HEIGHT,
                "fps": fps_label(plan.fps),
                "quality": quality.label,
                **contains_ai,
            }
        except service.Cancelled:
            raise AppError("Render cancelled. The partial file was deleted.", 409) from None
        finally:
            service.remove_work_dir(work_dir)
            with _tasks_lock:
                _tasks.pop(job.id, None)

    job = jobs.submit("render", work, pool="render")
    with _tasks_lock:
        _tasks[job.id] = task
    log.info("Render %s queued: %s, %d frames at %s fps, %s, %d overlays",
             job.id, project.get("name"), plan.frames, fps_label(plan.fps), quality.label, len(layers))
    return job.to_dict()


@router.post("/{job_id}/cancel")
def cancel_render(job_id: str) -> dict[str, Any]:
    with _tasks_lock:
        task = _tasks.get(job_id)
    if task is None:
        raise AppError("That render has already finished.", 404)
    task.cancel()
    return {"cancelled": job_id}


class OpenRequest(BaseModel):
    file: str
    action: Literal["play", "folder"]


@router.post("/open")
def open_result(body: OpenRequest, settings: SettingsDep) -> dict[str, Any]:
    """Plays a finished video in the PC's default player, or shows it in its folder."""
    path = Path(body.file).resolve()
    root = settings.exports_dir.resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise AppError("That video is no longer in the exports folder.", 404)
    try:
        if sys.platform == "win32":
            if body.action == "play":
                os.startfile(path)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["explorer", f"/select,{path}"])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)] if body.action == "play" else ["open", "-R", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path if body.action == "play" else path.parent)])
    except OSError as exc:
        raise AppError(f"Could not open {path.name}: {exc}", 500) from exc
    return {"opened": str(path)}
