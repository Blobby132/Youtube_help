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


TTS_DEVICES = ("cpu", "directml")


@dataclass(frozen=True)
class Settings:
    projects_dir: Path
    models_dir: Path
    pexels_api_key: str | None
    # "cpu" (default) or "directml" (GPU on Windows; needs onnxruntime-directml).
    tts_device: str = "cpu"
    # faster-whisper model for captions; always runs on the CPU.
    whisper_model: str = "small.en"
    # App-wide data that isn't part of a project, e.g. the pronunciation list.
    data_dir: Path = REPO_ROOT / "data"


def _path_from_env(name: str, default: Path) -> Path:
    value = os.getenv(name)
    path = Path(value).expanduser() if value else default
    return path if path.is_absolute() else (REPO_ROOT / path)


@lru_cache
def get_settings() -> Settings:
    load_dotenv(REPO_ROOT / ".env")
    key = (os.getenv("PEXELS_API_KEY") or "").strip()
    device = (os.getenv("TTS_DEVICE") or "cpu").strip().lower()
    return Settings(
        projects_dir=_path_from_env("PROJECTS_DIR", REPO_ROOT / "projects"),
        models_dir=_path_from_env("MODELS_DIR", REPO_ROOT / "models"),
        pexels_api_key=key or None,
        tts_device=device if device in TTS_DEVICES else "cpu",
        whisper_model=(os.getenv("WHISPER_MODEL") or "small.en").strip(),
        data_dir=_path_from_env("DATA_DIR", REPO_ROOT / "data"),
    )
