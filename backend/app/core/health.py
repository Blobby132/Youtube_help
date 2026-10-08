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
from app.captions.service import get_caption_service
from app.voiceover.service import get_voiceover_service

router = APIRouter(prefix="/api", tags=["health"])


def tts_status(settings: Settings) -> dict[str, Any]:
    try:
        import onnxruntime

        providers = onnxruntime.get_available_providers()
    except ImportError:
        providers = []
    service = get_voiceover_service(settings)
    return {
        "device": settings.tts_device,
        "directmlAvailable": "DmlExecutionProvider" in providers,
        "modelReady": service.model_ready(),
        "provider": service.engine.provider_label if service.engine.provider else None,
    }


@router.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, Any]:
    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
        "python": platform.python_version(),
        "ffmpeg": shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
        "pexels": settings.pexels_api_key is not None,
        "pixabay": settings.pixabay_api_key is not None,
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT, "fps": FPS},
        "tts": tts_status(settings),
        "captions": {
            "model": settings.whisper_model,
            "modelReady": get_caption_service(settings).model_ready(),
        },
    }
