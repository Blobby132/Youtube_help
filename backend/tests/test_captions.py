"""Captions: script alignment, onset snapping, the captions job and the fonts API."""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.captions.align import align_to_script, script_words
from app.captions.router import get_service
from app.captions.service import CaptionService
from app.captions.whisper import TimedWord, snap_to_speech
from app.core.config import Settings, get_settings
from app.core.media import write_wav
from app.main import create_app

W = TimedWord


def heard(*words: tuple[str, float, float]) -> list[TimedWord]:
    return [W(*w) for w in words]


# --- alignment -------------------------------------------------------------------------


def test_exact_match_keeps_whisper_timings() -> None:
    words, ratio = align_to_script("Hello there, friend.", heard(("Hello", 0.1, 0.4), ("there,", 0.4, 0.7), ("friend.", 0.8, 1.2)))
    assert ratio == 1.0
    assert [(w.text, w.start, w.end) for w in words] == [("Hello", 0.1, 0.4), ("there,", 0.4, 0.7), ("friend.", 0.8, 1.2)]


def test_script_spelling_wins_over_transcript_spelling() -> None:
    transcript = heard(("The", 0.0, 0.2), ("RX9060XD", 0.2, 1.4), ("has", 1.4, 1.6), ("16", 1.6, 2.0), ("GB", 2.0, 2.4))
    words, ratio = align_to_script("The RX 9060 XT has 16GB", transcript)
    assert [w.text for w in words] == ["The", "RX", "9060", "XT", "has", "16GB"]
    assert ratio > 0.85
    sixteen_gb = words[-1]
    assert sixteen_gb.start == pytest.approx(1.6) and sixteen_gb.end == pytest.approx(2.4)


def test_unmatched_words_fill_the_gap() -> None:
    transcript = heard(("at", 0.0, 0.2), ("35,000", 0.2, 1.4), ("feet.", 1.4, 1.8))
    words, _ = align_to_script("at thirty five thousand feet.", transcript)
    middle = words[1:4]
    assert [w.text for w in middle] == ["thirty", "five", "thousand"]
    assert middle[0].start == pytest.approx(0.2)
    assert middle[-1].end == pytest.approx(1.4)
    assert all(a.end <= b.start + 1e-6 for a, b in zip(middle, middle[1:], strict=False))


def test_times_never_go_backwards() -> None:
    transcript = heard(("one", 0.0, 0.3), ("two", 0.3, 0.6), ("three", 0.6, 0.9))
    words, _ = align_to_script("three two one", transcript)
    starts = [w.start for w in words]
    assert starts == sorted(starts)
    assert all(w.end > w.start for w in words)


def test_unrelated_script_scores_low() -> None:
    _, ratio = align_to_script("Completely different words here", heard(("Banana", 0, 0.5), ("smoothie", 0.5, 1.0)))
    assert ratio < 0.6


def test_script_words_strip_pronunciation_markup_and_join_dashes() -> None:
    assert script_words("Say [Kokoro](/kˈOkəɹO/) — now… really") == ["Say", "Kokoro —", "now…", "really"]


# --- onset snapping --------------------------------------------------------------------


def test_word_start_snaps_to_speech_onset() -> None:
    rate = 16_000
    audio = np.concatenate([np.zeros(int(0.5 * rate)), 0.3 * np.sin(np.linspace(0, 400 * np.pi, rate))]).astype(np.float32)
    snapped = snap_to_speech([W("Every", 0.0, 0.9)], audio, rate)
    assert snapped[0].start == pytest.approx(0.48, abs=0.03)


def test_snap_never_moves_a_start_earlier() -> None:
    rate = 16_000
    audio = (0.3 * np.ones(rate)).astype(np.float32)
    assert snap_to_speech([W("Hi", 0.4, 0.8)], audio, rate)[0].start == 0.4


# --- captions job with a fake transcriber ----------------------------------------------


class FakeTranscriber:
    model_name = "fake.en"

    def __init__(self, words: list[TimedWord]) -> None:
        self.words = words

    def model_ready(self) -> bool:
        return True

    def ensure_downloaded(self, progress=None) -> None:
        pass

    def load(self) -> None:
        pass

    def transcribe(self, audio_path: Path, progress=None) -> list[TimedWord]:
        assert audio_path.is_file()
        if progress:
            progress(1.0)
        return self.words


@pytest.fixture
def transcriber() -> FakeTranscriber:
    return FakeTranscriber(heard(("Every", 0.3, 0.6), ("airplane", 0.6, 1.0), ("window.", 1.0, 1.5)))


@pytest.fixture
def client(settings: Settings, transcriber: FakeTranscriber) -> Iterator[TestClient]:
    service = CaptionService(settings, transcriber=transcriber)  # type: ignore[arg-type]
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def voiceover(settings: Settings) -> str:
    name = "voiceover-test.wav"
    write_wav(settings.projects_dir / "p-1" / "media" / name, np.zeros(16_000, dtype=np.float32), 16_000)
    return name


def run_job(client: TestClient, body: dict) -> dict:
    response = client.post("/api/projects/p-1/captions", json=body)
    assert response.status_code == 200, response.text
    job = response.json()
    deadline = time.time() + 10
    while job["status"] in ("queued", "running"):
        assert time.time() < deadline
        time.sleep(0.05)
        job = client.get(f"/api/jobs/{job['id']}").json()
    return job


def test_captions_follow_the_script(client: TestClient, voiceover: str) -> None:
    job = run_job(client, {"file": voiceover, "script": "Every air-plane window."})
    assert job["status"] == "done", job
    result = job["result"]
    assert result["source"] == "script"
    assert result["voiceoverFile"] == voiceover
    assert [w["text"] for w in result["words"]] == ["Every", "air-plane", "window."]


def test_captions_fall_back_to_the_transcript(client: TestClient, voiceover: str) -> None:
    job = run_job(client, {"file": voiceover, "script": "Something I never actually said out loud."})
    result = job["result"]
    assert result["source"] == "transcript"
    assert [w["text"] for w in result["words"]] == ["Every", "airplane", "window."]
    assert result["matched"] < 0.6


def test_captions_without_script_use_the_transcript(client: TestClient, voiceover: str) -> None:
    result = run_job(client, {"file": voiceover})["result"]
    assert result["source"] == "transcript" and result["matched"] is None


def test_captions_for_missing_file_is_404(client: TestClient) -> None:
    response = client.post("/api/projects/p-1/captions", json={"file": "voiceover-nope.wav"})
    assert response.status_code == 404


def test_no_speech_is_a_clear_error(client: TestClient, voiceover: str, transcriber: FakeTranscriber) -> None:
    transcriber.words = []
    job = run_job(client, {"file": voiceover})
    assert job["status"] == "error"
    assert "No speech" in job["error"]


def test_health_reports_the_caption_model(client: TestClient) -> None:
    captions = client.get("/api/health").json()["captions"]
    assert captions["model"] == "small.en"
    assert captions["modelReady"] is False  # nothing downloaded in the temp models folder


# --- fonts -----------------------------------------------------------------------------


def test_fonts_are_listed_and_served(client: TestClient) -> None:
    fonts = client.get("/api/fonts").json()
    assert fonts[0] == {"id": "montserrat", "name": "Montserrat Black"}
    assert len(fonts) == 8
    for font in fonts:
        response = client.get(f"/api/fonts/{font['id']}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "font/ttf"
        assert response.content[:4] in (b"\x00\x01\x00\x00", b"true", b"OTTO")
    assert client.get("/api/fonts/comic-sans").status_code == 404
