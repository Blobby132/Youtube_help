"""Word-level transcription with faster-whisper on the CPU."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from app.captions.assets import ensure_whisper_model, is_ready, whisper_dir
from app.core.errors import AppError

log = logging.getLogger("shorts.captions")

SAMPLE_RATE = 16_000
MIN_WORD_SECONDS = 0.05


@dataclass(frozen=True)
class TimedWord:
    text: str
    start: float
    end: float


def cpu_threads() -> int:
    # Logical cores / 2 is roughly the physical core count, which CTranslate2 likes best.
    return max(1, min(8, (os.cpu_count() or 4) // 2))


def snap_to_speech(words: list[TimedWord], audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> list[TimedWord]:
    """Moves word starts forward to where speech actually begins.

    Whisper's timestamps tend to start a word early, e.g. the first word at 0.00 even
    when the voice starts later, which makes captions appear before the word is heard.
    Starts only ever move later, and never past the word's own end.
    """
    hop = sample_rate // 100  # 10 ms frames
    frames = len(audio) // hop
    if frames == 0:
        return words
    rms = np.sqrt(np.mean(audio[: frames * hop].reshape(frames, hop) ** 2, axis=1))
    threshold = max(0.008, 0.06 * float(np.percentile(rms, 95)))
    loud = rms > threshold

    snapped = []
    for word in words:
        first = int(word.start * 100)
        last = int(max(word.start, word.end - MIN_WORD_SECONDS) * 100)
        onset = next((i for i in range(first, min(last + 1, frames)) if loud[i]), None)
        start = word.start
        if onset is not None:
            start = max(word.start, onset / 100 - 0.02)
        snapped.append(replace(word, start=round(start, 3)))
    return snapped


def tidy(words: list[TimedWord]) -> list[TimedWord]:
    """Non-decreasing starts and a minimum length for every word."""
    result: list[TimedWord] = []
    previous = 0.0
    for word in words:
        start = max(word.start, previous)
        end = max(word.end, start + MIN_WORD_SECONDS)
        result.append(TimedWord(word.text, round(start, 3), round(end, 3)))
        previous = start
    return result


class Transcriber:
    def __init__(self, models_dir: Path, model_name: str) -> None:
        self.models_dir = models_dir
        self.model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    def model_ready(self) -> bool:
        return is_ready(whisper_dir(self.models_dir, self.model_name))

    def ensure_downloaded(self, progress: Callable[[int, int], None] | None = None) -> None:
        ensure_whisper_model(self.models_dir, self.model_name, progress)

    def load(self):
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                folder = whisper_dir(self.models_dir, self.model_name)
                if not is_ready(folder):
                    raise AppError("The Whisper model isn't downloaded. Run `npm run setup`.", 503)
                log.info("Loading Whisper %s on CPU (%d threads)", self.model_name, cpu_threads())
                self._model = WhisperModel(str(folder), device="cpu", compute_type="int8", cpu_threads=cpu_threads())
            return self._model

    def transcribe(self, audio_path: Path, progress: Callable[[float], None] | None = None) -> list[TimedWord]:
        from faster_whisper import decode_audio

        model = self.load()
        audio = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)
        duration = len(audio) / SAMPLE_RATE
        if duration < 0.2:
            raise AppError("The voiceover is too short to transcribe.", 400)
        segments, _info = model.transcribe(
            audio,
            language="en" if self.model_name.endswith(".en") else None,
            word_timestamps=True,
            beam_size=5,
            condition_on_previous_text=False,
            vad_filter=False,
        )
        words: list[TimedWord] = []
        for segment in segments:  # a generator: transcription happens while iterating
            for word in segment.words or []:
                text = word.word.strip()
                if text:
                    words.append(TimedWord(text, float(word.start), float(word.end)))
            if progress:
                progress(min(1.0, segment.end / duration))
        return tidy(snap_to_speech(words, audio))
