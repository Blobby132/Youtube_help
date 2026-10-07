"""Auto-fill: search words per sentence (spaCy) and one Pexels clip per sentence (fake Pexels)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.autofill.keywords import keywords, queries, topic
from tests.media_files import make_video, needs_ffmpeg
from tests.test_pexels import FakePexels, client, fake, video_entry  # noqa: F401 (fixtures)
from tests.test_voiceover_api import wait_for_job


@pytest.mark.parametrize(
    ("sentence", "expected"),
    [
        ("Every airplane window has a tiny hole in it.", ["airplane window", "hole"]),
        ("Lions sleep up to twenty hours a day.", ["lion", "sleep"]),
        ("Here are the top 5 fastest cars in the world.", ["car"]),
        ("Number three: the Bugatti Chiron hits 304 miles per hour.", ["Bugatti Chiron", "hit"]),
        ("Wow.", []),
    ],
)
def test_keywords_are_the_things_to_show(sentence: str, expected: list[str]) -> None:
    assert keywords(sentence) == expected


def test_queries_go_from_specific_to_broad() -> None:
    assert queries(["airplane window", "hole"]) == ["airplane window hole", "airplane window", "hole"]
    assert queries(["lion"]) == ["lion"]
    assert queries([]) == []


def test_topic_is_the_scripts_most_repeated_noun() -> None:
    assert topic("Every airplane window has a hole. The hole keeps the window clear.")[:2] == ["window", "hole"]


def run_autofill(client: TestClient, sentences: list[str]) -> dict:
    return wait_for_job(client, client.post("/api/autofill", json={"sentences": sentences}).json(), timeout=60)


@needs_ffmpeg
def test_one_different_clip_per_sentence(client: TestClient, fake: FakePexels, tmp_path: Path) -> None:
    fake.video_bytes = make_video(tmp_path / "clip.mp4", 1080, 1920, seconds=1.0).read_bytes()
    fake.add(video_entry(1), "airplane window")
    fake.add(video_entry(2), "manufacturing mistake")
    fake.add(video_entry(3), "manufacturing mistake")

    job = run_autofill(client, [
        "Every airplane window has a tiny hole in it.",
        "And it is not a manufacturing mistake.",
        "Wow.",  # nothing to search for: continues the previous sentence's topic
    ])
    assert job["status"] == "done", job["error"]
    sentences = job["result"]["sentences"]
    assert [s["query"] for s in sentences] == ["airplane window", "manufacturing mistake", "manufacturing mistake"]
    assert [s["item"]["pexels"]["videoId"] for s in sentences] == [1, 2, 3]
    assert all(s["item"]["source"] == "pexels" and s["error"] is None for s in sentences)
    searched = [r.url.params["query"] for r in fake.requests if r.url.path == "/videos/search"]
    assert searched[0] == "airplane window hole"  # tried first, found nothing
    assert all(r.url.params["orientation"] == "portrait" for r in fake.requests if r.url.path == "/videos/search")
    assert len(client.get("/api/library").json()) == 3


@needs_ffmpeg
def test_clips_already_in_the_library_are_reused(client: TestClient, fake: FakePexels, tmp_path: Path) -> None:
    fake.video_bytes = make_video(tmp_path / "clip.mp4", 1080, 1920, seconds=1.0).read_bytes()
    fake.add(video_entry(1), "lion")
    first = run_autofill(client, ["Lions are lazy."])["result"]["sentences"][0]["item"]
    second = run_autofill(client, ["Lions are lazy."])["result"]["sentences"][0]["item"]
    assert first == second
    assert len([r for r in fake.requests if r.url.host == "videos.pexels.com"]) == 1


def test_sentences_without_a_match_are_reported(client: TestClient, fake: FakePexels) -> None:
    job = run_autofill(client, ["Quantum flux capacitors hum."])
    assert job["status"] == "done"
    [sentence] = job["result"]["sentences"]
    assert sentence["item"] is None
    assert sentence["error"] == "No matching Pexels video"


def test_a_rejected_key_stops_with_the_reason(client: TestClient, fake: FakePexels) -> None:
    fake.fail = httpx.Response(401, json={"error": "Unauthorized"})
    job = run_autofill(client, ["Lions sleep a lot.", "Cats too."])
    assert job["status"] == "error"
    assert "Pexels rejected the API key" in job["error"]


def test_autofill_needs_sentences(client: TestClient) -> None:
    assert client.post("/api/autofill", json={"sentences": []}).status_code == 422
