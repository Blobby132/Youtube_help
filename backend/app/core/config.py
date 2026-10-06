"""Application settings, read once from the environment and the repo-level .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = REPO_ROOT / "backend"

APP_NAME = "Shorts Creator"
APP_VERSION = "0.1.0"

# Output format shared by preview and render.
CANVAS_WIDTH = 1080
CANVAS_HEIGHT = 1920
FPS = 30


@dataclass(frozen=True)
class Settings:
    projects_dir: Path
    models_dir: Path
    pexels_api_key: str | None


def _path_from_env(name: str, default: Path) -> Path:
    value = os.getenv(name)
    path = Path(value).expanduser() if value else default
    return path if path.is_absolute() else (REPO_ROOT / path)


@lru_cache
def get_settings() -> Settings:
    load_dotenv(REPO_ROOT / ".env")
    key = (os.getenv("PEXELS_API_KEY") or "").strip()
    return Settings(
        projects_dir=_path_from_env("PROJECTS_DIR", REPO_ROOT / "projects"),
        models_dir=_path_from_env("MODELS_DIR", REPO_ROOT / "models"),
        pexels_api_key=key or None,
    )
