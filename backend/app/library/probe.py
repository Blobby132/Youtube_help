"""What a media file is (size, length, codecs) and how to make it play in the browser.

Everything goes through ffprobe/FFmpeg, so any file FFmpeg reads can be imported. Files the
browser can't play (HEVC, ProRes, AVI, ...) are converted to H.264 MP4 once, on import.
"""

from __future__ import annotations

import json
import logging
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.errors import AppError
from app.core.media import require_tool, run_tool

log = logging.getLogger("shorts.library")

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".gif"})

# What Chromium-based browsers play without help (Playwright's Chromium lacks H.264, Chrome
# and Edge have it).
_MP4_VIDEO = frozenset({"h264", "av1"})
_MP4_AUDIO = frozenset({"aac", "mp3"})
_WEBM_VIDEO = frozenset({"vp8", "vp9", "av1"})
_WEBM_AUDIO = frozenset({"opus", "vorbis"})
_PLAYABLE_PIXELS = frozenset({"yuv420p", "yuvj420p"})

THUMBNAIL_SIZE = 480


@dataclass(frozen=True)
class MediaInfo:
    kind: str  # "video" | "image"
    width: int
    height: int
    duration: float | None
    fps: float | None
    has_audio: bool
    video_codec: str | None
    audio_codec: str | None
    pixel_format: str | None


def _rate(value: str | None) -> float | None:
    if not value or "/" not in value:
        return None
    num, den = value.split("/", 1)
    try:
        rate = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        return None
    return round(rate, 3) if 0 < rate < 1000 else None


def _rotation(stream: dict[str, Any]) -> int:
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            return int(float(side["rotation"]))
    rotate = (stream.get("tags") or {}).get("rotate")
    return int(float(rotate)) if rotate else 0


def probe(path: Path) -> MediaInfo:
    """Reads a video or image with ffprobe. Raises AppError if it isn't one."""
    result = run_tool(
        [
            require_tool("ffprobe"),
            "-v", "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,nb_frames"
            ":stream_side_data=rotation:stream_tags=rotate:format=duration,format_name",
            "-of", "json",
            str(path),
        ],
        f"read {path.name}",
    )
    try:
        data = json.loads(result.stdout)
    except ValueError as exc:
        raise AppError(f"{path.name} could not be read as a video or image.", 400) from exc

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and s.get("width")), None)
    if video is None:
        raise AppError(f"{path.name} has no picture in it. Is it really a video or image?", 400)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    width, height = int(video["width"]), int(video["height"])
    if abs(_rotation(video)) % 180 == 90:  # phone videos filmed upright are stored sideways
        width, height = height, width

    codec = video.get("codec_name")
    image_codecs = {"mjpeg", "png", "webp", "bmp", "tiff"}
    is_image = path.suffix.lower() in IMAGE_EXTENSIONS or (
        codec in image_codecs and "image2" in (data.get("format") or {}).get("format_name", "")
    )
    duration: float | None = None
    fps: float | None = None
    if not is_image:
        for value in ((data.get("format") or {}).get("duration"), video.get("duration")):
            try:
                duration = float(value)
                break
            except (TypeError, ValueError):
                continue
        if not duration or duration <= 0.05:
            raise AppError(f"{path.name} has no readable length. Is the file complete?", 400)
        fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))

    return MediaInfo(
        kind="image" if is_image else "video",
        width=width,
        height=height,
        duration=round(duration, 3) if duration else None,
        fps=fps,
        has_audio=audio is not None and not is_image,
        video_codec=codec,
        audio_codec=audio.get("codec_name") if audio else None,
        pixel_format=video.get("pix_fmt"),
    )


def browser_format(info: MediaInfo, extension: str) -> str | None:
    """How to store a video so the browser preview plays it: "keep" as is, "mp4"/"webm" to
    repackage without re-encoding, "audio" to convert only the sound, None to convert."""
    if info.pixel_format not in _PLAYABLE_PIXELS:
        return None
    video, audio = info.video_codec, info.audio_codec
    if video in _MP4_VIDEO and (audio is None or audio in _MP4_AUDIO):
        return "keep" if extension in (".mp4", ".m4v") else "mp4"
    if video in _WEBM_VIDEO and (audio is None or audio in _WEBM_AUDIO):
        return "keep" if extension == ".webm" else "webm"
    if video in _MP4_VIDEO:
        return "audio"  # the picture is fine; only the sound (e.g. PCM or FLAC) needs converting
    return None


def run_ffmpeg(args: list[str], what: str, duration: float | None, on_progress: Callable[[float], None] | None) -> None:
    """Runs FFmpeg, reporting progress (0..1) from its -progress output when a length is known."""
    command = [require_tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    log.info("Running: %s", " ".join(command))
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace"
    )
    assert process.stdout is not None and process.stderr is not None
    for line in process.stdout:
        if on_progress and duration and line.startswith("out_time_us="):
            try:
                on_progress(min(1.0, int(line.split("=", 1)[1]) / 1e6 / duration))
            except ValueError:
                pass
    stderr = process.stderr.read()
    if process.wait() != 0:
        log.error("ffmpeg failed (exit %s):\n%s", process.returncode, stderr)
        lines = [line for line in stderr.strip().splitlines() if line.strip()]
        reason = " ".join(lines[-2:]) if lines else f"exit code {process.returncode}"
        raise AppError(f"Could not {what}: {reason}", 400)


def make_playable(
    source: Path,
    folder: Path,
    stem: str,
    info: MediaInfo,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Puts a copy of `source` the browser can show into `folder` as <stem>.<ext>; returns it.
    The source file is moved when it can be used as is."""
    extension = source.suffix.lower()
    folder.mkdir(parents=True, exist_ok=True)
    if info.kind == "image":
        if extension in IMAGE_EXTENSIONS:
            target = folder / f"{stem}{'.jpg' if extension == '.jpeg' else extension}"
            source.replace(target)
            return target
        target = folder / f"{stem}.png"
        run_tool([require_tool("ffmpeg"), "-hide_banner", "-y", "-i", str(source), "-frames:v", "1", str(target)], "convert the image")
        return target

    plan = browser_format(info, extension)
    if plan == "keep":
        target = folder / f"{stem}{extension}"
        source.replace(target)
        return target
    if plan in ("mp4", "webm"):
        target = folder / f"{stem}.{plan}"
        flags = ["-movflags", "+faststart"] if plan == "mp4" else []
        run_ffmpeg(["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", *flags, str(target)],
                   f"repackage {source.name}", info.duration, on_progress)
        return target

    if plan == "audio":
        target = folder / f"{stem}.mp4"
        run_ffmpeg(
            ["-i", str(source), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             "-movflags", "+faststart", str(target)],
            f"convert the sound of {source.name}", info.duration, on_progress,
        )
        return target

    # Re-encode: H.264 (yuv420p, even size) + AAC, which every browser and the final render read.
    target = folder / f"{stem}.mp4"
    log.info("Converting %s (%s, %s) to H.264 for the browser", source.name, info.video_codec, info.pixel_format)
    run_ffmpeg(
        [
            "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(target),
        ],
        f"convert {source.name} to H.264",
        info.duration,
        on_progress,
    )
    return target


def make_thumbnail(media: Path, target: Path, info: MediaInfo) -> None:
    """A small JPEG of the picture (1 s in for videos, or a quarter of the way into short ones)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    seek = ["-ss", f"{min(1.0, (info.duration or 0) * 0.25):.3f}"] if info.kind == "video" else []
    size = THUMBNAIL_SIZE
    run_tool(
        [
            require_tool("ffmpeg"), "-hide_banner", "-y", *seek, "-i", str(media),
            "-frames:v", "1",
            "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-q:v", "4",
            str(target),
        ],
        f"make a thumbnail of {media.name}",
    )
