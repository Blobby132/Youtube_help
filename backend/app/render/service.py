"""Builds and runs the FFmpeg command that renders a project to the final MP4.

    clips ─ trim, speed, frame rate, Fill crop or Fit inside ─┐
    gaps / missing media ─ black ─────────────────────────────┴─ concat ─ overlay ─ H.264
    text overlays (title, ranking, captions) ─ PNGs from the frontend ─┘
    voiceover + music + clip audio ─ volume ─ amix ─ AAC 48 kHz

The text overlays are drawn by the frontend with the same code that draws the preview (see
frontend/src/features/render/overlayFrames.ts), so line breaks, sizes and positions can't
differ between the two. They arrive as full-frame transparent PNGs, each with the run of
frames it covers, and are laid over the video at exactly those frames.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from app.core.config import CANVAS_HEIGHT as H
from app.core.config import CANVAS_WIDTH as W
from app.core.errors import AppError
from app.core.media import require_tool
from app.render.encoders import Quality
from app.render.plan import Plan, Segment, cover_rect, inside_rect, media_file

log = logging.getLogger("shorts.render")

AUDIO_RATE = 48_000
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass(frozen=True)
class Overlay:
    """A transparent 1080x1920 PNG shown over frames [first, end)."""

    first: int
    end: int
    path: Path


class Cancelled(Exception):
    pass


class RenderTask:
    """A running render that can be cancelled from another thread."""

    def __init__(self) -> None:
        self.cancelled = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    def attach(self, process: subprocess.Popen[str]) -> None:
        with self._lock:
            self._process = process
            if self.cancelled.is_set():
                process.kill()

    def cancel(self) -> None:
        with self._lock:
            self.cancelled.set()
            if self._process is not None and self._process.poll() is None:
                self._process.kill()


def _num(value: Any, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def _color(value: Any, default: str = "#000000") -> str:
    return "0x" + (value if isinstance(value, str) and _COLOR.fullmatch(value) else default)[1:]


def _f(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def transparent_png(path: Path, width: int = W, height: int = H) -> Path:
    """Writes a fully transparent RGBA PNG (no imaging library needed)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + b"\x00\x00\x00\x00" * width
    data = zlib.compress(row * height, 9)
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", data) + chunk(b"IEND", b""))
    return path


def _quote(path: Path) -> str:
    return "'" + path.resolve().as_posix().replace("'", "'\\''") + "'"


def overlay_script(overlays: list[Overlay], total: int, fps: Fraction, blank: Path) -> str:
    """An ffconcat list that shows each overlay at its frames and the blank image between.

    Durations are whole frames at the output rate (and the images are read at that rate), so
    every overlay starts exactly on its first frame."""
    lines = ["ffconcat version 1.0"]
    cursor = 0

    def add(path: Path, frames: int) -> None:
        lines.extend([f"file {_quote(path)}", f"option framerate {fps.numerator}/{fps.denominator}",
                      f"duration {frames / fps:.9f}"])

    for overlay in sorted(overlays, key=lambda o: o.first):
        first, end = max(cursor, overlay.first), min(total, overlay.end)
        if end <= first:
            continue
        if first > cursor:
            add(blank, first - cursor)
        add(overlay.path, end - first)
        cursor = end
    add(blank, max(1, total - cursor))
    # The last entry again, so its duration counts (FFmpeg ignores the last file's duration).
    lines.extend([f"file {_quote(blank)}", f"option framerate {fps.numerator}/{fps.denominator}"])
    return "\n".join(lines) + "\n"


def _atempo(speed: float) -> list[str]:
    """atempo takes 0.5..100 per filter; slower speeds chain several."""
    filters = []
    while speed < 0.5:
        filters.append("atempo=0.5")
        speed /= 0.5
    if abs(speed - 1) > 1e-6:
        filters.append(f"atempo={_f(speed)}")
    return filters


@dataclass
class Command:
    args: list[str]
    graph: str
    frames: int


def _scale(width: int | str, height: int | str) -> str:
    return f"scale={width}:{height}:flags=lanczos:out_color_matrix=bt709:out_range=tv"


def _even(value: float) -> int:
    return max(2, 2 * round(value / 2))


def untagged_hd(path: Path, item: dict[str, Any]) -> bool:
    """A video with no colour matrix in it, at HD size or larger.

    Browsers (and most players) show such videos as BT.709, while FFmpeg would read them as
    BT.601, which shifts colours (greens most). The render reads them as the preview does."""
    if item.get("kind") != "video" or max(item.get("width") or 0, item.get("height") or 0) < 1280:
        return False
    try:
        out = subprocess.run(
            [require_tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False
    return out in ("", "unknown")


def _clip_video(
    index: int, source: str, segment: Segment, fps: Fraction, background: dict[str, Any], as_bt709: bool = False
) -> list[str]:
    """Filters that turn one clip's input into exactly `segment.frames` 1080x1920 frames."""
    clip, item = segment.clip or {}, segment.item or {}
    rate = f"{fps.numerator}/{fps.denominator}"
    speed = _num(clip.get("speed"), 1) or 1
    timing = [f"setpts=(PTS-STARTPTS)/{_f(speed)}" if item.get("kind") == "video" else "setpts=PTS-STARTPTS",
              f"fps={rate}:round=up"]
    if as_bt709:
        timing.append("setparams=colorspace=bt709")
    tail = f"tpad=stop=-1:stop_mode=clone,trim=end_frame={segment.frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1"
    width, height = float(item.get("width") or W), float(item.get("height") or H)
    out = f"[v{index}]"

    if clip.get("fit") != "inside":
        r = cover_rect(width, height, W, H, _num(clip.get("cropX"), 0.5), _num(clip.get("cropY"), 0.5))
        crop = (f"crop=w='iw*{_f(r.width / width)}':h='ih*{_f(r.height / height)}'"
                f":x='iw*{_f(r.x / width)}':y='ih*{_f(r.y / height)}'")
        return [f"{source}{','.join(timing)},{crop},{_scale(W, H)},{tail}{out}"]

    r = inside_rect(width, height, W, H)
    fg_w, fg_h = min(W, _even(r.width)), min(H, _even(r.height))
    x, y = (W - fg_w) // 2, (H - fg_h) // 2
    if background.get("mode") != "blur":
        pad = f"pad={W}:{H}:{x}:{y}:color={_color(background.get('color'))}"
        return [f"{source}{','.join(timing)},{_scale(fg_w, fg_h)},{pad},{tail}{out}"]

    # The blurred background, as the preview draws it (drawClip.ts drawBlurred): the clip
    # filled to a smaller canvas (plus a margin, so the blur doesn't fade at the edges),
    # blurred there, then scaled up to the frame.
    blur = max(0.0, _num(background.get("blur"), 40))
    factor = max(1, min(8, math.floor(blur / 3)))
    small_w, small_h = math.ceil(W / factor), math.ceil(H / factor)
    radius = blur / factor
    margin = math.ceil(radius * 2)
    c = cover_rect(width, height, small_w, small_h, 0.5, 0.5)
    crop = (f"crop=w='iw*{_f(c.width / width)}':h='ih*{_f(c.height / height)}'"
            f":x='iw*{_f(c.x / width)}':y='ih*{_f(c.y / height)}'")
    blurred = f",gblur=sigma={_f(radius)}" if radius > 0 else ""
    return [
        f"{source}{','.join(timing)},split=2[bg{index}][fg{index}]",
        f"[bg{index}]{crop},{_scale(small_w + 2 * margin, small_h + 2 * margin)}{blurred},"
        f"crop={small_w}:{small_h}:{margin}:{margin},{_scale(W, H)}[bgs{index}]",
        f"[fg{index}]{_scale(fg_w, fg_h)}[fgs{index}]",
        f"[bgs{index}][fgs{index}]overlay={x}:{y},{tail}{out}",
    ]


def build_command(
    project: dict[str, Any],
    plan: Plan,
    media_dir: Path,
    overlays: list[Overlay],
    work_dir: Path,
    quality: Quality,
    output: Path,
) -> Command:
    fps = plan.fps
    rate = f"{fps.numerator}/{fps.denominator}"
    seconds = plan.frames / fps
    length = _f(float(seconds))
    inputs: list[str] = []
    graph: list[str] = []
    audio: list[str] = []
    aformat = f"aformat=sample_fmts=fltp:sample_rates={AUDIO_RATE}:channel_layouts=stereo"
    mix = project.get("mix") if isinstance(project.get("mix"), dict) else {}
    count = 0

    def add_input(*args: str) -> int:
        nonlocal count
        inputs.extend(args)
        count += 1
        return count - 1

    voiceover = project.get("voiceover") or {}
    voice = media_file(media_dir, voiceover.get("file"))
    if voice is None:
        raise AppError("The voiceover file is missing from the project folder. Make the voiceover again.", 400)
    index = add_input("-i", str(voice))
    audio.append(f"[{index}:a:0]{aformat},volume={_f(_num(mix.get('voiceVolume'), 1))}[avoice]")

    music = mix.get("music") if isinstance(mix.get("music"), dict) else None
    music_file = media_file(media_dir, music.get("file")) if music else None
    if music_file is not None:
        # Loops under the whole video, like the preview.
        index = add_input("-stream_loop", "-1", "-i", str(music_file))
        audio.append(f"[{index}:a:0]{aformat},volume={_f(_num(mix.get('musicVolume'), 0.15))}[amusic]")

    background = (project.get("canvas") or {}).get("background") or {}
    labels = []
    untagged: dict[Path, bool] = {}
    for i, segment in enumerate(plan.segments):
        labels.append(f"[v{i}]")
        if segment.clip is None or segment.item is None or segment.path is None:
            graph.append(f"color=c=black:s={W}x{H}:r={rate},trim=end_frame={segment.frames},"
                         f"setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v{i}]")
            continue
        clip, item = segment.clip, segment.item
        speed = _num(clip.get("speed"), 1) or 1
        # Where the first frame's picture comes from in the source.
        offset = max(0.0, plan.time(segment.first) - _num(clip.get("start")))
        source_start = _num(clip.get("inPoint")) + offset * speed
        span = segment.frames / fps
        if item.get("kind") == "video":
            # Two decoder threads per clip: a long timeline opens many clips at once.
            index = add_input("-threads", "2", "-ss", _f(source_start), "-t", _f(float(span) * speed + 1),
                              "-i", str(segment.path))
        else:
            index = add_input("-loop", "1", "-framerate", rate, "-t", _f(float(span) + 1), "-i", str(segment.path))
        if segment.path not in untagged:
            untagged[segment.path] = untagged_hd(segment.path, item)
        graph.extend(_clip_video(i, f"[{index}:v:0]", segment, fps, background, untagged[segment.path]))
        if item.get("kind") == "video" and item.get("hasAudio") and clip.get("keepAudio"):
            delay = round(plan.time(segment.first) * 1000)
            filters = [aformat, "asetpts=PTS-STARTPTS", *_atempo(speed), f"atrim=duration={_f(float(span))}",
                       f"volume={_f(_num(clip.get('volume'), 0.5))}", f"adelay=delays={delay}:all=1"]
            audio.append(f"[{index}:a:0]{','.join(filters)}[aclip{i}]")

    graph.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[base]")
    if overlays:
        blank = transparent_png(work_dir / "blank.png")
        script = work_dir / "overlays.ffconcat"
        script.write_text(overlay_script(overlays, plan.frames, fps, blank), encoding="utf-8")
        index = add_input("-f", "concat", "-safe", "0", "-i", str(script))
        graph.append(f"[{index}:v:0]format=rgba,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[ov]")
        graph.append(f"[base][ov]overlay=eof_action=repeat:format=yuv420,trim=end_frame={plan.frames},format=yuv420p[vout]")
    else:
        graph.append(f"[base]trim=end_frame={plan.frames},format=yuv420p[vout]")

    streams = "".join(f"[{entry.rsplit('[', 1)[1]}" for entry in audio)
    graph.extend(audio)
    if len(audio) > 1:
        graph.append(f"{streams}amix=inputs={len(audio)}:normalize=0:dropout_transition=0,"
                     f"apad=whole_dur={length},atrim=duration={length}[aout]")
    else:
        graph.append(f"{streams}apad=whole_dur={length},atrim=duration={length}[aout]")

    graph_text = ";\n".join(graph)
    script = work_dir / "graph.txt"
    script.write_text(graph_text, encoding="utf-8")
    args = [
        require_tool("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
        *inputs,
        *_graph_option(script),
        "-map", "[vout]", "-map", "[aout]",
        "-r", rate,
        *quality.args,
        "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(AUDIO_RATE), "-ac", "2",
        "-movflags", "+faststart",
        "-f", "mp4", str(output),
    ]
    return Command(args, graph_text, plan.frames)


_version: int | None = None


def ffmpeg_major() -> int:
    global _version
    if _version is None:
        try:
            out = subprocess.run([require_tool("ffmpeg"), "-hide_banner", "-version"], capture_output=True, text=True).stdout
            match = re.search(r"version n?(\d+)\.", out)
            _version = int(match.group(1)) if match else 7
        except OSError:
            _version = 7
    return _version


def _graph_option(script: Path) -> list[str]:
    """The filter graph is read from a file: a long video's graph is too long for a command line."""
    return ["-/filter_complex", str(script)] if ffmpeg_major() >= 7 else ["-filter_complex_script", str(script)]


def run(command: Command, task: RenderTask, on_progress: Callable[[float], None]) -> None:
    """Runs FFmpeg, reporting progress from its frame count. Raises Cancelled or AppError."""
    if task.cancelled.is_set():
        raise Cancelled()
    log.info("Rendering %d frames: %s", command.frames, " ".join(command.args))
    log.debug("Filter graph:\n%s", command.graph)
    process = subprocess.Popen(
        command.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace"
    )
    task.attach(process)
    assert process.stdout is not None and process.stderr is not None
    stderr_lines: list[str] = []
    # FFmpeg can fill the stderr pipe while we read progress from stdout; read both.
    reader = threading.Thread(target=lambda: stderr_lines.extend(process.stderr), daemon=True)
    reader.start()
    for line in process.stdout:
        if line.startswith("frame="):
            try:
                on_progress(min(1.0, int(line.split("=", 1)[1]) / max(1, command.frames)))
            except ValueError:
                pass
    code = process.wait()
    reader.join(timeout=5)
    if task.cancelled.is_set():
        raise Cancelled()
    if code != 0:
        stderr = "".join(stderr_lines)
        log.error("ffmpeg failed (exit %s):\n%s", code, stderr)
        lines = [line for line in stderr.strip().splitlines() if line.strip()]
        reason = " ".join(lines[-2:]) if lines else f"exit code {code}"
        raise AppError(f"FFmpeg could not render the video: {reason}", 500)


def render(
    project: dict[str, Any],
    plan: Plan,
    media_dir: Path,
    overlays: list[Overlay],
    work_dir: Path,
    quality: Quality,
    output: Path,
    task: RenderTask,
    on_progress: Callable[[float], None],
) -> Path:
    """Renders to `output`, through a temporary file next to it that is deleted on failure or
    cancel, so the exports folder only ever holds finished videos."""
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(f".{output.stem}.rendering.mp4")
    try:
        command = build_command(project, plan, media_dir, overlays, work_dir, quality, partial)
        run(command, task, on_progress)
        os.replace(partial, output)
    finally:
        _remove(partial)
        if output.parent.is_dir() and not any(output.parent.iterdir()):
            output.parent.rmdir()
    return output


def _remove(path: Path) -> None:
    # Windows can hold the file for a moment after FFmpeg exits.
    for _ in range(20):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            threading.Event().wait(0.1)
    log.warning("Could not delete the partial render %s", path)


def new_work_dir() -> Path:
    """A temporary folder for the overlay images and FFmpeg's scripts."""
    return Path(tempfile.mkdtemp(prefix="shorts-render-"))


def remove_work_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
