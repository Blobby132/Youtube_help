"""For each sentence: pick search words, search Pexels (portrait), and download the first
result not already used for an earlier sentence. Videos already in the library are reused."""

from __future__ import annotations

import logging
from typing import Any

from app.autofill.keywords import keywords, queries, topic
from app.core.errors import AppError
from app.core.jobs import Job
from app.library.store import Library
from app.pexels.client import PexelsClient, best_file
from app.pexels.service import add_video

log = logging.getLogger("shorts.autofill")

RESULTS_PER_SEARCH = 15


def autofill(pexels: PexelsClient, library: Library, sentences: list[str], job: Job) -> dict[str, Any]:
    pexels.require_key()
    count = len(sentences)
    fallback = topic(" ".join(sentences))
    used: set[int] = set()
    previous: list[str] = []
    results: list[dict[str, Any]] = []

    for index, sentence in enumerate(sentences):
        base = index / count

        def report(progress: float, message: str, base: float = base, index: int = index) -> None:
            job.update(base + progress / count, f"Sentence {index + 1} of {count}: {message}")

        words = keywords(sentence)
        tried = list(dict.fromkeys([*queries(words or previous), *queries(previous), *fallback]))
        report(0.0, f"searching for “{tried[0]}”…" if tried else "nothing to search for")
        choice: tuple[str, int] | None = None
        for query in tried:
            for video in pexels.search(query, per_page=RESULTS_PER_SEARCH).get("videos") or []:
                if isinstance(video, dict) and video.get("id") not in used and best_file(video):
                    choice = (query, video["id"])
                    break
            if choice:
                break

        entry: dict[str, Any] = {"text": sentence, "keywords": words, "query": None, "item": None, "error": None}
        if choice is None:
            entry["error"] = "No matching Pexels video" if tried else "No words to search for in this sentence"
        else:
            query, video_id = choice
            used.add(video_id)
            entry["query"] = query
            try:
                entry["item"] = add_video(pexels, library, video_id, report, tag=f"{job.id}-{index}")
            except AppError as exc:
                if exc.status_code in (429, 502, 504):  # key, rate limit or network: stop here
                    raise
                entry["error"] = exc.message
        log.info("Auto-fill sentence %d: %r -> %s", index + 1, entry["query"], entry["item"] and entry["item"]["id"])
        results.append(entry)
        if words:
            previous = words
    return {"sentences": results}
