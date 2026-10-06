"""Kokoro model files: where they live, where they come from, and downloading them.

Run `python -m app.voiceover.assets` (from backend/) to download them with a progress bar;
`npm run setup` does this for you.
"""

from __future__ import annotations

import hashlib
import logging
import sys
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.core.errors import AppError

log = logging.getLogger("shorts.tts")

_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


@dataclass(frozen=True)
class ModelFile:
    name: str
    url: str
    sha256: str
    size: int


# Kokoro-82M v1.0 exported to ONNX (fp32, best quality on CPU) and its 54 voice styles.
KOKORO_MODEL = ModelFile(
    "kokoro-v1.0.onnx",
    f"{_RELEASE}/kokoro-v1.0.onnx",
    "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    325_532_387,
)
KOKORO_VOICES = ModelFile(
    "voices-v1.0.bin",
    f"{_RELEASE}/voices-v1.0.bin",
    "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    28_214_398,
)
KOKORO_FILES = (KOKORO_MODEL, KOKORO_VOICES)

# (bytes done, bytes total) across all files being downloaded
Progress = Callable[[int, int], None]


def kokoro_dir(models_dir: Path) -> Path:
    return models_dir / "kokoro"


def is_present(folder: Path, file: ModelFile) -> bool:
    path = folder / file.name
    return path.is_file() and path.stat().st_size == file.size


def missing_files(folder: Path) -> list[ModelFile]:
    return [f for f in KOKORO_FILES if not is_present(folder, f)]


def download_file(file: ModelFile, folder: Path, progress: Callable[[int], None]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / file.name
    partial = folder / (file.name + ".part")
    digest = hashlib.sha256()
    log.info("Downloading %s (%.0f MB)", file.url, file.size / 1e6)
    try:
        with urllib.request.urlopen(file.url, timeout=60) as response, partial.open("wb") as out:
            done = 0
            while chunk := response.read(1 << 20):
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                progress(done)
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise AppError(
            f"Could not download {file.name} from {file.url}: {exc}. "
            "Check your internet connection and try again.",
            status_code=502,
        ) from exc
    if digest.hexdigest() != file.sha256:
        partial.unlink(missing_ok=True)
        raise AppError(f"{file.name} downloaded incompletely or corrupted (checksum mismatch). Try again.", 502)
    partial.replace(target)


def ensure_kokoro_files(models_dir: Path, progress: Progress | None = None) -> Path:
    """Downloads whatever is missing and returns the folder holding the model files."""
    folder = kokoro_dir(models_dir)
    missing = missing_files(folder)
    total = sum(f.size for f in missing)
    finished = 0
    for file in missing:
        def report(done: int, base: int = finished) -> None:
            if progress:
                progress(base + done, total)

        download_file(file, folder, report)
        finished += file.size
    return folder


def _print_progress(done: int, total: int) -> None:
    width = 30
    filled = int(width * done / total) if total else width
    sys.stdout.write(f"\r  [{'#' * filled}{'.' * (width - filled)}] {done / 1e6:6.0f} / {total / 1e6:.0f} MB")
    sys.stdout.flush()


def main() -> None:
    from app.core.config import get_settings

    folder = kokoro_dir(get_settings().models_dir)
    missing = missing_files(folder)
    if not missing:
        print(f"  Kokoro model files are already in {folder}.")
        return
    print(f"  Downloading the Kokoro voice model to {folder} (one time, {sum(f.size for f in missing) / 1e6:.0f} MB)...")
    ensure_kokoro_files(get_settings().models_dir, _print_progress)
    print("\n  Done.")


if __name__ == "__main__":
    try:
        main()
    except AppError as exc:
        print(f"\n  {exc.message}", file=sys.stderr)
        sys.exit(1)
