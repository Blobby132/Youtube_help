"""Pexels video search and downloads (https://www.pexels.com/api/documentation/).

The API key is read from PEXELS_API_KEY in .env and only ever sent to Pexels; the browser
gets search results without it. Every failure becomes an AppError carrying the real reason
(missing or rejected key, rate limit, network trouble), which the Media tab shows.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from app.core.errors import AppError

log = logging.getLogger("shorts.pexels")

API_URL = "https://api.pexels.com"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
DOWNLOAD_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
FRAME_WIDTH, FRAME_HEIGHT = 1080, 1920

MISSING_KEY = (
    "Stock search needs a free Pexels API key. Get one at https://www.pexels.com/api/, add "
    "PEXELS_API_KEY=your-key to the .env file in the app folder, then restart the app."
)


class PexelsClient:
    def __init__(self, api_key: str | None, transport: httpx.BaseTransport | None = None, base_url: str = API_URL) -> None:
        self.api_key = api_key
        self.transport = transport
        self.base_url = base_url

    def _client(self, timeout: httpx.Timeout = TIMEOUT) -> httpx.Client:
        return httpx.Client(transport=self.transport, timeout=timeout, follow_redirects=True)

    def require_key(self) -> None:
        if not self.api_key:
            raise AppError(MISSING_KEY, 400)

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.require_key()
        try:
            with self._client() as client:
                response = client.get(f"{self.base_url}{path}", params=params, headers={"Authorization": self.api_key})
        except httpx.TimeoutException as exc:
            raise AppError("Pexels didn't answer in time. Check your internet connection and try again.", 504) from exc
        except httpx.HTTPError as exc:
            raise AppError(f"Could not reach Pexels ({exc}). Check your internet connection.", 502) from exc
        check_response(response)
        try:
            data = response.json()
        except ValueError as exc:
            raise AppError("Pexels sent an answer that isn't JSON. Try again in a moment.", 502) from exc
        if not isinstance(data, dict):
            raise AppError("Pexels sent an unexpected answer. Try again in a moment.", 502)
        return data

    def search(self, query: str, page: int = 1, per_page: int = 24, orientation: str | None = "portrait") -> dict[str, Any]:
        params: dict[str, Any] = {"query": query, "page": page, "per_page": per_page}
        if orientation:
            params["orientation"] = orientation
        return self._get("/videos/search", params)

    def video(self, video_id: int) -> dict[str, Any]:
        return self._get(f"/videos/videos/{video_id}")

    def download(self, url: str, target: Path, on_progress: Callable[[float], None] | None = None) -> None:
        """Streams a video file to `target`, reporting progress (0..1) when the size is known."""
        try:
            with self._client(DOWNLOAD_TIMEOUT) as client, client.stream("GET", url) as response:
                if response.status_code >= 400:
                    raise AppError(f"Pexels refused the download (HTTP {response.status_code}). Try again later.", 502)
                total = int(response.headers.get("content-length") or 0)
                done = 0
                with target.open("wb") as out:
                    for chunk in response.iter_bytes(1 << 20):
                        out.write(chunk)
                        done += len(chunk)
                        if on_progress and total:
                            on_progress(min(1.0, done / total))
        except httpx.TimeoutException as exc:
            target.unlink(missing_ok=True)
            raise AppError("The download from Pexels stalled. Check your internet connection and try again.", 504) from exc
        except httpx.HTTPError as exc:
            target.unlink(missing_ok=True)
            raise AppError(f"The download from Pexels failed ({exc}). Try again.", 502) from exc
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        if done == 0:
            target.unlink(missing_ok=True)
            raise AppError("Pexels sent an empty file. Try again later.", 502)


def check_response(response: httpx.Response) -> None:
    status = response.status_code
    if status < 400:
        return
    detail = ""
    try:
        body = response.json()
        detail = str(body.get("error") or body.get("code") or "") if isinstance(body, dict) else ""
    except ValueError:
        detail = response.text[:200].strip()
    log.warning("Pexels answered HTTP %s: %s", status, detail or response.text[:500])
    if status in (401, 403):
        raise AppError(
            f"Pexels rejected the API key (HTTP {status}{': ' + detail if detail else ''}). "
            "Check PEXELS_API_KEY in .env, then restart the app.",
            502,
        )
    if status == 429:
        raise AppError(
            "The Pexels rate limit is used up (HTTP 429). Free keys allow 200 requests an hour and "
            "20,000 a month; try again later.",
            429,
        )
    if status == 404:
        raise AppError("Pexels couldn't find that video. It may have been removed.", 404)
    raise AppError(f"Pexels answered HTTP {status}{': ' + detail if detail else ''}. Try again in a moment.", 502)


def _area(file: dict[str, Any]) -> int:
    return int(file["width"]) * int(file["height"])


def usable_files(video: dict[str, Any]) -> list[dict[str, Any]]:
    files = [
        f
        for f in video.get("video_files") or []
        if isinstance(f, dict) and f.get("link") and (f.get("width") or 0) > 0 and (f.get("height") or 0) > 0
    ]
    mp4 = [f for f in files if (f.get("file_type") or "video/mp4") == "video/mp4"]
    return mp4 or files


def best_file(video: dict[str, Any]) -> dict[str, Any] | None:
    """The file to download for a 1080×1920 video.

    Prefers files at least 1080 pixels wide. Among those, the smallest one that covers the whole
    1080×1920 frame without being scaled up: the 1080×1920 file of a portrait video (its 4K
    version looks the same in a 1080p Short at four times the download), and the 4K file of a
    landscape video, since cropping it to 9:16 keeps only a third of its width. When no file
    covers the frame, the largest one.
    """
    files = usable_files(video)
    if not files:
        return None

    def tie_break(f: dict[str, Any]) -> tuple[float, int]:
        return (abs((f.get("fps") or 30) - 30), f.get("size") or 0)

    covering = [f for f in files if f["width"] >= FRAME_WIDTH and f["height"] >= FRAME_HEIGHT]
    if covering:
        return min(covering, key=lambda f: (_area(f), *tie_break(f)))
    wide = [f for f in files if f["width"] >= FRAME_WIDTH] or files
    return max(wide, key=lambda f: (_area(f), *(-x for x in tie_break(f))))


def preview_file(video: dict[str, Any]) -> dict[str, Any] | None:
    """A small file for the hover preview: the smallest at least 360 pixels on its short side."""
    files = usable_files(video)
    if not files:
        return None
    big_enough = [f for f in files if min(f["width"], f["height"]) >= 360] or files
    return min(big_enough, key=_area)


_SLUG = re.compile(r"/video/(?:(?P<slug>[^/]*[^/\d-][^/]*?)-)?(?P<id>\d+)/?$")


def title_from_url(url: str, video_id: int) -> str:
    """Pexels has no titles, but its page URLs describe the video:
    .../video/waves-crashing-on-the-shore-1093662/ -> "Waves crashing on the shore"."""
    match = _SLUG.search(url or "")
    words = (match.group("slug") or "").replace("-", " ").strip() if match else ""
    return words[:1].upper() + words[1:] if words else f"Pexels video {video_id}"


def summarize_video(video: dict[str, Any], in_library: dict[int, str]) -> dict[str, Any] | None:
    """What the Media tab needs to show one search result."""
    best, preview = best_file(video), preview_file(video)
    if best is None or not isinstance(video.get("id"), int):
        return None
    user = video.get("user") or {}
    return {
        "id": video["id"],
        "title": title_from_url(video.get("url", ""), video["id"]),
        "url": video.get("url"),
        "duration": video.get("duration"),
        "width": video.get("width"),
        "height": video.get("height"),
        "image": video.get("image"),
        "photographer": user.get("name") or "Unknown",
        "photographerUrl": user.get("url"),
        "previewUrl": preview["link"] if preview else None,
        "file": {"width": best["width"], "height": best["height"], "fps": best.get("fps"), "quality": best.get("quality")},
        "libraryId": in_library.get(video["id"]),
    }


def summarize_search(data: dict[str, Any], in_library: dict[int, str], portrait_first: bool) -> dict[str, Any]:
    videos = [v for v in (data.get("videos") or []) if isinstance(v, dict)]
    results = [r for r in (summarize_video(v, in_library) for v in videos) if r]
    if portrait_first:
        # Stable sort: keeps Pexels' relevance order within portrait and within the rest.
        results.sort(key=lambda r: not ((r["height"] or 0) > (r["width"] or 0)))
    return {
        "page": data.get("page", 1),
        "perPage": data.get("per_page"),
        "totalResults": data.get("total_results", len(results)),
        "hasMore": bool(data.get("next_page")),
        "results": results,
    }
