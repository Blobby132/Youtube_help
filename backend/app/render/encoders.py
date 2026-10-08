"""The H.264 encoders the render can use on this PC.

"Best quality" (libx264) is always there. "Fast (GPU)" uses AMD's hardware encoder
(h264_amf), offered only when this FFmpeg has it *and* it can open the GPU: FFmpeg builds for
Windows list h264_amf even on PCs without an AMD card, so a tiny test encode decides. The
check runs once, in the background when the backend starts.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
from dataclasses import dataclass

log = logging.getLogger("shorts.render")


@dataclass(frozen=True)
class Quality:
    id: str
    label: str
    description: str
    args: tuple[str, ...]


BEST = Quality(
    "best",
    "Best quality",
    "libx264 at CRF 18 on the CPU: the sharpest result, slower to make.",
    ("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"),
)
GPU = Quality(
    "gpu",
    "Fast (GPU)",
    "AMD's hardware encoder: much faster, slightly larger files for the same quality.",
    ("-c:v", "h264_amf", "-usage", "transcoding", "-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22", "-profile:v", "high"),
)

_lock = threading.Lock()
_available: tuple[Quality, ...] | None = None


def _amf_works(ffmpeg: str) -> bool:
    try:
        listed = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20)
        if " h264_amf " not in listed.stdout:
            return False
        trial = subprocess.run(
            [ffmpeg, "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2",
             "-frames:v", "3", "-pix_fmt", "yuv420p", *GPU.args, "-f", "null", "-"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.info("Could not test the AMD encoder: %s", exc)
        return False
    if trial.returncode != 0:
        log.info("FFmpeg lists h264_amf but it can't encode here: %s", trial.stderr.strip().splitlines()[-1:] or "")
    return trial.returncode == 0


def qualities() -> tuple[Quality, ...]:
    """The qualities this PC can render with (detected once)."""
    global _available
    with _lock:
        if _available is None:
            ffmpeg = shutil.which("ffmpeg")
            gpu = ffmpeg is not None and _amf_works(ffmpeg)
            _available = (BEST, GPU) if gpu else (BEST,)
            log.info("Render encoders: %s", ", ".join(q.label for q in _available))
        return _available


def get_quality(quality_id: str) -> Quality | None:
    return next((q for q in qualities() if q.id == quality_id), None)


def detect_in_background() -> None:
    threading.Thread(target=qualities, name="encoder-check", daemon=True).start()
