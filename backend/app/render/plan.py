"""What the render will show, frame by frame, worked out from the project before FFmpeg runs.

The rules follow the preview (frontend/src/features/preview): a clip covers the times
`start <= t < start + duration`, a frame at time t shows the clip's source at
`inPoint + (t - start) * speed`, and the video is as long as the voiceover. Clips are placed
with the same arithmetic as frontend/src/features/preview/cover.ts.

Everything here is plain arithmetic on the project JSON and the library index, so it is cheap
and testable without FFmpeg. The pre-render checks live here too, because they look at the
same plan the render uses.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from app.core.config import CANVAS_HEIGHT, CANVAS_WIDTH
from app.library.store import CLIPS_DIR

# YouTube Shorts can be up to 3 minutes long.
SHORTS_MAX_SECONDS = 180
DEFAULT_FPS = Fraction(30)
# Rates a video can keep when every clip shares it (NTSC rates as exact fractions).
STANDARD_RATES = (
    Fraction(24000, 1001),
    Fraction(24),
    Fraction(25),
    Fraction(30000, 1001),
    Fraction(30),
    Fraction(48),
    Fraction(50),
    Fraction(60000, 1001),
    Fraction(60),
)
# A clip scaled up more than this looks soft, so the checks mention it.
UPSCALE_WARNING = 1.1
# Same tolerance as the preview's clip lookup (clipOps.ts EPS), in seconds.
_EPS = 1e-6


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float


def cover_rect(width: float, height: float, frame_w: float, frame_h: float, crop_x: float, crop_y: float) -> Rect:
    """Part of the source shown when it fills the frame (cover.ts coverRect), in source pixels."""
    zoom = max(frame_w / width, frame_h / height)
    sw, sh = frame_w / zoom, frame_h / zoom
    clamp = lambda v: min(1.0, max(0.0, v))  # noqa: E731
    return Rect((width - sw) * clamp(crop_x), (height - sh) * clamp(crop_y), sw, sh)


def inside_rect(width: float, height: float, frame_w: float, frame_h: float) -> Rect:
    """Where a "Fit inside" clip goes in the frame (cover.ts insideRect), in frame pixels."""
    zoom = min(frame_w / width, frame_h / height)
    w, h = width * zoom, height * zoom
    return Rect((frame_w - w) / 2, (frame_h - h) / 2, w, h)


def upscale_factor(clip: dict[str, Any], item: dict[str, Any]) -> float:
    """How much the clip is enlarged to fit the 1080x1920 frame (1 = not at all)."""
    width, height = item.get("width") or 0, item.get("height") or 0
    if width <= 0 or height <= 0:
        return 1.0
    if clip.get("fit") == "inside":
        return min(CANVAS_WIDTH / width, CANVAS_HEIGHT / height)
    return max(CANVAS_WIDTH / width, CANVAS_HEIGHT / height)


def standard_rate(fps: float) -> Fraction | None:
    for rate in STANDARD_RATES:
        if abs(float(rate) - fps) < 0.01:
            return rate
    return None


def fps_label(fps: Fraction) -> str:
    value = float(fps)
    return f"{value:g}" if fps.denominator == 1 else f"{value:.3f}".rstrip("0")


@dataclass
class Segment:
    """A run of output frames [first, end) showing one clip, or black when `clip` is None."""

    first: int
    end: int
    clip: dict[str, Any] | None = None
    item: dict[str, Any] | None = None
    path: Path | None = None
    # Black because the clip's media is gone (reported as missing media, not as a gap).
    missing: bool = False

    @property
    def frames(self) -> int:
        return self.end - self.first


@dataclass
class Plan:
    duration: float
    fps: Fraction
    frames: int
    segments: list[Segment]
    # Clips that don't appear because their media is gone: (clip, reason)
    missing: list[tuple[dict[str, Any], str]]

    def time(self, frame: int) -> float:
        return float(frame / self.fps)


def project_clips(project: dict[str, Any]) -> list[dict[str, Any]]:
    clips = project.get("clips")
    if not isinstance(clips, list):
        return []
    valid = [
        c for c in clips
        if isinstance(c, dict) and isinstance(c.get("mediaId"), str)
        and _num(c.get("duration")) > 0 and _num(c.get("speed"), 1) > 0
    ]
    return sorted(valid, key=lambda c: _num(c.get("start")))


def _num(value: Any, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def clip_end(clip: dict[str, Any]) -> float:
    return _num(clip.get("start")) + _num(clip.get("duration"))


def video_duration(project: dict[str, Any]) -> float:
    """The video is as long as the voiceover (clips past it are cut off)."""
    voiceover = project.get("voiceover")
    return _num(voiceover.get("duration")) if isinstance(voiceover, dict) else 0.0


def output_fps(clips: list[dict[str, Any]], items: dict[str, dict[str, Any]]) -> Fraction:
    """30 fps, unless every video clip in the render shares another standard rate."""
    rates = set()
    for clip in clips:
        item = items.get(clip["mediaId"])
        if not item or item.get("kind") != "video":
            continue  # images and missing clips have no rate of their own
        rate = standard_rate(_num(item.get("fps")))
        if rate is None:
            return DEFAULT_FPS
        rates.add(rate)
    return rates.pop() if len(rates) == 1 else DEFAULT_FPS


def frame_at(time: float, fps: Fraction) -> int:
    """The first frame whose time is at or after `time` (with the preview's tolerance)."""
    return max(0, math.ceil((time - _EPS) * fps - 1e-9))


def media_path(library_root: Path, item: dict[str, Any]) -> Path:
    return library_root / CLIPS_DIR / str(item.get("file") or "")


def make_plan(project: dict[str, Any], library_items: list[dict[str, Any]], library_root: Path) -> Plan:
    duration = video_duration(project)
    items = {item["id"]: item for item in library_items if isinstance(item.get("id"), str)}
    shown = [c for c in project_clips(project) if _num(c.get("start")) < duration - _EPS]
    fps = output_fps(shown, items)
    total = max(1, round(duration * fps)) if duration > 0 else 0

    segments: list[Segment] = []
    missing: list[tuple[dict[str, Any], str]] = []
    cursor = 0
    for clip in shown:
        first = max(cursor, frame_at(_num(clip.get("start")), fps))
        end = min(total, frame_at(clip_end(clip), fps))
        if end <= first:
            continue
        item = items.get(clip["mediaId"])
        path = media_path(library_root, item) if item else None
        if item is None:
            missing.append((clip, "deleted"))
        elif path is None or not path.is_file():
            missing.append((clip, "file"))
        if first > cursor:
            segments.append(Segment(cursor, first))
        ok = item is not None and path is not None and path.is_file()
        segments.append(Segment(first, end, clip, item, path) if ok else Segment(first, end, missing=True))
        cursor = end
    if cursor < total:
        segments.append(Segment(cursor, total))
    return Plan(duration, fps, total, segments, missing)


# Pre-render checks ----------------------------------------------------------------------------


def timecode(seconds: float) -> str:
    """75.456 -> "1:15.45", like the frontend's formatTimecode."""
    hundredths = max(0, math.floor(seconds * 100 + 1e-6))
    return f"{hundredths // 6000}:{hundredths % 6000 // 100:02d}.{hundredths % 100:02d}"


def minutes(seconds: float) -> str:
    """75.4 -> "1:15", like the frontend's formatDuration."""
    total = max(0, round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def _name(item: dict[str, Any] | None, clip: dict[str, Any]) -> str:
    return f"“{item.get('name')}”" if item and item.get("name") else f"The clip at {timecode(_num(clip.get('start')))}"


def _listing(parts: list[str], limit: int = 3) -> str:
    shown = ", ".join(parts[:limit])
    return shown + (f" and {len(parts) - limit} more" if len(parts) > limit else "")


def checks(
    project: dict[str, Any],
    plan: Plan,
    library_items: list[dict[str, Any]],
    media_dir: Path,
) -> tuple[list[dict[str, str]], list[str]]:
    """(warnings, blockers). Warnings let the render go ahead; blockers don't."""
    warnings: list[dict[str, str]] = []
    blockers: list[str] = []
    items = {item["id"]: item for item in library_items if isinstance(item.get("id"), str)}
    clips = project_clips(project)
    voiceover = project.get("voiceover") if isinstance(project.get("voiceover"), dict) else None

    def warn(kind: str, message: str) -> None:
        warnings.append({"kind": kind, "message": message})

    if voiceover is None or plan.duration <= 0:
        blockers.append("Add a voiceover first: the video is as long as the voiceover.")
    elif not _media_exists(media_dir, voiceover.get("file")):
        blockers.append(f"The voiceover file {voiceover.get('file')} is missing from the project folder. Make the voiceover again.")
    if not clips:
        blockers.append("Add at least one clip to the timeline.")

    gaps = [s for s in plan.segments if s.clip is None and not s.missing]
    if gaps and clips:
        spans = [f"{timecode(plan.time(g.first))}–{timecode(plan.time(g.end))}" for g in gaps]
        what = "A gap" if len(gaps) == 1 else f"{len(gaps)} gaps"
        warn("gaps", f"{what} in the timeline will render black: {_listing(spans)}.")

    if voiceover is not None and plan.duration > 0:
        late = [c for c in clips if clip_end(c) > plan.duration + 0.01]
        if late:
            names = [_name(items.get(c["mediaId"]), c) for c in late]
            verb = "runs" if len(late) == 1 else "run"
            warn(
                "past-voiceover",
                f"{_listing(names)} {verb} past the end of the voiceover ({timecode(plan.duration)}) and will be cut off.",
            )

    captions = project.get("captions") if isinstance(project.get("captions"), dict) else {}
    words = captions.get("words") if isinstance(captions.get("words"), list) else []
    if captions.get("enabled", True) and words and voiceover is not None and captions.get("voiceoverFile") != voiceover.get("file"):
        warn(
            "captions-stale",
            "The captions are out of date: they were timed against an older voiceover. Regenerate them in the Captions tab.",
        )

    lost = []
    for clip, reason in plan.missing:
        item = items.get(clip["mediaId"])
        lost.append(_name(item, clip) + (" (deleted from the library)" if reason == "deleted" else " (its file is missing)"))
    if lost:
        warn("missing-media", f"Missing media will render black: {_listing(lost)}.")
    mix = project.get("mix") if isinstance(project.get("mix"), dict) else {}
    music = mix.get("music") if isinstance(mix.get("music"), dict) else None
    if music and not _media_exists(media_dir, music.get("file")):
        warn("missing-media", f"The background music {music.get('name') or music.get('file')} is missing, so the video renders without it.")

    soft = []
    for segment in plan.segments:
        if segment.clip is None or segment.item is None:
            continue
        factor = upscale_factor(segment.clip, segment.item)
        if factor > UPSCALE_WARNING:
            item = segment.item
            soft.append(f"{_name(item, segment.clip)} ({item.get('width')}×{item.get('height')}, scaled up {factor:.1f}×)")
    if soft:
        warn("low-res", f"Low-resolution clips will be scaled up and may look soft: {_listing(soft)}.")

    if plan.duration > SHORTS_MAX_SECONDS:
        warn(
            "too-long",
            f"The video is {minutes(plan.duration)} long. Shorts can be at most 3:00; a longer video uploads as a regular video.",
        )
    return warnings, blockers


_MEDIA_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def media_file(media_dir: Path, name: Any) -> Path | None:
    if not isinstance(name, str) or not _MEDIA_NAME.fullmatch(name) or ".." in name:
        return None
    path = media_dir / name
    return path if path.is_file() else None


def _media_exists(media_dir: Path, name: Any) -> bool:
    return media_file(media_dir, name) is not None


# Output files ---------------------------------------------------------------------------------

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_name(name: Any) -> str:
    """A project name made safe as a Windows folder and file name."""
    text = _UNSAFE.sub(" ", name if isinstance(name, str) else "")
    text = " ".join(text.split())[:80].rstrip(" .")
    if not text:
        text = "Untitled short"
    if text.split(".")[0].upper() in _RESERVED:
        text = f"{text} video"
    return text


def output_path(exports_dir: Path, project_name: Any) -> Path:
    """exports/<name>/<name>.mp4, numbered "(2)", "(3)", ... so earlier renders are kept."""
    name = safe_name(project_name)
    folder = exports_dir / name
    path = folder / f"{name}.mp4"
    number = 2
    while path.exists():
        path = folder / f"{name} ({number}).mp4"
        number += 1
    return path
