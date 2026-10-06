"""The global pronunciation list: storage, API, and its use by the AI read."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.pronunciations.store import PronunciationStore
from app.voiceover.g2p import get_phonemizer
from app.voiceover.normalize import Pronunciation
from app.voiceover.router import get_service
from app.voiceover.service import VoiceoverService
from tests.test_voiceover_api import FakeEngine, wait_for_job


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


ENTRIES = [{"written": "5.0", "spoken": "five point oh"}, {"written": "GHz", "spoken": "gigahertz"}]


def test_list_starts_empty_and_saves_globally(client: TestClient, settings: Settings) -> None:
    assert client.get("/api/pronunciations").json() == {"entries": []}
    saved = client.put("/api/pronunciations", json={"entries": ENTRIES})
    assert saved.status_code == 200
    assert client.get("/api/pronunciations").json() == {"entries": ENTRIES}
    # One file for the whole app, outside the projects folder.
    on_disk = json.loads((settings.data_dir / "pronunciations.json").read_text(encoding="utf-8"))
    assert on_disk == {"entries": ENTRIES}
    assert not settings.projects_dir.exists() or not any(settings.projects_dir.rglob("pronunciations.json"))


def test_unfinished_rows_are_kept_but_not_used(client: TestClient) -> None:
    rows = [{"written": "5.0", "spoken": ""}, {"written": "", "spoken": "x"}]
    assert client.put("/api/pronunciations", json={"entries": rows}).json() == {"entries": rows}


def test_too_long_entries_are_rejected(client: TestClient) -> None:
    response = client.put("/api/pronunciations", json={"entries": [{"written": "x" * 101, "spoken": "y"}]})
    assert response.status_code == 400
    assert "too long" in response.json()["detail"]


def test_broken_file_is_ignored_and_kept(settings: Settings) -> None:
    store = PronunciationStore(settings.data_dir)
    store.path.parent.mkdir(parents=True)
    store.path.write_text("{not json", encoding="utf-8")
    assert store.load() == []
    assert store.path.with_suffix(".broken.json").read_text(encoding="utf-8") == "{not json"


def test_ai_read_uses_the_list_in_every_project(client: TestClient, engine: FakeEngine) -> None:
    client.put("/api/pronunciations", json={"entries": ENTRIES})
    oh = get_phonemizer(british=False).phonemize("five point oh")
    for project in ("p-one", "p-two"):
        job = client.post(
            f"/api/projects/{project}/voiceover/ai",
            json={"text": "PCIe 5.0 at 2.5GHz.", "voiceId": "af_heart"},
        ).json()
        job = wait_for_job(client, job)
        assert job["status"] == "done", job
        # The voiceover keeps your script as written...
        assert job["result"]["script"] == "PCIe 5.0 at 2.5GHz."
        # ...while Kokoro was given the spoken form.
        assert oh in engine.calls[-1][0]
        assert "ɡˈɪɡəhˌɜɹts" in engine.calls[-1][0]


def test_changes_apply_to_the_next_read(client: TestClient, engine: FakeEngine) -> None:
    def read() -> str:
        job = client.post("/api/projects/p-1/voiceover/ai", json={"text": "PCIe 5.0", "voiceId": "af_heart"}).json()
        wait_for_job(client, job)
        return engine.calls[-1][0]

    default = read()
    client.put("/api/pronunciations", json={"entries": ENTRIES})
    overridden = read()
    assert "zˈɪɹO" in default  # "five point zero"
    assert "zˈɪɹO" not in overridden and "ˈO" in overridden  # "five point oh"


def test_say_reads_a_line_with_the_list(client: TestClient, engine: FakeEngine) -> None:
    client.put("/api/pronunciations", json={"entries": ENTRIES})
    response = client.post("/api/voices/af_heart/say", json={"text": "5.0"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"
    # Each line gets a closing period so it ends with a natural pause.
    assert engine.calls[-1][0] == get_phonemizer(british=False).phonemize("five point oh.")


def test_say_rejects_empty_text(client: TestClient) -> None:
    assert client.post("/api/voices/af_heart/say", json={"text": ""}).status_code == 422


def test_store_round_trip(settings: Settings) -> None:
    store = PronunciationStore(settings.data_dir)
    entries = [Pronunciation("5.0", "five point oh")]
    store.save(entries)
    assert store.load() == entries
    assert time.time() - store.path.stat().st_mtime < 60
