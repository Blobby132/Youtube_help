"""Choosing and downloading stock video files, the same way for every source."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from app.core.errors import AppError

FRAME_WIDTH, FRAME_HEIGHT = 1080, 1920
DOWNLOAD_TIMEOUT = httpx.Timeout(60.0, connect=15.0)

TieBreak = Callable[[dict[str, Any]], tuple[float, ...]]


class DownloadError(AppError):
    """One file couldn't be downloaded (unlike a rejected key or rate limit, which stop everything)."""


def area(file: dict[str, Any]) -> int:
    return int(file["width"]) * int(file["height"])


def choose_file(files: list[dict[str, Any]], tie_break: TieBreak = lambda f: (0,)) -> dict[str, Any] | None:
    """The file to download for a 1080×1920 video: of the files at least 1080 pixels wide, the
    smallest that covers the whole frame without being scaled up. That is the 1080×1920 file of
    a portrait video (its 4K version looks the same in a 1080p Short at four times the download)
    and the 4K file of a landscape video, since cropping it to 9:16 keeps only a third of its
    width. When no file covers the frame, the largest one. Each file needs width and height."""
    if not files:
        return None
    covering = [f for f in files if f["width"] >= FRAME_WIDTH and f["height"] >= FRAME_HEIGHT]
    if covering:
        return min(covering, key=lambda f: (area(f), *tie_break(f)))
    wide = [f for f in files if f["width"] >= FRAME_WIDTH] or files
    return max(wide, key=lambda f: (area(f), *(-x for x in tie_break(f))))


def preview_file(files: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A small file for the hover preview: the smallest at least 360 pixels on its short side."""
    if not files:
        return None
    big_enough = [f for f in files if min(f["width"], f["height"]) >= 360] or files
    return min(big_enough, key=area)


def orientation_of(width: int | None, height: int | None) -> str:
    """"portrait", "landscape" or "square" (within 5%)."""
    if not width or not height:
        return "landscape"
    ratio = width / height
    if ratio < 0.95:
        return "portrait"
    if ratio > 1.05:
        return "landscape"
    return "square"


def matches_orientation(width: int | None, height: int | None, wanted: str | None) -> bool:
    return wanted in (None, "any") or orientation_of(width, height) == wanted


def download_file(
    client: httpx.Client,
    url: str,
    target: Path,
    provider: str,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """Streams a video file to `target`, reporting progress (0..1) when the size is known.
    Leaves nothing behind on failure."""
    done = 0
    try:
        with client, client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise DownloadError(f"{provider} refused the download (HTTP {response.status_code}). Try again later.", 502)
            total = int(response.headers.get("content-length") or 0)
            with target.open("wb") as out:
                for chunk in response.iter_bytes(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    if on_progress and total:
                        on_progress(min(1.0, done / total))
    except httpx.TimeoutException as exc:
        target.unlink(missing_ok=True)
        raise DownloadError(f"The download from {provider} stalled. Check your internet connection and try again.", 504) from exc
    except httpx.HTTPError as exc:
        target.unlink(missing_ok=True)
        raise DownloadError(f"The download from {provider} failed ({exc}). Try again.", 502) from exc
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if done == 0:
        target.unlink(missing_ok=True)
        raise DownloadError(f"{provider} sent an empty file. Try again later.", 502)
