"""Pixabay video search and downloads (https://pixabay.com/api/docs/).

Following Pixabay's API rules:
- Every answer is cached for 24 hours (in data/cache/pixabay), so searching the same words
  again, or switching the orientation filter, doesn't ask Pixabay again.
- Videos are downloaded into the library, never linked to; search results say they come
  from Pixabay.
- The rate limit (by default 100 requests a minute) is read from the X-RateLimit-* headers.
  Once it's used up, no request is sent until it resets, and the error says when that is.

The key is read from PIXABAY_API_KEY in .env and never sent to the browser.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.core.errors import AppError
from app.core.files import atomic_write_text
from app.stock.files import DOWNLOAD_TIMEOUT, choose_file, download_file, orientation_of, preview_file

log = logging.getLogger("shorts.pixabay")

API_URL = "https://pixabay.com/api/videos/"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
CACHE_SECONDS = 24 * 3600
# The most Pixabay returns per request, and per search.
PER_PAGE = 200
MAX_HITS = 500
RENDITIONS = ("large", "medium", "small", "tiny")

MISSING_KEY = (
    "Pixabay search needs a free API key. Log in at pixabay.com, copy your key from "
    "https://pixabay.com/api/docs/, add PIXABAY_API_KEY=your-key to the .env file in the app "
    "folder, then restart the app."
)

Clock = Callable[[], float]


class RateLimit:
    """What Pixabay's X-RateLimit-* headers last said for one key."""

    def __init__(self, clock: Clock = time.time) -> None:
        self.clock = clock
        self.limit: int | None = None
        self.remaining: int | None = None
        self.reset_at = 0.0
        self._lock = threading.Lock()

    def check(self) -> None:
        """Raises the rate-limit error while the limit is used up."""
        with self._lock:
            wait = self.reset_at - self.clock()
            if self.remaining == 0 and wait > 0:
                raise rate_limited(wait, self.limit)

    def update(self, headers: httpx.Headers) -> None:
        def number(name: str) -> float | None:
            try:
                return float(headers[name])
            except (KeyError, ValueError):
                return None

        limit, remaining, reset = (number(f"X-RateLimit-{n}") for n in ("Limit", "Remaining", "Reset"))
        with self._lock:
            if limit is not None:
                self.limit = int(limit)
            if remaining is not None:
                self.remaining = int(remaining)
            if reset is not None:
                self.reset_at = self.clock() + reset

    def used_up(self, seconds: float) -> AppError:
        """Pixabay answered 429: nothing more until `seconds` from now."""
        with self._lock:
            self.remaining = 0
            self.reset_at = self.clock() + seconds
            return rate_limited(seconds, self.limit)


def rate_limited(seconds: float, limit: int | None) -> AppError:
    wait = max(1, math.ceil(seconds))
    at = datetime.fromtimestamp(time.time() + wait).strftime("%H:%M:%S")
    per_minute = f"{limit} requests a minute" if limit else "its requests per minute"
    return AppError(
        f"Pixabay's rate limit is used up ({per_minute}). You can search Pixabay again in "
        f"{wait} {'second' if wait == 1 else 'seconds'}, at {at}. Searches you've already made still work.",
        429,
        extra={"retryAfter": wait},
        headers={"Retry-After": str(wait)},
    )


_limits: dict[str, RateLimit] = {}
_limits_lock = threading.Lock()


def shared_rate_limit(api_key: str | None) -> RateLimit:
    """Pixabay counts requests per key, so every client with the same key shares one."""
    digest = hashlib.sha256((api_key or "").encode()).hexdigest()
    with _limits_lock:
        return _limits.setdefault(digest, RateLimit())


class ResponseCache:
    """Pixabay's answers, kept for 24 hours as JSON files (the key is never stored)."""

    def __init__(self, folder: Path, clock: Clock = time.time) -> None:
        self.folder = folder
        self.clock = clock

    def _path(self, params: dict[str, Any]) -> Path:
        text = json.dumps({k: params[k] for k in sorted(params) if k != "key"}, sort_keys=True)
        return self.folder / f"{hashlib.sha256(text.encode()).hexdigest()[:32]}.json"

    def get(self, params: dict[str, Any]) -> dict[str, Any] | None:
        path = self._path(params)
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            if self.clock() - float(entry["storedAt"]) < CACHE_SECONDS:
                return entry["data"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return None

    def put(self, params: dict[str, Any], data: dict[str, Any]) -> None:
        now = self.clock()
        safe = {k: v for k, v in params.items() if k != "key"}
        atomic_write_text(self._path(params), json.dumps({"storedAt": now, "params": safe, "data": data}))
        self.prune(now)

    def prune(self, now: float) -> None:
        for path in self.folder.glob("*.json"):
            try:
                if now - path.stat().st_mtime > CACHE_SECONDS + 3600:
                    path.unlink()
            except OSError:
                pass


class PixabayClient:
    def __init__(
        self,
        api_key: str | None,
        cache_dir: Path,
        transport: httpx.BaseTransport | None = None,
        base_url: str = API_URL,
        clock: Clock = time.time,
        rate_limit: RateLimit | None = None,
    ) -> None:
        self.api_key = api_key
        self.transport = transport
        self.base_url = base_url
        self.cache = ResponseCache(cache_dir, clock)
        self.rate_limit = rate_limit or shared_rate_limit(api_key)

    def _client(self, timeout: httpx.Timeout = TIMEOUT) -> httpx.Client:
        return httpx.Client(transport=self.transport, timeout=timeout, follow_redirects=True)

    def require_key(self) -> None:
        if not self.api_key:
            raise AppError(MISSING_KEY, 400)

    def _get(self, params: dict[str, Any]) -> dict[str, Any]:
        self.require_key()
        cached = self.cache.get(params)
        if cached is not None:
            return cached
        self.rate_limit.check()
        try:
            with self._client() as client:
                response = client.get(self.base_url, params={**params, "key": self.api_key})
        except httpx.TimeoutException as exc:
            raise AppError("Pixabay didn't answer in time. Check your internet connection and try again.", 504) from exc
        except httpx.HTTPError as exc:
            raise AppError(f"Could not reach Pixabay ({exc}). Check your internet connection.", 502) from exc
        self.rate_limit.update(response.headers)
        check_response(response, self.rate_limit)
        try:
            data = response.json()
        except ValueError as exc:
            raise AppError("Pixabay sent an answer that isn't JSON. Try again in a moment.", 502) from exc
        if not isinstance(data, dict):
            raise AppError("Pixabay sent an unexpected answer. Try again in a moment.", 502)
        self.cache.put(params, data)
        return data

    def search(self, query: str, page: int = 1, per_page: int = PER_PAGE) -> dict[str, Any]:
        return self._get({"q": query[:100], "page": page, "per_page": per_page, "safesearch": "true"})

    def video(self, video_id: int) -> dict[str, Any]:
        hits = self._get({"id": video_id}).get("hits") or []
        if not hits or not isinstance(hits[0], dict):
            raise AppError("Pixabay couldn't find that video. It may have been removed.", 404)
        return hits[0]

    def download(self, url: str, target: Path, on_progress: Callable[[float], None] | None = None) -> None:
        download_file(self._client(DOWNLOAD_TIMEOUT), url, target, "Pixabay", on_progress)


def check_response(response: httpx.Response, rate_limit: RateLimit) -> None:
    status = response.status_code
    if status < 400:
        return
    text = response.text.strip()[:300].rstrip(".")
    log.warning("Pixabay answered HTTP %s: %s", status, text)
    if status == 429:
        try:
            wait = float(response.headers.get("X-RateLimit-Reset") or response.headers.get("Retry-After") or 60)
        except ValueError:
            wait = 60.0
        raise rate_limit.used_up(wait)
    if status in (400, 401, 403) and "key" in text.lower():
        raise AppError(
            f"Pixabay rejected the API key ({text or f'HTTP {status}'}). Check PIXABAY_API_KEY in .env, "
            "then restart the app.",
            502,
        )
    raise AppError(f"Pixabay answered HTTP {status}{': ' + text if text else ''}. Try again in a moment.", 502)


def renditions(hit: dict[str, Any]) -> list[dict[str, Any]]:
    """The hit's video files (large, medium, small, tiny) that exist."""
    videos = hit.get("videos") if isinstance(hit.get("videos"), dict) else {}
    files = []
    for name in RENDITIONS:
        file = videos.get(name)
        if isinstance(file, dict) and file.get("url") and (file.get("width") or 0) > 0 and (file.get("height") or 0) > 0:
            files.append({**file, "quality": name})
    return files


def best_file(hit: dict[str, Any]) -> dict[str, Any] | None:
    """The file to download: the same rule as for Pexels (app.stock.files.choose_file)."""
    return choose_file(renditions(hit), lambda f: (f.get("size") or 0,))


def dimensions(hit: dict[str, Any]) -> tuple[int, int]:
    """The video's size: its largest rendition."""
    files = renditions(hit)
    if not files:
        return 0, 0
    largest = max(files, key=lambda f: f["width"] * f["height"])
    return int(largest["width"]), int(largest["height"])


def title_of(hit: dict[str, Any]) -> str:
    """Pixabay videos have tags, not titles: "flowers, yellow, blossom" -> "Flowers, yellow, blossom"."""
    tags = ", ".join(t.strip() for t in str(hit.get("tags") or "").split(",") if t.strip())
    return tags[:1].upper() + tags[1:] if tags else f"Pixabay video {hit.get('id')}"


def uploader_url(hit: dict[str, Any]) -> str | None:
    user, user_id = hit.get("user"), hit.get("user_id")
    return f"https://pixabay.com/users/{user}-{user_id}/" if user and user_id else None


def summarize_hit(hit: dict[str, Any], in_library: dict[int, str]) -> dict[str, Any] | None:
    """What the Media tab needs to show one search result (the same shape as for Pexels)."""
    best = best_file(hit)
    if best is None or not isinstance(hit.get("id"), int):
        return None
    width, height = dimensions(hit)
    files = renditions(hit)
    preview = preview_file(files)
    # The smallest still that's sharp enough for a result tile.
    stills = sorted((f for f in files if f.get("thumbnail")), key=lambda f: (min(f["width"], f["height"]) < 360, f["width"] * f["height"]))
    return {
        "source": "pixabay",
        "id": hit["id"],
        "title": title_of(hit),
        "url": hit.get("pageURL"),
        "duration": hit.get("duration"),
        "width": width,
        "height": height,
        "orientation": orientation_of(width, height),
        "image": stills[0]["thumbnail"] if stills else None,
        "author": hit.get("user") or "Unknown",
        "authorUrl": uploader_url(hit),
        "previewUrl": preview["url"] if preview else None,
        "file": {"width": best["width"], "height": best["height"], "fps": None, "quality": best["quality"]},
        "libraryId": in_library.get(hit["id"]),
    }
