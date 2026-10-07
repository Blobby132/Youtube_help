"""Pixabay search, file choice, the 24-hour cache, rate limits and downloads, against a fake
Pixabay (httpx.MockTransport): no key or network needed. Also which source Auto-fill uses."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.pexels.client import PexelsClient
from app.pexels.router import get_pexels
from app.pixabay.client import CACHE_SECONDS, PixabayClient, RateLimit, best_file, title_of
from app.pixabay.router import get_pixabay
from app.stock.files import orientation_of
from tests.media_files import make_video, needs_ffmpeg
from tests.test_pexels import FakePexels, video_entry
from tests.test_voiceover_api import wait_for_job

KEY = "pixabay-test-key"


class Clock:
    def __init__(self) -> None:
        self.now = time.time()

    def __call__(self) -> float:
        return self.now


def rendition(video_id: int, name: str, width: int, height: int) -> dict:
    return {
        "url": f"https://cdn.pixabay.com/video/2026/01/01/{video_id}_{name}.mp4",
        "width": width,
        "height": height,
        "size": width * height,
        "thumbnail": f"https://cdn.pixabay.com/video/2026/01/01/{video_id}_{name}.jpg",
    }


def hit(video_id: int, sizes: list[tuple[int, int]] | None = None, tags: str = "ocean, waves, beach") -> dict:
    """A Pixabay video. `sizes` are large, medium, small, tiny (portrait 4K by default)."""
    sizes = sizes or [(2160, 3840), (1080, 1920), (720, 1280), (540, 960)]
    names = ["large", "medium", "small", "tiny"]
    return {
        "id": video_id,
        "pageURL": f"https://pixabay.com/videos/ocean-waves-{video_id}/",
        "type": "film",
        "tags": tags,
        "duration": 14,
        "videos": {name: rendition(video_id, name, w, h) for name, (w, h) in zip(names, sizes, strict=False)},
        "user_id": 42,
        "user": "SeaFilms",
    }


PORTRAIT = [(2160, 3840), (1080, 1920), (720, 1280), (540, 960)]
LANDSCAPE_4K = [(3840, 2160), (1920, 1080), (1280, 720), (960, 540)]
LANDSCAPE_HD = [(1920, 1080), (1280, 720), (640, 360), (480, 270)]


class FakePixabay:
    """Serves search results (in pages, like Pixabay), single videos and the files."""

    def __init__(self) -> None:
        self.hits: dict[str, list[dict]] = {}
        self.requests: list[httpx.Request] = []
        self.video_bytes = b""
        self.headers = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "99", "X-RateLimit-Reset": "60"}
        self.fail: httpx.Response | Exception | None = None

    @property
    def api_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == "pixabay.com"]

    def add(self, query: str, *hits: dict) -> None:
        self.hits.setdefault(query, []).extend(hits)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "cdn.pixabay.com":
            return httpx.Response(200, content=self.video_bytes, headers={"content-length": str(len(self.video_bytes))})
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail is not None:
            return self.fail
        params = request.url.params
        assert params["key"] == KEY
        if "id" in params:
            found = [h for hits in self.hits.values() for h in hits if h["id"] == int(params["id"])]
            return httpx.Response(200, json={"total": len(found), "totalHits": len(found), "hits": found[:1]}, headers=self.headers)
        hits = self.hits.get(params["q"], [])
        page, per_page = int(params.get("page", 1)), int(params.get("per_page", 20))
        body = {"total": len(hits), "totalHits": min(len(hits), 500), "hits": hits[(page - 1) * per_page : page * per_page]}
        return httpx.Response(200, json=body, headers=self.headers)


@pytest.fixture
def fake() -> FakePixabay:
    return FakePixabay()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def make_client(fake: FakePixabay, clock: Clock, settings: Settings):
    limit = RateLimit(clock)

    def build(key: str | None = KEY) -> PixabayClient:
        return PixabayClient(
            key, settings.data_dir / "cache" / "pixabay", transport=httpx.MockTransport(fake), clock=clock, rate_limit=limit
        )

    return build


@pytest.fixture
def client(settings: Settings, make_client) -> Iterator[TestClient]:
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_pixabay] = lambda: make_client()
    app.dependency_overrides[get_pexels] = lambda: PexelsClient(None)
    with TestClient(app) as test_client:
        yield test_client


def search(client: TestClient, query: str = "ocean", **params) -> httpx.Response:
    return client.get("/api/pixabay/search", params={"query": query, **params})


# File choice and details ---------------------------------------------------------------------


def test_file_choice_matches_pexels() -> None:
    # Portrait: the 1080x1920 rendition, not the 4K one.
    assert (best_file(hit(1, PORTRAIT))["width"], best_file(hit(1, PORTRAIT))["height"]) == (1080, 1920)
    # Landscape 4K: the 4K rendition, so the 9:16 crop stays sharp.
    assert best_file(hit(2, LANDSCAPE_4K))["quality"] == "large"
    # Nothing covers 1080x1920: the largest at least 1080 wide.
    assert (best_file(hit(3, LANDSCAPE_HD))["width"], best_file(hit(3, LANDSCAPE_HD))["height"]) == (1920, 1080)


def test_missing_renditions_are_skipped() -> None:
    video = hit(4, PORTRAIT)
    video["videos"]["large"] = {"url": "", "width": 0, "height": 0, "size": 0, "thumbnail": ""}
    video["videos"]["medium"]["url"] = ""
    assert best_file(video)["quality"] == "small"
    assert best_file({"id": 5, "videos": {}}) is None


def test_orientation_and_titles() -> None:
    assert orientation_of(1080, 1920) == "portrait"
    assert orientation_of(1920, 1080) == "landscape"
    assert orientation_of(1080, 1080) == "square"
    assert title_of(hit(1, tags="flowers, yellow,  blossom")) == "Flowers, yellow, blossom"
    assert title_of({"id": 9, "tags": ""}) == "Pixabay video 9"


# Search ----------------------------------------------------------------------------------------


def test_search_shows_what_the_ui_needs(client: TestClient, fake: FakePixabay) -> None:
    fake.add("ocean", hit(11, PORTRAIT))
    body = search(client).json()

    sent = fake.api_requests[-1].url.params
    assert sent["q"] == "ocean" and sent["per_page"] == "200" and sent["safesearch"] == "true"
    [result] = body["results"]
    assert result == {
        "source": "pixabay",
        "id": 11,
        "title": "Ocean, waves, beach",
        "url": "https://pixabay.com/videos/ocean-waves-11/",
        "duration": 14,
        "width": 2160,
        "height": 3840,
        "orientation": "portrait",
        "image": "https://cdn.pixabay.com/video/2026/01/01/11_tiny.jpg",
        "author": "SeaFilms",
        "authorUrl": "https://pixabay.com/users/SeaFilms-42/",
        "previewUrl": "https://cdn.pixabay.com/video/2026/01/01/11_tiny.mp4",
        "file": {"width": 1080, "height": 1920, "fps": None, "quality": "medium"},
        "libraryId": None,
    }
    assert body["source"] == "pixabay" and body["totalResults"] == 1 and body["hasMore"] is False
    assert KEY not in json.dumps(body)  # the key never reaches the browser


def test_orientation_is_worked_out_from_each_video(client: TestClient, fake: FakePixabay) -> None:
    # 450 videos, every 10th one portrait. Pixabay can't filter, so its pages of 200 are read
    # until a page of 24 portrait results (plus one, to know there are more) is found.
    fake.add("city", *(hit(i, PORTRAIT if i % 10 == 0 else LANDSCAPE_HD) for i in range(1, 451)))

    portrait = search(client, "city", orientation="portrait").json()
    assert [r["orientation"] for r in portrait["results"]] == ["portrait"] * 24
    assert portrait["hasMore"] is True
    assert (portrait["totalResults"], portrait["totalExact"]) == (40, False)  # 2 of 3 pages read
    assert [r.url.params["page"] for r in fake.api_requests] == ["1", "2"]

    page2 = search(client, "city", orientation="portrait", page=2).json()
    assert len(page2["results"]) == 21 and page2["hasMore"] is False
    assert (page2["totalResults"], page2["totalExact"]) == (45, True)

    landscape = search(client, "city", orientation="landscape").json()
    assert {r["orientation"] for r in landscape["results"]} == {"landscape"}
    everything = search(client, "city", orientation="any").json()
    assert (everything["totalResults"], len(everything["results"])) == (450, 24)
    # Pages 1-3 were each asked for once; every other search came from the cache.
    assert sorted(r.url.params["page"] for r in fake.api_requests) == ["1", "2", "3"]


def test_results_are_cached_for_24_hours(client: TestClient, fake: FakePixabay, clock: Clock, settings: Settings, make_client) -> None:
    fake.add("ocean", hit(11))
    search(client)
    search(client)
    search(client, orientation="any")
    assert len(fake.api_requests) == 1

    # The cache is on disk: a restart doesn't ask again. It never stores the key.
    cached = list((settings.data_dir / "cache" / "pixabay").glob("*.json"))
    assert len(cached) == 1 and KEY not in cached[0].read_text()
    assert make_client().search("ocean")["hits"][0]["id"] == 11
    assert len(fake.api_requests) == 1

    clock.now += CACHE_SECONDS - 60
    search(client)
    assert len(fake.api_requests) == 1
    clock.now += 120  # now more than 24 hours old
    search(client)
    assert len(fake.api_requests) == 2


# Rate limit ------------------------------------------------------------------------------------


def test_a_used_up_rate_limit_says_when_to_search_again(client: TestClient, fake: FakePixabay, clock: Clock) -> None:
    fake.add("ocean", hit(11))
    fake.headers = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "30"}
    assert search(client).status_code == 200

    # The headers said 0 left: the next search isn't even sent to Pixabay.
    refused = search(client, "beach")
    assert refused.status_code == 429
    body = refused.json()
    assert body["retryAfter"] == 30
    assert refused.headers["Retry-After"] == "30"
    assert "rate limit is used up (100 requests a minute)" in body["detail"]
    assert "again in 30 seconds, at " in body["detail"]
    assert len(fake.api_requests) == 1

    # What's already cached still works.
    assert search(client).status_code == 200

    clock.now += 31
    fake.headers = {"X-RateLimit-Remaining": "99", "X-RateLimit-Reset": "60"}
    assert search(client, "beach").status_code == 200
    assert len(fake.api_requests) == 2


def test_a_429_from_pixabay_uses_its_reset_time(client: TestClient, fake: FakePixabay) -> None:
    fake.fail = httpx.Response(429, text="Too Many Requests", headers={"X-RateLimit-Limit": "100", "X-RateLimit-Reset": "42"})
    response = search(client)
    assert response.status_code == 429
    assert response.json()["retryAfter"] == 42
    assert "again in 42 seconds" in response.json()["detail"]
    fake.fail = None
    assert search(client).status_code == 429  # still waiting
    assert len(fake.api_requests) == 1


# Errors ----------------------------------------------------------------------------------------


def test_missing_key_explains_how_to_add_it(client: TestClient, make_client) -> None:
    client.app.dependency_overrides[get_pixabay] = lambda: make_client(None)  # type: ignore[attr-defined]
    for response in (search(client), client.post("/api/pixabay/11/add")):
        assert response.status_code == 400
        assert "PIXABAY_API_KEY" in response.json()["detail"]
        assert "https://pixabay.com/api/docs/" in response.json()["detail"]


@pytest.mark.parametrize(
    ("failure", "status", "reason"),
    [
        (
            httpx.Response(400, text="[ERROR 400] Invalid or missing API key (https://pixabay.com/api/docs/)."),
            502,
            "Pixabay rejected the API key ([ERROR 400] Invalid or missing API key",
        ),
        (httpx.Response(500, text="Internal error"), 502, "Pixabay answered HTTP 500: Internal error"),
        (httpx.Response(200, text="<html>"), 502, "isn't JSON"),
        (httpx.ConnectError("Name or service not known"), 502, "Could not reach Pixabay (Name or service not known)"),
        (httpx.ReadTimeout("slow"), 504, "Pixabay didn't answer in time"),
    ],
)
def test_failures_show_the_real_reason(client: TestClient, fake: FakePixabay, failure, status: int, reason: str) -> None:
    fake.fail = failure
    response = search(client)
    assert response.status_code == status
    assert reason in response.json()["detail"]


# Adding to the library -------------------------------------------------------------------------


@needs_ffmpeg
def test_add_downloads_the_chosen_file_into_the_library(client: TestClient, fake: FakePixabay, tmp_path: Path) -> None:
    fake.video_bytes = make_video(tmp_path / "pixabay.mp4", 1080, 1920, seconds=1.0).read_bytes()
    fake.add("ocean", hit(31, PORTRAIT))

    job = wait_for_job(client, client.post("/api/pixabay/31/add").json())
    assert job["status"] == "done", job["error"]
    item = job["result"]
    assert item["source"] == "pixabay"
    assert item["aiGenerated"] is False
    assert item["name"] == "Ocean, waves, beach"
    assert item["pixabay"] == {
        "videoId": 31,
        "url": "https://pixabay.com/videos/ocean-waves-31/",
        "uploader": "SeaFilms",
        "uploaderUrl": "https://pixabay.com/users/SeaFilms-42/",
    }
    assert item["pexels"] is None
    downloads = [str(r.url) for r in fake.requests if r.url.host == "cdn.pixabay.com"]
    assert downloads == ["https://cdn.pixabay.com/video/2026/01/01/31_medium.mp4"]
    assert client.get("/api/library").json() == [item]

    assert search(client).json()["results"][0]["libraryId"] == item["id"]
    again = wait_for_job(client, client.post("/api/pixabay/31/add").json())
    assert again["result"] == item
    assert len([r for r in fake.requests if r.url.host == "cdn.pixabay.com"]) == 1


def test_add_reports_a_removed_video(client: TestClient) -> None:
    job = wait_for_job(client, client.post("/api/pixabay/999/add").json())
    assert job["status"] == "error"
    assert "Pixabay couldn't find that video" in job["error"]


@needs_ffmpeg
def test_a_broken_download_leaves_nothing_behind(client: TestClient, fake: FakePixabay, settings: Settings) -> None:
    fake.video_bytes = b"<html>not a video</html>"
    fake.add("ocean", hit(41))
    job = wait_for_job(client, client.post("/api/pixabay/41/add").json())
    assert job["status"] == "error"
    assert client.get("/api/library").json() == []
    assert not any((settings.library_dir / ".incoming").iterdir())


# Which source: health and Auto-fill ------------------------------------------------------------


def test_health_reports_each_source(client: TestClient, settings: Settings) -> None:
    assert client.get("/api/health").json()["pixabay"] is False  # the test settings have no keys
    client.app.dependency_overrides[get_settings] = lambda: Settings(  # type: ignore[attr-defined]
        projects_dir=settings.projects_dir,
        models_dir=settings.models_dir,
        pexels_api_key=None,
        pixabay_api_key="set",
        data_dir=settings.data_dir,
        library_dir=settings.library_dir,
    )
    body = client.get("/api/health").json()
    assert (body["pexels"], body["pixabay"]) == (False, True)


def run_autofill(client: TestClient, sentences: list[str], **extra) -> dict:
    response = client.post("/api/autofill", json={"sentences": sentences, **extra})
    assert response.status_code == 200, response.text
    return wait_for_job(client, response.json(), timeout=60)


@needs_ffmpeg
def test_autofill_uses_pixabay_when_it_is_the_only_source(client: TestClient, fake: FakePixabay, tmp_path: Path) -> None:
    fake.video_bytes = make_video(tmp_path / "clip.mp4", 1080, 1920, seconds=1.0).read_bytes()
    # Wide videos come first in Pixabay's results; Auto-fill takes the portrait one.
    fake.add("lion", hit(1, LANDSCAPE_HD), hit(2, PORTRAIT))
    job = run_autofill(client, ["Lions sleep all day."])
    assert job["status"] == "done", job["error"]
    assert job["result"]["source"] == "pixabay"
    [sentence] = job["result"]["sentences"]
    assert sentence["item"]["pixabay"]["videoId"] == 2


def test_autofill_takes_a_wide_video_when_there_is_no_portrait_one(client: TestClient, fake: FakePixabay, make_client) -> None:
    from app.pixabay.service import candidates

    fake.add("city", hit(1, LANDSCAPE_HD), hit(2, LANDSCAPE_4K))
    assert candidates(make_client(), "city") == [1, 2]


def test_autofill_uses_the_source_picked_in_the_media_tab(
    client: TestClient, fake: FakePixabay, settings: Settings, tmp_path: Path
) -> None:
    pexels = FakePexels()
    pexels.add(video_entry(7), "lion")
    client.app.dependency_overrides[get_pexels] = lambda: PexelsClient("test-key", transport=httpx.MockTransport(pexels))  # type: ignore[attr-defined]
    fake.add("lion", hit(2, PORTRAIT))

    # No video bytes, so the downloads fail: that sentence gets no clip, but the run finishes.
    picked = run_autofill(client, ["Lions sleep all day."], source="pexels")
    assert picked["status"] == "done"
    assert picked["result"]["source"] == "pexels"
    assert picked["result"]["sentences"][0]["error"] == "Pexels sent an empty file. Try again later."
    assert fake.api_requests == []
    assert run_autofill(client, ["Lions sleep all day."], source="pixabay")["result"]["source"] == "pixabay"
    # Without a choice, Pexels comes first when both have keys.
    assert run_autofill(client, ["Lions sleep all day."])["result"]["source"] == "pexels"


def test_autofill_explains_missing_keys(client: TestClient, make_client) -> None:
    client.app.dependency_overrides[get_pixabay] = lambda: make_client(None)  # type: ignore[attr-defined]
    neither = client.post("/api/autofill", json={"sentences": ["Lions sleep."]})
    assert neither.status_code == 400
    assert "PIXABAY_API_KEY" in neither.json()["detail"] and "PEXELS_API_KEY" in neither.json()["detail"]
    picked = client.post("/api/autofill", json={"sentences": ["Lions sleep."], "source": "pixabay"})
    assert picked.status_code == 400
    assert "PIXABAY_API_KEY" in picked.json()["detail"]


def test_the_key_never_reaches_the_log(client: TestClient, fake: FakePixabay, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    fake.add("ocean", hit(11))
    with caplog.at_level(logging.INFO):
        search(client)
        fake.fail = httpx.Response(400, text="[ERROR 400] Invalid or missing API key")
        search(client, "beach")
    assert KEY not in caplog.text
