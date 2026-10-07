"""For each sentence: pick search words, search the stock source (Pexels or Pixabay, portrait
videos first), and download the first result not already used for an earlier sentence. Videos
already in the library are reused."""

from __future__ import annotations

import logging
from typing import Any

from app.autofill.keywords import keywords, queries, topic
from app.core.errors import AppError
from app.core.jobs import Job
from app.library.store import Library
from app.stock.files import DownloadError
from app.stock.sources import StockSource

log = logging.getLogger("shorts.autofill")


def autofill(source: StockSource, library: Library, sentences: list[str], job: Job) -> dict[str, Any]:
    source.require_key()
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
            fresh = [video_id for video_id in source.candidates(query) if video_id not in used]
            if fresh:
                choice = (query, fresh[0])
                break

        entry: dict[str, Any] = {"text": sentence, "keywords": words, "query": None, "item": None, "error": None}
        if choice is None:
            entry["error"] = f"No matching {source.label} video" if tried else "No words to search for in this sentence"
        else:
            query, video_id = choice
            used.add(video_id)
            entry["query"] = query
            try:
                entry["item"] = source.add(library, video_id, report, f"{job.id}-{index}")
            except DownloadError as exc:  # this video only
                entry["error"] = exc.message
            except AppError as exc:
                if exc.status_code in (429, 502, 504):  # key, rate limit or network: stop here
                    raise
                entry["error"] = exc.message
        log.info(
            "Auto-fill sentence %d (%s): %r -> %s",
            index + 1, source.label, entry["query"], entry["item"] and entry["item"]["id"],
        )
        results.append(entry)
        if words:
            previous = words
    return {"source": source.name, "sentences": results}
