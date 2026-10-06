"""Voiceover endpoints with a fake Kokoro engine (no model download needed)."""

from __future__ import annotations

import shutil
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.projects.store import collect_garbage
from app.voiceover.kokoro import SAMPLE_RATE
from app.voiceover.router import get_service
from app.voiceover.service import VoiceoverService

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is not installed")


class FakeEngine:
    """Returns 10 ms of tone per phoneme instead of running the model."""

    provider = "CPUExecutionProvider"
    provider_label = "CPU"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def load(self) -> None:
        pass

    def synthesize(self, phonemes: str, voice_id: str, speed: float = 1.0) -> np.ndarray:
        self.calls.append((phonemes, voice_id, speed))
        t = np.arange(int(SAMPLE_RATE * 0.01 * len(phonemes) / speed)) / SAMPLE_RATE
        return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(settings: Settings, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    service = VoiceoverService(settings, engine=engine)
    monkeypatch.setattr(service, "model_ready", lambda: True)
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client


def wait_for_job(client: TestClient, job: dict, timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    while job["status"] in ("queued", "running"):
        assert time.time() < deadline, "job timed out"
        time.sleep(0.05)
        job = client.get(f"/api/jobs/{job['id']}").json()
    return job


def make_audio(path: Path, seconds: float = 1.5, lead_silence: float = 0.0) -> Path:
    tone = f"sine=frequency=330:duration={seconds}"
    source = f"aevalsrc=0:d={lead_silence}[s];{tone}[t];[s][t]concat=v=0:a=1" if lead_silence else tone
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source, str(path)],
        check=True,
    )
    return path


def test_ai_read_job_writes_a_voiceover(client: TestClient, engine: FakeEngine, settings: Settings) -> None:
    job = client.post(
        "/api/projects/p-1/voiceover/ai",
        json={"text": "The RX 9060 XT has 16GB of VRAM.", "voiceId": "am_michael", "speed": 1.2},
    ).json()
    job = wait_for_job(client, job)
    assert job["status"] == "done", job
    voiceover = job["result"]
    assert voiceover["source"] == "ai"
    assert voiceover["voiceId"] == "am_michael"
    assert voiceover["speed"] == 1.2
    assert voiceover["script"] == "The RX 9060 XT has 16GB of VRAM."
    assert voiceover["duration"] > 0
    assert (settings.projects_dir / "p-1" / "media" / voiceover["file"]).is_file()
    # The normalized phonemes reached the engine ("sixteen gigabytes").
    assert "ɡˈɪɡəbˌIts" in engine.calls[0][0]

    audio = client.get(f"/api/projects/p-1/media/{voiceover['file']}")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/x-wav" or audio.headers["content-type"].startswith("audio/")


def test_media_supports_range_requests(client: TestClient) -> None:
    job = wait_for_job(client, client.post("/api/projects/p-1/voiceover/ai", json={"text": "Hello there.", "voiceId": "af_heart"}).json())
    url = f"/api/projects/p-1/media/{job['result']['file']}"
    partial = client.get(url, headers={"Range": "bytes=0-99"})
    assert partial.status_code == 206
    assert len(partial.content) == 100


def test_ai_read_rejects_empty_script_and_unknown_voice(client: TestClient) -> None:
    empty = client.post("/api/projects/p-1/voiceover/ai", json={"text": "   ", "voiceId": "af_heart"})
    assert empty.status_code == 400
    assert "script" in empty.json()["detail"]
    unknown = client.post("/api/projects/p-1/voiceover/ai", json={"text": "Hi", "voiceId": "nope"})
    assert unknown.status_code == 400
    assert "Unknown voice" in unknown.json()["detail"]


def test_ai_read_failure_reports_the_reason(client: TestClient, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_args, **_kwargs):
        raise RuntimeError("ONNX Runtime exploded")

    monkeypatch.setattr(engine, "synthesize", broken)
    job = wait_for_job(client, client.post("/api/projects/p-1/voiceover/ai", json={"text": "Hi.", "voiceId": "af_heart"}).json())
    assert job["status"] == "error"
    assert job["error"] == "RuntimeError: ONNX Runtime exploded"


def test_voice_preview_is_cached(client: TestClient, engine: FakeEngine) -> None:
    first = client.get("/api/voices/bf_emma/preview")
    assert first.status_code == 200
    assert first.headers["content-type"] == "audio/wav"
    client.get("/api/voices/bf_emma/preview")
    assert len(engine.calls) == 1


def test_missing_job_is_404(client: TestClient) -> None:
    assert client.get("/api/jobs/doesnotexist").status_code == 404


@needs_ffmpeg
@pytest.mark.parametrize("extension", ["mp3", "wav", "m4a"])
def test_upload_voiceover_formats(client: TestClient, tmp_path: Path, extension: str) -> None:
    source = make_audio(tmp_path / f"take.{extension}")
    with source.open("rb") as f:
        response = client.post("/api/projects/p-1/voiceover/upload", files={"file": (source.name, f)})
    assert response.status_code == 200, response.text
    voiceover = response.json()
    assert voiceover["source"] == "upload"
    assert voiceover["name"] == source.name
    assert voiceover["file"].endswith(".wav")
    assert voiceover["duration"] == pytest.approx(1.5, abs=0.1)


@needs_ffmpeg
def test_recording_is_trimmed(client: TestClient, tmp_path: Path) -> None:
    source = make_audio(tmp_path / "recording.webm", seconds=1.5, lead_silence=1.0)
    with source.open("rb") as f:
        response = client.post(
            "/api/projects/p-1/voiceover/upload",
            files={"file": ("recording.webm", f)},
            data={"source": "recording"},
        )
    assert response.status_code == 200, response.text
    voiceover = response.json()
    assert voiceover["source"] == "recording"
    assert voiceover["duration"] < 2.0  # the second of leading silence is gone


def test_upload_rejects_unsupported_files(client: TestClient) -> None:
    response = client.post("/api/projects/p-1/voiceover/upload", files={"file": ("notes.txt", b"hello")})
    assert response.status_code == 415
    assert "supported" in response.json()["detail"]


@needs_ffmpeg
def test_corrupt_audio_reports_ffmpeg_reason(client: TestClient) -> None:
    response = client.post("/api/projects/p-1/voiceover/upload", files={"file": ("broken.mp3", b"not really an mp3" * 50)})
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Could not read the audio")


@needs_ffmpeg
def test_music_upload_keeps_the_file(client: TestClient, tmp_path: Path, settings: Settings) -> None:
    source = make_audio(tmp_path / "beat.mp3", seconds=3)
    with source.open("rb") as f:
        response = client.post("/api/projects/p-1/music/upload", files={"file": ("beat.mp3", f)})
    assert response.status_code == 200, response.text
    music = response.json()
    assert music["name"] == "beat.mp3"
    assert music["file"].startswith("music-") and music["file"].endswith(".mp3")
    assert music["duration"] == pytest.approx(3, abs=0.1)
    assert (settings.projects_dir / "p-1" / "media" / music["file"]).is_file()


def test_unused_generated_media_is_cleaned_up(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    for name in ("voiceover-old.wav", "voiceover-current.wav", "voiceover-fresh.wav", "music-old.mp3", "clip-keep.mp4"):
        (media / name).write_bytes(b"x")
    now = time.time()
    for name in ("voiceover-old.wav", "voiceover-current.wav", "music-old.mp3", "clip-keep.mp4"):
        old = now - 3600
        import os

        os.utime(media / name, (old, old))
    collect_garbage(media, {"voiceover-current.wav"}, now=now)
    assert sorted(p.name for p in media.iterdir()) == ["clip-keep.mp4", "voiceover-current.wav", "voiceover-fresh.wav"]
