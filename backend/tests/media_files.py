"""Small test videos and images, made with FFmpeg's test sources."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg is not installed"
)


def make_video(
    path: Path,
    width: int = 448,
    height: int = 832,
    seconds: float = 2.0,
    codec: str = "libx264",
    audio: bool = False,
    extra: list[str] | None = None,
) -> Path:
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    args += ["-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=24:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", "-shortest"]
    args += ["-c:v", codec, "-pix_fmt", "yuv420p", *(extra or []), str(path)]
    subprocess.run(args, check=True)
    return path


def make_image(path: Path, width: int = 1080, height: int = 1920) -> Path:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"testsrc2=size={width}x{height}:duration=1", "-frames:v", "1", str(path)],
        check=True,
    )
    return path


def codec_of(path: Path) -> str:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()
