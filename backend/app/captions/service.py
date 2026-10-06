"""Generate captions for a project's voiceover."""

from __future__ import annotations

import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.captions.align import align_to_script
from app.captions.whisper import TimedWord, Transcriber
from app.core.config import Settings
from app.core.errors import AppError
from app.core.jobs import Job
from app.pronunciations.store import PronunciationStore
from app.voiceover.normalize import normalize_for_speech

log = logging.getLogger("shorts.captions")

# Below this share of matching letters, the voiceover doesn't follow the script closely
# enough (an ad-libbed recording), so the captions use what Whisper heard instead.
MIN_SCRIPT_MATCH = 0.6


class CaptionService:
    def __init__(self, settings: Settings, transcriber: Transcriber | None = None) -> None:
        self.settings = settings
        self.transcriber = transcriber or Transcriber(settings.models_dir, settings.whisper_model)

    def model_ready(self) -> bool:
        return self.transcriber.model_ready()

    def generate(self, audio: Path, voiceover_file: str, script: str | None, job: Job) -> dict[str, Any]:
        name = self.transcriber.model_name
        if not self.model_ready():
            def downloaded(done: int, total: int) -> None:
                if total:
                    job.update(0.3 * done / total, f"Downloading the Whisper model… {done / 1e6:.0f} / {total / 1e6:.0f} MB")
                else:
                    job.update(None, f"Downloading the Whisper model… {done / 1e6:.0f} MB")

            self.transcriber.ensure_downloaded(downloaded)

        job.update(0.3, f"Loading Whisper ({name})…")
        self.transcriber.load()
        job.update(0.32, "Listening to the voiceover…")
        started = time.perf_counter()
        heard = self.transcriber.transcribe(
            audio, lambda share: job.update(0.32 + 0.6 * share, f"Listening to the voiceover… {share:.0%}")
        )
        log.info("Transcribed %s: %d words in %.1fs", voiceover_file, len(heard), time.perf_counter() - started)
        if not heard:
            raise AppError("No speech was found in the voiceover.", 400)

        job.update(0.95, "Matching words to your script…")
        words, source, matched = heard, "transcript", None
        if script and script.strip():
            # How each script word was said: the pronunciation list and the default rules
            # (e.g. "5.0" -> "five point oh") change what Kokoro reads, not the captions.
            entries = PronunciationStore(self.settings.data_dir).load()
            aligned, matched = align_to_script(script, heard, lambda word: normalize_for_speech(word, entries))
            log.info("Script match: %.0f%% of letters", matched * 100)
            if aligned and matched >= MIN_SCRIPT_MATCH:
                words, source = aligned, "script"
        return {
            "words": [_word(w) for w in words],
            "source": source,
            "matched": None if matched is None else round(matched, 3),
            "model": name,
            "voiceoverFile": voiceover_file,
        }


def _word(word: TimedWord) -> dict[str, Any]:
    return {"text": word.text, "start": round(word.start, 3), "end": round(word.end, 3)}


@lru_cache
def get_caption_service(settings: Settings) -> CaptionService:
    return CaptionService(settings)
