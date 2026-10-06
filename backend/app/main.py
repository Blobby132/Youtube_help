"""FastAPI entry point: `uvicorn app.main:app` (run from backend/)."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.captions import router as captions
from app.core import health, jobs
from app.core.config import APP_NAME, APP_VERSION, Settings, get_settings
from app.core.errors import install_error_handlers
from app.core.logging import setup_logging
from app.fonts import router as fonts
from app.mix import router as mix
from app.projects import router as projects
from app.voiceover import router as voiceover
from app.voiceover.g2p import get_phonemizer
from app.voiceover.service import get_voiceover_service

log = logging.getLogger("shorts")


def warm_up(settings: Settings) -> None:
    """Loads Kokoro and the G2P in the background so the first AI read starts quickly."""
    service = get_voiceover_service(settings)
    if not service.model_ready():
        log.info("Kokoro model not downloaded yet; it downloads on the first AI read (or run `npm run setup`)")
        return
    try:
        get_phonemizer(british=False).phonemize("Ready.")
        service.engine.load()
    except Exception:
        log.exception("Warm-up failed; the first AI read will try again and show the error")


def create_app(*, warm: bool = True) -> FastAPI:
    setup_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings = app.dependency_overrides.get(get_settings, get_settings)()
        settings.projects_dir.mkdir(parents=True, exist_ok=True)
        log.info("%s %s ready. Projects folder: %s", APP_NAME, APP_VERSION, settings.projects_dir)
        log.info("AI voice runs on: %s", "DirectML (GPU), CPU fallback" if settings.tts_device == "directml" else "CPU")
        if settings.pexels_api_key is None:
            log.info("PEXELS_API_KEY is not set; stock search stays off until you add it to .env")
        if warm:
            threading.Thread(target=warm_up, args=(settings,), name="warm-up", daemon=True).start()
        yield

    app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan)
    # The Vite dev server proxies /api, but allow direct calls from it too.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(jobs.router)
    app.include_router(projects.router)
    app.include_router(voiceover.router)
    app.include_router(mix.router)
    app.include_router(captions.router)
    app.include_router(fonts.router)
    return app


app = create_app()
