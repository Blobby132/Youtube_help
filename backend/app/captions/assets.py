"""faster-whisper model files: downloaded once into models/whisper/<name>.

Run `python -m app.captions.assets` (from backend/) to download the configured model;
`npm run setup` does this for you.
"""

from __future__ import annotations

import fnmatch
import logging
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.core.errors import AppError

log = logging.getLogger("shorts.captions")

# Same names faster-whisper accepts. `.en` models are English-only and a bit more accurate.
MODEL_REPOS = {
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "base.en": "Systran/faster-whisper-base.en",
    "small.en": "Systran/faster-whisper-small.en",
    "medium.en": "Systran/faster-whisper-medium.en",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}
_ALLOW = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
_REQUIRED = ("model.bin", "config.json", "tokenizer.json")

Progress = Callable[[int, int], None]


def repo_for(name: str) -> str:
    if name in MODEL_REPOS:
        return MODEL_REPOS[name]
    if "/" in name:  # a Hugging Face repo id of a CTranslate2 Whisper model
        return name
    raise AppError(
        f"Unknown WHISPER_MODEL {name!r}. Use one of: {', '.join(MODEL_REPOS)}.",
        400,
    )


def whisper_dir(models_dir: Path, name: str) -> Path:
    return models_dir / "whisper" / name.replace("/", "--")


def is_ready(folder: Path) -> bool:
    return all((folder / f).is_file() for f in _REQUIRED) and any(folder.glob("vocabulary.*"))


def _folder_size(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file()) if folder.exists() else 0


def _expected_size(repo: str) -> int:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True)
        return sum(
            s.size or 0
            for s in info.siblings or []
            if any(fnmatch.fnmatch(s.rfilename, pattern) for pattern in _ALLOW)
        )
    except Exception as exc:  # progress is a nicety; the download itself reports real errors
        log.info("Could not read the model size for progress: %s", exc)
        return 0


def ensure_whisper_model(models_dir: Path, name: str, progress: Progress | None = None) -> Path:
    """Downloads the model if needed and returns its folder."""
    folder = whisper_dir(models_dir, name)
    if is_ready(folder):
        return folder
    repo = repo_for(name)
    folder.mkdir(parents=True, exist_ok=True)
    total = _expected_size(repo)
    log.info("Downloading Whisper model %s (%s) to %s", name, repo, folder)

    error: list[BaseException] = []

    def download() -> None:
        try:
            from huggingface_hub import snapshot_download

            snapshot_download(repo, local_dir=str(folder), allow_patterns=_ALLOW)
        except BaseException as exc:  # reported below, in the caller's thread
            error.append(exc)

    worker = threading.Thread(target=download, name="whisper-download", daemon=True)
    worker.start()
    while worker.is_alive():
        worker.join(0.5)
        if progress:
            progress(min(_folder_size(folder), total) if total else 0, total)
    if error:
        raise AppError(
            f"Could not download the Whisper model {name}: {error[0]}. Check your internet connection and try again.",
            502,
        ) from error[0]
    if not is_ready(folder):
        raise AppError(f"The Whisper model {name} downloaded incompletely. Try again.", 502)
    if progress:
        progress(total, total)
    return folder


def main() -> None:
    from app.core.config import get_settings

    settings = get_settings()
    name = settings.whisper_model
    folder = whisper_dir(settings.models_dir, name)
    if is_ready(folder):
        print(f"  Whisper model {name} is already in {folder}.")
        return
    print(f"  Downloading the Whisper model {name} to {folder} (one time)...")
    started = time.time()

    def show(done: int, total: int) -> None:
        if total:
            filled = int(30 * done / total)
            sys.stdout.write(f"\r  [{'#' * filled}{'.' * (30 - filled)}] {done / 1e6:6.0f} / {total / 1e6:.0f} MB")
        else:
            sys.stdout.write(f"\r  {done / 1e6:6.0f} MB")
        sys.stdout.flush()

    ensure_whisper_model(settings.models_dir, name, show)
    print(f"\n  Done in {time.time() - started:.0f}s.")


if __name__ == "__main__":
    try:
        main()
    except AppError as exc:
        print(f"\n  {exc.message}", file=sys.stderr)
        sys.exit(1)
