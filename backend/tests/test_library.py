"""The shared media library: adding clips (one function for every source), imports, the
AI-generated flag, deleting, and which projects contain AI footage."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.errors import AppError
from app.library.store import ClipMetadata, Library, PexelsCredit
from app.library.usage import ai_clips
from tests.media_files import codec_of, make_image, make_video, needs_ffmpeg
from tests.test_voiceover_api import wait_for_job

pytestmark = needs_ffmpeg


@pytest.fixture
def library(settings: Settings) -> Library:
    return Library(settings.library_dir)


def import_file(client: TestClient, path: Path, ai: bool | None = None, **fields: str) -> dict:
    data = {**fields, **({} if ai is None else {"aiGenerated": "true" if ai else "false"})}
    with path.open("rb") as handle:
        response = client.post("/api/library/import", files={"file": (path.name, handle)}, data=data)
    assert response.status_code == 200, response.text
    return wait_for_job(client, response.json())


def save_project(client: TestClient, project_id: str, name: str, media_ids: list[str]) -> None:
    clips = [
        {"id": f"c{i}", "mediaId": media_id, "start": i * 2.0, "duration": 2.0, "inPoint": 0, "speed": 1}
        for i, media_id in enumerate(media_ids)
    ]
    response = client.put(f"/api/projects/{project_id}", json={"id": project_id, "name": name, "clips": clips})
    assert response.status_code == 200


# add_clip: the one way in -------------------------------------------------------------------


def test_add_clip_reads_the_file_and_records_where_it_came_from(library: Library, tmp_path: Path) -> None:
    video = make_video(library.incoming_dir / "LTX_2_5_t2v_00017_.mp4", 448, 832, seconds=2.0, audio=True)
    item = library.add_clip(video, "ai", ClipMetadata(name="Neon city", generation={"prompt": "neon city at night"}))

    assert item["kind"] == "video"
    assert (item["width"], item["height"]) == (448, 832)
    assert item["duration"] == pytest.approx(2.0, abs=0.1)
    assert item["fps"] == pytest.approx(24)
    assert item["hasAudio"] is True
    assert item["source"] == "ai"
    assert item["aiGenerated"] is True  # an AI shot is always flagged
    assert item["lowRes"] is True  # narrower than 1080 pixels
    assert item["generation"] == {"prompt": "neon city at night"}
    assert not video.exists()  # moved into the library
    assert library.file_path(item["id"]).is_file()
    assert library.thumbnail_path(item["id"]).is_file()
    assert library.list() == [item]


def test_add_clip_keeps_the_pexels_credit(library: Library) -> None:
    video = make_video(library.incoming_dir / "download.mp4", 1080, 1920, seconds=1.0)
    credit = PexelsCredit(1093662, "https://www.pexels.com/video/waves-1093662/", "Jane Doe", "https://www.pexels.com/@jane")
    item = library.add_clip(video, "pexels", ClipMetadata(name="Waves", pexels=credit))

    assert item["pexels"] == {
        "videoId": 1093662,
        "url": "https://www.pexels.com/video/waves-1093662/",
        "photographer": "Jane Doe",
        "photographerUrl": "https://www.pexels.com/@jane",
    }
    assert item["aiGenerated"] is False
    assert item["lowRes"] is False
    assert library.find_pexels(1093662) == item


def test_add_clip_rejects_an_unknown_source(library: Library) -> None:
    video = make_video(library.incoming_dir / "x.mp4", seconds=0.5)
    with pytest.raises(AppError, match="Unknown clip source"):
        library.add_clip(video, "camera", ClipMetadata(name="x"))  # type: ignore[arg-type]


def test_newest_items_come_first(library: Library) -> None:
    first = library.add_clip(make_video(library.incoming_dir / "a.mp4", seconds=0.5), "upload", ClipMetadata(name="A"))
    second = library.add_clip(make_image(library.incoming_dir / "b.png"), "upload", ClipMetadata(name="B"))
    assert [i["id"] for i in library.list()] == [second["id"], first["id"]]
    assert second["kind"] == "image" and second["duration"] is None


def test_videos_the_browser_cant_play_are_converted(library: Library) -> None:
    hevc = make_video(library.incoming_dir / "clip.mkv", 1920, 1080, seconds=1.0, codec="libx265")
    item = library.add_clip(hevc, "upload", ClipMetadata(name="HEVC"))
    stored = library.file_path(item["id"])
    assert stored.suffix == ".mp4"
    assert codec_of(stored) == "h264"
    assert (item["width"], item["height"]) == (1920, 1080)


def test_upright_phone_videos_report_their_upright_size(library: Library, tmp_path: Path) -> None:
    import subprocess

    sideways = make_video(tmp_path / "raw.mp4", 1280, 720, seconds=1.0)
    rotated = library.incoming_dir / "phone.mov"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-display_rotation:v:0", "90",
         "-i", str(sideways), "-c", "copy", str(rotated)],
        check=True,
    )
    item = library.add_clip(rotated, "upload", ClipMetadata(name="Phone"))
    assert (item["width"], item["height"]) == (720, 1280)


# Import over HTTP ----------------------------------------------------------------------------


def test_import_a_clip_with_the_ai_flag(client: TestClient, tmp_path: Path) -> None:
    video = make_video(tmp_path / "LTX_2_5_t2v_00017_.mp4", 448, 832, seconds=1.5)
    job = import_file(client, video, ai=True)
    assert job["status"] == "done", job["error"]
    item = job["result"]
    assert item["source"] == "upload"
    assert item["aiGenerated"] is True
    assert item["originalName"] == "LTX_2_5_t2v_00017_.mp4"
    assert item["name"] == "LTX_2_5_t2v_00017_"
    assert item["lowRes"] is True
    assert client.get("/api/library").json() == [item]


def test_imports_are_not_ai_generated_unless_ticked(client: TestClient, tmp_path: Path) -> None:
    job = import_file(client, make_video(tmp_path / "beach.mp4", 1080, 1920, seconds=1.0), name="Beach at dusk")
    item = job["result"]
    assert item["aiGenerated"] is False
    assert item["name"] == "Beach at dusk"
    assert item["lowRes"] is False


def test_import_an_image(client: TestClient, tmp_path: Path) -> None:
    item = import_file(client, make_image(tmp_path / "poster.png", 1080, 1350), ai=False)["result"]
    assert item["kind"] == "image"
    assert (item["width"], item["height"]) == (1080, 1350)
    assert client.get(f"/api/library/{item['id']}/file").headers["content-type"] == "image/png"


def test_clip_files_support_seeking(client: TestClient, tmp_path: Path) -> None:
    item = import_file(client, make_video(tmp_path / "clip.mp4", seconds=1.0))["result"]
    whole = client.get(f"/api/library/{item['id']}/file")
    assert whole.status_code == 200
    part = client.get(f"/api/library/{item['id']}/file", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206
    assert len(part.content) == 100
    thumbnail = client.get(f"/api/library/{item['id']}/thumbnail")
    assert thumbnail.status_code == 200 and thumbnail.headers["content-type"] == "image/jpeg"


def test_unsupported_and_broken_files_get_the_real_reason(client: TestClient, tmp_path: Path) -> None:
    text = tmp_path / "notes.txt"
    text.write_text("hello")
    with text.open("rb") as handle:
        response = client.post("/api/library/import", files={"file": ("notes.txt", handle)})
    assert response.status_code == 415
    assert "isn't a supported video or image file" in response.json()["detail"]

    fake = tmp_path / "broken.mp4"
    fake.write_bytes(b"this is not a video" * 100)
    job = import_file(client, fake)
    assert job["status"] == "error"
    assert "broken.mp4" in job["error"]
    assert client.get("/api/library").json() == []


# The AI flag ---------------------------------------------------------------------------------


def test_the_ai_flag_and_name_can_be_changed_later(client: TestClient, tmp_path: Path) -> None:
    item = import_file(client, make_video(tmp_path / "shot.mp4", seconds=0.5), ai=False)["result"]
    changed = client.patch(f"/api/library/{item['id']}", json={"aiGenerated": True, "name": "  Robot   arm "}).json()
    assert changed["aiGenerated"] is True
    assert changed["name"] == "Robot arm"
    assert client.get("/api/library").json()[0]["aiGenerated"] is True

    assert client.patch("/api/library/m-missing", json={"aiGenerated": True}).status_code == 404
    assert client.patch(f"/api/library/{item['id']}", json={"name": ""}).status_code == 422


def test_projects_with_ai_clips_are_flagged(client: TestClient, tmp_path: Path) -> None:
    ai = import_file(client, make_video(tmp_path / "ComfyUI_00003_.mp4", seconds=0.5), ai=True)["result"]
    stock = import_file(client, make_video(tmp_path / "beach.mp4", seconds=0.5), ai=False)["result"]
    save_project(client, "p-ai", "With AI", [stock["id"], ai["id"]])
    save_project(client, "p-stock", "Stock only", [stock["id"]])

    listed = {p["id"]: p["aiClips"] for p in client.get("/api/projects").json()}
    assert listed == {"p-ai": 1, "p-stock": 0}

    disclosure = client.get("/api/projects/p-ai/disclosure").json()
    assert disclosure["containsAi"] is True
    assert [(c["clipId"], c["mediaId"], c["name"]) for c in disclosure["aiClips"]] == [("c1", ai["id"], ai["name"])]
    assert client.get("/api/projects/p-stock/disclosure").json() == {"containsAi": False, "aiClips": []}

    # Changing the flag in the library changes every project that uses the clip.
    client.patch(f"/api/library/{ai['id']}", json={"aiGenerated": False})
    assert client.get("/api/projects/p-ai/disclosure").json()["containsAi"] is False
    client.patch(f"/api/library/{stock['id']}", json={"aiGenerated": True})
    assert {p["id"]: p["aiClips"] for p in client.get("/api/projects").json()} == {"p-ai": 1, "p-stock": 1}


def test_ai_clips_ignores_missing_items_and_bad_clips() -> None:
    project = {"clips": [{"id": "a", "mediaId": "m-1"}, {"id": "b", "mediaId": "m-gone"}, {"id": "c"}, "junk"]}
    items = [{"id": "m-1", "name": "Shot", "source": "ai", "aiGenerated": True}]
    assert [c["clipId"] for c in ai_clips(project, items)] == ["a"]
    assert ai_clips({"clips": None}, items) == []


# Deleting ------------------------------------------------------------------------------------


def test_deleting_a_clip_in_use_needs_confirmation(client: TestClient, settings: Settings, tmp_path: Path) -> None:
    item = import_file(client, make_video(tmp_path / "clip.mp4", seconds=0.5))["result"]
    save_project(client, "p-1", "Airplane windows", [item["id"]])

    refused = client.delete(f"/api/library/{item['id']}")
    assert refused.status_code == 409
    assert "“Airplane windows”" in refused.json()["detail"]
    assert len(client.get("/api/library").json()) == 1

    deleted = client.delete(f"/api/library/{item['id']}", params={"force": "true"}).json()
    assert deleted == {"deleted": item["id"], "usedIn": ["p-1"]}
    assert client.get("/api/library").json() == []
    assert not any((settings.library_dir / "clips").iterdir())
    assert not any((settings.library_dir / "thumbs").iterdir())
    assert client.get(f"/api/library/{item['id']}/file").status_code == 404


def test_unused_clips_delete_straight_away(client: TestClient, tmp_path: Path) -> None:
    item = import_file(client, make_video(tmp_path / "clip.mp4", seconds=0.5))["result"]
    assert client.delete(f"/api/library/{item['id']}").status_code == 200
    assert client.delete(f"/api/library/{item['id']}").status_code == 404


def test_the_library_is_shared_by_all_projects(client: TestClient, settings: Settings, tmp_path: Path) -> None:
    item = import_file(client, make_video(tmp_path / "clip.mp4", seconds=0.5))["result"]
    save_project(client, "p-1", "One", [item["id"]])
    save_project(client, "p-2", "Two", [item["id"], item["id"]])
    index = json.loads((settings.library_dir / "library.json").read_text())
    assert [i["id"] for i in index["items"]] == [item["id"]]
    assert not (settings.projects_dir / "p-1" / "media").exists()


def test_only_the_sound_is_converted_when_the_picture_is_fine(library: Library) -> None:
    import subprocess

    from app.library.probe import probe

    source = library.incoming_dir / "LTX_2.5_t2v_00002_.mov"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=480x864:rate=24:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", str(source)],
        check=True,
    )
    item = library.add_clip(source, "ai", ClipMetadata(name="Shot"))
    stored = library.file_path(item["id"])
    info = probe(stored)
    assert stored.suffix == ".mp4"
    assert (info.video_codec, info.audio_codec) == ("h264", "aac")
    assert item["hasAudio"] is True
