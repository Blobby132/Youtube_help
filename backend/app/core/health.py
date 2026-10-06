from __future__ import annotations

import platform
import shutil
from typing import Annotated, Any

from fastapi import APIRouter, Depends

from app.core.config import (
    APP_NAME,
    APP_VERSION,
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    FPS,
    Settings,
    get_settings,
)

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, Any]:
    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
        "python": platform.python_version(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "pexels": settings.pexels_api_key is not None,
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT, "fps": FPS},
    }
