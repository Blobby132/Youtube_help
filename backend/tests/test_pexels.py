"""Pexels search and downloads, against a fake Pexels (httpx.MockTransport): no key, no network."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.pexels.client import PexelsClient, best_file, title_from_url
from app.pexels.router import get_pexels
from tests.media_files import make_video, needs_ffmpeg
from tests.test_voiceover_api import wait_for_job

Handler = Callable[[httpx.Request], httpx.Response]


def file_entry(video_id: int, width: int, height: int, quality: str = "hd", fps: float = 25) -> dict:
    return {
        "id": width * 10_000 + height,
        "quality": quality,
        "file_type": "video/mp4",
        "width": width,
        "height": height,
        "fps": fps,
        "link": f"https://videos.pexels.com/video-files/{video_id}/{video_id}-{width}x{height}.mp4",
    }


def video_entry(video_id: int, width: int = 1080, height: int = 1920, sizes: list[tuple[int, int]] | None = None) -> dict:
    sizes = sizes or [(360, 640), (720, 1280), (1080, 1920), (2160, 3840)]
    return {
        "id": video_id,
        "width": width,
        "height": height,
        "duration": 12,
        "url": f"https://www.pexels.com/video/waves-crashing-on-the-shore-{video_id}/",
        "image": f"https://images.pexels.com/videos/{video_id}/thumb.jpeg",
        "user": {"id": 7, "name": "Jane Doe", "url": "https://www.pexels.com/@jane"},
        "video_files": [file_entry(video_id, w, h) for w, h in sizes],
    }


class FakePexels:
    """Serves search results, video details and the video files themselves."""

    def __init__(self, video_bytes: bytes = b"") -> None:
        self.videos: dict[int, dict] = {}
        self.requests: list[httpx.Request] = []
        self.video_bytes = video_bytes
        self.searches: dict[str, list[int]] = {}
        self.fail: httpx.Response | Exception | None = None

    def add(self, video: dict, *queries: str) -> None:
        self.videos[video["id"]] = video
        for query in queries:
            self.searches.setdefault(query, []).append(video["id"])

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail is not None:
            return self.fail
        url = request.url
        if url.host == "videos.pexels.com":
            return httpx.Response(200, content=self.video_bytes, headers={"content-length": str(len(self.video_bytes))})
        assert request.headers["Authorization"] == "test-key"
        if url.path == "/videos/search":
            ids = self.searches.get(url.params["query"], [])
            return httpx.Response(200, json={
                "page": int(url.params.get("page", 1)), "per_page": 24, "total_results": len(ids),
                "videos": [self.videos[i] for i in ids], **({"next_page": "x"} if len(ids) > 1 else {}),
            })
        if url.path.startswith("/videos/videos/"):
            video_id = int(url.path.rsplit("/", 1)[1])
            if video_id not in self.videos:
                return httpx.Response(404, json={"error": "Not Found"})
            return httpx.Response(200, json=self.videos[video_id])
        return httpx.Response(404)


@pytest.fixture
def fake(tmp_path: Path) -> FakePexels:
    return FakePexels()


@pytest.fixture
def client(settings: Settings, fake: FakePexels) -> Iterator[TestClient]:
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_pexels] = lambda: PexelsClient("test-key", transport=httpx.MockTransport(fake))
    with TestClient(app) as test_client:
        yield test_client


# Choosing the file ---------------------------------------------------------------------------


def test_portrait_videos_download_the_1080p_file() -> None:
    chosen = best_file(video_entry(1))
    assert (chosen["width"], chosen["height"]) == (1080, 1920)


def test_landscape_videos_download_the_4k_file_for_cropping() -> None:
    video = video_entry(2, 3840, 2160, sizes=[(640, 360), (1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)])
    chosen = best_file(video)
    assert (chosen["width"], chosen["height"]) == (3840, 2160)


def test_without_a_file_covering_the_frame_the_largest_wins() -> None:
    video = video_entry(3, 1920, 1080, sizes=[(640, 360), (1920, 1080), (1280, 720)])
    assert (best_file(video)["width"], best_file(video)["height"]) == (1920, 1080)
    small = video_entry(4, sizes=[(360, 640), (540, 960)])
    assert (best_file(small)["width"], best_file(small)["height"]) == (540, 960)


def test_at_least_1080_wide_beats_a_taller_narrow_file() -> None:
    video = video_entry(5, sizes=[(720, 1280), (1080, 1350), (1440, 2560)])
    assert (best_file(video)["width"], best_file(video)["height"]) == (1440, 2560)


def test_files_without_a_link_or_size_are_skipped() -> None:
    video = video_entry(6, sizes=[(720, 1280)])
    video["video_files"].append({"width": 2160, "height": 3840, "link": None, "file_type": "video/mp4"})
    video["video_files"].append({"width": None, "height": None, "link": "https://x", "file_type": "video/mp4"})
    assert best_file(video)["width"] == 720
    assert best_file({"video_files": []}) is None


def test_titles_come_from_the_page_url() -> None:
    assert title_from_url("https://www.pexels.com/video/waves-crashing-on-the-shore-1093662/", 1093662) == "Waves crashing on the shore"
    assert title_from_url("https://www.pexels.com/video/1093662/", 1093662) == "Pexels video 1093662"
    assert title_from_url("", 5) == "Pexels video 5"


# Search ----------------------------------------------------------------------------------------


def test_search_prefers_portrait_and_shows_what_the_ui_needs(client: TestClient, fake: FakePexels) -> None:
    fake.add(video_entry(11), "ocean")
    body = client.get("/api/pexels/search", params={"query": "ocean"}).json()

    sent = fake.requests[-1].url.params
    assert sent["query"] == "ocean" and sent["orientation"] == "portrait"
    assert body["totalResults"] == 1 and body["hasMore"] is False
    [result] = body["results"]
    assert result["id"] == 11
    assert result["title"] == "Waves crashing on the shore"
    assert result["photographer"] == "Jane Doe"
    assert result["url"] == "https://www.pexels.com/video/waves-crashing-on-the-shore-11/"
    assert result["previewUrl"].endswith("11-360x640.mp4")  # small file for the hover preview
    assert (result["file"]["width"], result["file"]["height"]) == (1080, 1920)
    assert result["libraryId"] is None
    assert "test-key" not in str(body)  # the key never reaches the browser


def test_any_orientation_lists_portrait_results_first(client: TestClient, fake: FakePexels) -> None:
    fake.add(video_entry(21, 1920, 1080, sizes=[(1920, 1080)]), "city")
    fake.add(video_entry(22), "city")
    body = client.get("/api/pexels/search", params={"query": "city", "orientation": "any"}).json()
    assert "orientation" not in fake.requests[-1].url.params
    assert [r["id"] for r in body["results"]] == [22, 21]
    assert body["hasMore"] is True


def test_missing_key_explains_how_to_add_it(client: TestClient, settings: Settings) -> None:
    client.app.dependency_overrides[get_pexels] = lambda: PexelsClient(None)  # type: ignore[attr-defined]
    for response in (
        client.get("/api/pexels/search", params={"query": "ocean"}),
        client.post("/api/pexels/11/add"),
        client.post("/api/autofill", json={"sentences": ["The ocean is deep."]}),
    ):
        assert response.status_code == 400
        assert "PEXELS_API_KEY" in response.json()["detail"]
        assert ".env" in response.json()["detail"]


@pytest.mark.parametrize(
    ("failure", "status", "reason"),
    [
        (httpx.Response(401, json={"error": "Unauthorized"}), 502, "Pexels rejected the API key (HTTP 401: Unauthorized)"),
        (httpx.Response(429, text="Too many"), 429, "rate limit is used up"),
        (httpx.Response(500, text="oops"), 502, "Pexels answered HTTP 500"),
        (httpx.Response(200, text="<html>"), 502, "isn't JSON"),
        (httpx.ConnectError("Name or service not known"), 502, "Could not reach Pexels (Name or service not known)"),
        (httpx.ReadTimeout("slow"), 504, "didn't answer in time"),
    ],
)
def test_failures_show_the_real_reason(client: TestClient, fake: FakePexels, failure, status: int, reason: str) -> None:
    fake.fail = failure
    response = client.get("/api/pexels/search", params={"query": "ocean"})
    assert response.status_code == status
    assert reason in response.json()["detail"]


def test_search_needs_words(client: TestClient) -> None:
    assert client.get("/api/pexels/search", params={"query": ""}).status_code == 422


# Adding to the library ---------------------------------------------------------------------------


@needs_ffmpeg
def test_add_downloads_the_best_file_into_the_library(client: TestClient, fake: FakePexels, tmp_path: Path) -> None:
    fake.video_bytes = make_video(tmp_path / "pexels.mp4", 1080, 1920, seconds=1.0).read_bytes()
    fake.add(video_entry(31), "ocean")

    job = wait_for_job(client, client.post("/api/pexels/31/add").json())
    assert job["status"] == "done", job["error"]
    item = job["result"]
    assert item["source"] == "pexels"
    assert item["aiGenerated"] is False
    assert item["name"] == "Waves crashing on the shore"
    assert item["pexels"] == {
        "videoId": 31,
        "url": "https://www.pexels.com/video/waves-crashing-on-the-shore-31/",
        "photographer": "Jane Doe",
        "photographerUrl": "https://www.pexels.com/@jane",
    }
    downloads = [r.url for r in fake.requests if r.url.host == "videos.pexels.com"]
    assert [str(u).rsplit("/", 1)[1] for u in downloads] == ["31-1080x1920.mp4"]
    assert client.get("/api/library").json() == [item]

    # Search results now point at the library item, and adding again doesn't download again.
    assert client.get("/api/pexels/search", params={"query": "ocean"}).json()["results"][0]["libraryId"] == item["id"]
    again = wait_for_job(client, client.post("/api/pexels/31/add").json())
    assert again["result"] == item
    assert len([r for r in fake.requests if r.url.host == "videos.pexels.com"]) == 1


def test_add_reports_a_removed_video(client: TestClient) -> None:
    job = wait_for_job(client, client.post("/api/pexels/999/add").json())
    assert job["status"] == "error"
    assert "couldn't find that video" in job["error"]


@needs_ffmpeg
def test_a_broken_download_leaves_nothing_behind(client: TestClient, fake: FakePexels, settings: Settings) -> None:
    fake.video_bytes = b"<html>not a video</html>"
    fake.add(video_entry(41))
    job = wait_for_job(client, client.post("/api/pexels/41/add").json())
    assert job["status"] == "error"
    assert client.get("/api/library").json() == []
    assert not any((settings.library_dir / ".incoming").iterdir())
