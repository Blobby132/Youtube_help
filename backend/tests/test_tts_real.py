"""End-to-end TTS with the real Kokoro model. Skipped until the model is downloaded
(`npm run setup`). The pronunciation samples are written to backend/tests/output/ so you can
listen to how numbers and tech terms come out."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.core.config import get_settings
from app.core.media import wav_duration, write_wav
from app.voiceover.assets import kokoro_dir, missing_files
from app.voiceover.kokoro import SAMPLE_RATE
from app.voiceover.service import VoiceoverService

OUTPUT = Path(__file__).parent / "output"
TECH_SENTENCE = "The RX 9060 XT has 16GB of VRAM and renders at 1080p."
MORE_SAMPLES = (
    "The RTX 4090 draws 450W, boosts to 2.5GHz and costs $1,599. "
    "Wait 5-10 minutes, or until 3:30 PM. Number 1: it's 2x faster at 1440p and 4K."
)

settings = get_settings()
pytestmark = pytest.mark.skipif(
    bool(missing_files(kokoro_dir(settings.models_dir))),
    reason="Kokoro model not downloaded; run `npm run setup`",
)


@pytest.fixture(scope="module")
def service() -> VoiceoverService:
    return VoiceoverService(settings)


@pytest.mark.parametrize("voice_id", ["af_heart", "am_michael", "bm_george"])
def test_pronunciation_sample(service: VoiceoverService, voice_id: str) -> None:
    audio = service.synthesize(TECH_SENTENCE, voice_id)
    path = OUTPUT / f"pronunciation-{voice_id}.wav"
    write_wav(path, audio, SAMPLE_RATE)
    print(f"\nListen: {path}")

    seconds = wav_duration(path)
    # ~17 spoken words: a natural read takes roughly 4-8 seconds.
    assert 3.0 < seconds < 10.0
    assert float(np.sqrt(np.mean(audio**2))) > 0.01, "audio is (nearly) silent"


def test_longer_sample_with_numbers(service: VoiceoverService) -> None:
    audio = service.synthesize(MORE_SAMPLES, "af_heart", speed=1.1)
    path = OUTPUT / "pronunciation-numbers-af_heart.wav"
    write_wav(path, audio, SAMPLE_RATE)
    print(f"\nListen: {path}")
    assert 6.0 < wav_duration(path) < 25.0


def test_speed_changes_length(service: VoiceoverService) -> None:
    normal = service.synthesize("Every airplane window has a tiny hole in it.", "af_heart", 1.0)
    fast = service.synthesize("Every airplane window has a tiny hole in it.", "af_heart", 1.4)
    assert len(fast) < len(normal) * 0.9
