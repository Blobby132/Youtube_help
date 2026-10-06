"""End to end: Kokoro speaks a sentence, faster-whisper transcribes it on the CPU, and the
words are matched back to the script. Skipped until both models are downloaded."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.captions.align import align_to_script, script_words
from app.captions.assets import is_ready, whisper_dir
from app.captions.whisper import Transcriber
from app.core.config import get_settings
from app.core.media import wav_duration, write_wav
from app.voiceover.assets import kokoro_dir, missing_files
from app.voiceover.kokoro import SAMPLE_RATE
from app.voiceover.service import VoiceoverService

settings = get_settings()
pytestmark = pytest.mark.skipif(
    bool(missing_files(kokoro_dir(settings.models_dir)))
    or not is_ready(whisper_dir(settings.models_dir, settings.whisper_model)),
    reason="Kokoro or Whisper model not downloaded; run `npm run setup`",
)

SCRIPT = "The RX 9060 XT has 16GB of VRAM and renders at 1080p. Every airplane window has a tiny hole in it."


def test_transcribe_and_align_a_kokoro_read(tmp_path: Path) -> None:
    audio = VoiceoverService(settings).synthesize(SCRIPT, "am_michael")
    path = tmp_path / "read.wav"
    write_wav(path, audio, SAMPLE_RATE)
    duration = wav_duration(path)

    heard = Transcriber(settings.models_dir, settings.whisper_model).transcribe(path)
    assert len(heard) >= 15
    assert "airplane" in " ".join(w.text.lower() for w in heard)

    words, ratio = align_to_script(SCRIPT, heard)
    assert ratio > 0.8
    assert [w.text for w in words] == script_words(SCRIPT)
    starts = [w.start for w in words]
    assert starts == sorted(starts)
    assert words[0].start > 0.0  # snapped to where the voice starts, not 0.00
    assert words[-1].end <= duration + 0.05


def test_pronunciation_entries_keep_captions_in_your_spelling(tmp_path: Path) -> None:
    """Kokoro says "five point oh gigahertz"; the captions still read "5.0" and "GHz"."""
    from app.voiceover.g2p import get_phonemizer
    from app.voiceover.normalize import Pronunciation, normalize_for_speech
    from app.voiceover.service import join_chunks

    script = "The new chip runs at 5.0 GHz all day long."
    entries = [Pronunciation("5.0", "five point oh"), Pronunciation("GHz", "gigahertz")]
    engine = VoiceoverService(settings).engine
    chunks = get_phonemizer(british=False).chunks(script, entries)
    audio = join_chunks([(c, engine.synthesize(c, "am_michael")) for c in chunks], 1.0)
    path = tmp_path / "read.wav"
    write_wav(path, audio, SAMPLE_RATE)

    heard = Transcriber(settings.models_dir, settings.whisper_model).transcribe(path)
    words, ratio = align_to_script(script, heard, lambda w: normalize_for_speech(w, entries))
    assert [w.text for w in words] == script_words(script)
    assert ratio > 0.8
    five, ghz = words[5], words[6]
    assert five.text == "5.0" and ghz.text == "GHz"
    assert five.start < ghz.start < words[7].start
