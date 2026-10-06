from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.voiceover.voices import VOICES


def make_project(project_id: str = "p-test", name: str = "Airplane windows") -> dict:
    return {"id": project_id, "name": name, "version": 1, "script": "Hello there."}


def test_health_reports_status(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["pexels"] is False
    assert body["canvas"] == {"width": 1080, "height": 1920, "fps": 30}


def test_voices_lists_kokoro_voices(client: TestClient) -> None:
    voices = client.get("/api/voices").json()
    assert [v["id"] for v in voices] == [v.id for v in VOICES]
    assert all(v["accent"] in {"US", "UK"} and v["description"] for v in voices)


def test_project_round_trip(client: TestClient, settings: Settings) -> None:
    saved = client.put("/api/projects/p-test", json=make_project())
    assert saved.status_code == 200
    assert saved.json()["name"] == "Airplane windows"

    on_disk = json.loads((settings.projects_dir / "p-test" / "project.json").read_text())
    assert on_disk["script"] == "Hello there."
    assert on_disk["updatedAt"] and on_disk["createdAt"]

    loaded = client.get("/api/projects/p-test").json()
    assert loaded["script"] == "Hello there."


def test_save_keeps_created_at(client: TestClient) -> None:
    client.put("/api/projects/p-test", json=make_project())
    first = client.get("/api/projects/p-test").json()
    client.put("/api/projects/p-test", json={**first, "script": "Changed"})
    second = client.get("/api/projects/p-test").json()
    assert second["createdAt"] == first["createdAt"]
    assert second["script"] == "Changed"


def test_list_projects_newest_first(client: TestClient) -> None:
    client.put("/api/projects/p-old", json=make_project("p-old", "Old"))
    client.put("/api/projects/p-new", json=make_project("p-new", "New"))
    names = [p["name"] for p in client.get("/api/projects").json()]
    assert names == ["New", "Old"]


def test_missing_project_is_404_with_reason(client: TestClient) -> None:
    response = client.get("/api/projects/nope")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_rejects_path_traversal_ids(client: TestClient) -> None:
    response = client.put("/api/projects/..%2Fevil", json=make_project("../evil"))
    assert response.status_code in {400, 404}


def test_rejects_mismatched_body_id(client: TestClient) -> None:
    response = client.put("/api/projects/p-a", json=make_project("p-b"))
    assert response.status_code == 400
    assert "does not match" in response.json()["detail"]
