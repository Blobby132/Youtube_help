"""Audio helpers shared by features: WAV I/O and FFmpeg/ffprobe wrappers."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

from app.core.errors import AppError

log = logging.getLogger("shorts.media")

FFMPEG_HINT = "Install it with `winget install --id Gyan.FFmpeg -e`, open a new terminal and restart the app."


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise AppError(f"{name} was not found on PATH. {FFMPEG_HINT}", 500)
    return path


def run_tool(args: list[str], what: str) -> subprocess.CompletedProcess[str]:
    """Runs ffmpeg/ffprobe; on failure raises AppError with the tool's own error lines."""
    log.info("Running: %s", " ".join(args))
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        log.error("%s failed (exit %s):\n%s", args[0], result.returncode, result.stderr)
        lines = [line for line in result.stderr.strip().splitlines() if line.strip()]
        reason = " ".join(lines[-2:]) if lines else f"exit code {result.returncode}"
        raise AppError(f"Could not {what}: {reason}", 400)
    return result


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Mono float samples (-1..1) -> 16-bit PCM WAV."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def probe_duration(path: Path) -> float:
    """Duration of any audio/video file, via ffprobe."""
    result = run_tool(
        [require_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        f"read {path.name}",
    )
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AppError(f"{path.name} has no readable duration. Is it really an audio file?", 400) from exc


def transcode_to_wav(source: Path, target: Path, *, sample_rate: int = 48_000, trim_silence: bool = False) -> None:
    """Any audio FFmpeg can read -> mono 16-bit WAV. Optionally trims silence at both ends."""
    filters = []
    if trim_silence:
        # Remove leading/trailing silence (e.g. before you start talking and the click on Stop),
        # keeping a short natural pause at each end.
        trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15"
        filters = [trim, "areverse", trim, "areverse"]
    args = [require_tool("ffmpeg"), "-hide_banner", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", str(sample_rate)]
    if filters:
        args += ["-af", ",".join(filters)]
    args += ["-c:a", "pcm_s16le", str(target)]
    run_tool(args, f"read the audio in {source.name}")
