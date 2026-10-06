"""Voiceover use cases: AI read with Kokoro, voice previews, imported recordings/uploads."""

from __future__ import annotations

import logging
import secrets
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import Settings
from app.core.errors import AppError
from app.core.jobs import Job
from app.core.media import transcode_to_wav, wav_bytes, wav_duration, write_wav
from app.pronunciations.store import PronunciationStore
from app.voiceover.assets import ensure_kokoro_files, kokoro_dir, missing_files
from app.voiceover.g2p import get_phonemizer
from app.voiceover.kokoro import SAMPLE_RATE, KokoroEngine
from app.voiceover.voices import Voice, get_voice

log = logging.getLogger("shorts.tts")

MIN_SPEED, MAX_SPEED = 0.5, 2.0
PREVIEW_VERSION = 2

# Kokoro pads every chunk with ~0.3-0.7 s of silence. Chunks are trimmed and re-joined with
# pauses close to the ones it leaves between sentences inside a chunk (scaled by speed).
SILENCE_THRESHOLD = 0.005  # about -46 dBFS
EDGE_MARGIN = 0.04
LEAD_IN = 0.05
SENTENCE_PAUSE = 0.45
CLAUSE_PAUSE = 0.25
TAIL = 0.3


def new_media_name(prefix: str, extension: str) -> str:
    """Unique, file-system safe name like voiceover-20261006-153012-a1b2.wav."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{prefix}-{stamp}-{secrets.token_hex(2)}.{extension.lstrip('.')}"


def trim_silence(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Cuts silence off both ends, keeping a few milliseconds so soft sounds aren't clipped."""
    if audio.size == 0:
        return audio
    window = max(1, sample_rate // 100)
    envelope = np.convolve(np.abs(audio), np.ones(window) / window, mode="same")
    loud = np.flatnonzero(envelope > SILENCE_THRESHOLD)
    if loud.size == 0:
        return audio[:0]
    margin = int(EDGE_MARGIN * sample_rate)
    return audio[max(0, loud[0] - margin) : min(audio.size, loud[-1] + margin)]


def join_chunks(chunks: list[tuple[str, np.ndarray]], speed: float, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Joins trimmed chunk audio with natural pauses; `chunks` pairs phonemes with audio."""

    def silence(seconds: float) -> np.ndarray:
        return np.zeros(int(seconds / speed * sample_rate), dtype=np.float32)

    parts = [silence(LEAD_IN)]
    for index, (phonemes, audio) in enumerate(chunks):
        parts.append(trim_silence(audio, sample_rate))
        if index < len(chunks) - 1:
            ends_sentence = phonemes.rstrip()[-1:] in ".!?…"
            parts.append(silence(SENTENCE_PAUSE if ends_sentence else CLAUSE_PAUSE))
    parts.append(silence(TAIL))
    return np.concatenate(parts)


def require_voice(voice_id: str) -> Voice:
    voice = get_voice(voice_id)
    if voice is None:
        raise AppError(f"Unknown voice: {voice_id}", 400)
    return voice


class VoiceoverService:
    def __init__(self, settings: Settings, engine: KokoroEngine | None = None) -> None:
        self.settings = settings
        self.model_dir = kokoro_dir(settings.models_dir)
        self.engine = engine or KokoroEngine(self.model_dir, settings.tts_device)
        self._preview_lock = threading.Lock()

    def model_ready(self) -> bool:
        return not missing_files(self.model_dir)

    def synthesize(
        self,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        progress: Callable[[float], None] | None = None,
    ) -> np.ndarray:
        voice = require_voice(voice_id)
        if not MIN_SPEED <= speed <= MAX_SPEED:
            raise AppError(f"Speed must be between {MIN_SPEED} and {MAX_SPEED}", 400)
        pronunciations = PronunciationStore(self.settings.data_dir).load()
        chunks = get_phonemizer(british=voice.accent == "UK").chunks(text, pronunciations)
        if not chunks:
            raise AppError("The script has no words to read.", 400)
        log.info("Synthesizing %d chunk(s) with %s at %.2fx", len(chunks), voice_id, speed)
        parts = []
        for index, chunk in enumerate(chunks):
            parts.append((chunk, self.engine.synthesize(chunk, voice_id, speed)))
            if progress:
                progress((index + 1) / len(chunks))
        return join_chunks(parts, speed)

    def generate_ai_read(self, media_dir: Path, text: str, voice_id: str, speed: float, job: Job) -> dict[str, Any]:
        voice = require_voice(voice_id)
        if not text.strip():
            raise AppError("Write a script first: the AI read speaks it word for word.", 400)

        if not self.model_ready():
            def downloaded(done: int, total: int) -> None:
                job.update(0.4 * done / total, f"Downloading the Kokoro voice model… {done / 1e6:.0f} / {total / 1e6:.0f} MB")

            ensure_kokoro_files(self.settings.models_dir, downloaded)

        job.update(0.4, "Loading Kokoro…")
        self.engine.load()
        job.update(0.42, f"Reading with {voice.name} on {self.engine.provider_label}…")
        started = time.perf_counter()
        audio = self.synthesize(
            text,
            voice_id,
            speed,
            lambda share: job.update(0.42 + 0.55 * share, f"Reading with {voice.name} on {self.engine.provider_label}… {share:.0%}"),
        )
        duration = len(audio) / SAMPLE_RATE
        log.info(
            "AI read: %.1fs of audio in %.1fs on %s",
            duration,
            time.perf_counter() - started,
            self.engine.provider_label,
        )

        name = new_media_name("voiceover", "wav")
        write_wav(media_dir / name, audio, SAMPLE_RATE)
        return {
            "source": "ai",
            "file": name,
            "duration": round(duration, 3),
            "voiceId": voice_id,
            "speed": speed,
            "script": text,
        }

    def voice_preview(self, voice_id: str) -> Path:
        """A short sample of the voice, generated once and cached on disk."""
        voice = require_voice(voice_id)
        path = self.model_dir / "previews" / f"{voice_id}-v{PREVIEW_VERSION}.wav"
        with self._preview_lock:
            if path.is_file():
                return path
            if not self.model_ready():
                raise AppError(
                    "The Kokoro model isn't downloaded yet. Click Generate AI read once (it downloads "
                    "the model) or run `npm run setup`.",
                    409,
                )
            sample = f"Hi, I'm {voice.name}. This is how your next Short could sound."
            write_wav(path, self.synthesize(sample, voice_id), SAMPLE_RATE)
        return path

    def say(self, text: str, voice_id: str) -> bytes:
        """A short line read with the current pronunciation list, as WAV bytes (to try an entry)."""
        if not self.model_ready():
            raise AppError("The Kokoro model isn't downloaded yet. Run `npm run setup`.", 409)
        return wav_bytes(self.synthesize(text, voice_id), SAMPLE_RATE)

    @staticmethod
    def import_audio(media_dir: Path, upload: Path, original_name: str, source: str) -> dict[str, Any]:
        """A recording or uploaded take -> mono WAV voiceover in the project's media folder."""
        name = new_media_name("voiceover", "wav")
        target = media_dir / name
        try:
            transcode_to_wav(upload, target, trim_silence=source == "recording")
            duration = wav_duration(target)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        if duration < 0.3:
            target.unlink(missing_ok=True)
            raise AppError("That audio is empty or silent. Try again.", 400)
        return {
            "source": source,
            "file": name,
            "duration": round(duration, 3),
            "name": original_name,
        }


@lru_cache
def get_voiceover_service(settings: Settings) -> VoiceoverService:
    return VoiceoverService(settings)
