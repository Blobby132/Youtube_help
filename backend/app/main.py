"""FastAPI entry point: `uvicorn app.main:app` (run from backend/)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core import health
from app.core.config import APP_NAME, APP_VERSION, get_settings
from app.core.errors import install_error_handlers
from app.core.logging import setup_logging
from app.projects import router as projects
from app.voiceover import router as voiceover

log = logging.getLogger("shorts")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = app.dependency_overrides.get(get_settings, get_settings)()
    settings.projects_dir.mkdir(parents=True, exist_ok=True)
    log.info("%s %s ready. Projects folder: %s", APP_NAME, APP_VERSION, settings.projects_dir)
    if settings.pexels_api_key is None:
        log.info("PEXELS_API_KEY is not set; stock search stays off until you add it to .env")
    yield


def create_app() -> FastAPI:
    setup_logging()
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
    app.include_router(projects.router)
    app.include_router(voiceover.router)
    return app


app = create_app()
