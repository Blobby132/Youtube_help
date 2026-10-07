"""Bringing a Pexels video into the media library."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.core.errors import AppError
from app.library.store import ClipMetadata, Library, PexelsCredit
from app.pexels.client import PexelsClient, best_file, title_from_url

Report = Callable[[float, str], None]


def add_video(pexels: PexelsClient, library: Library, video_id: int, report: Report, tag: str = "") -> dict[str, Any]:
    """Downloads a Pexels video into the library (or returns it if it's already there).
    Keeps the video id, page URL and photographer for the credit."""
    existing = library.find_pexels(video_id)
    if existing:
        return existing
    report(0.0, "Asking Pexels for the video…")
    video = pexels.video(video_id)
    file = best_file(video)
    if file is None:
        raise AppError(f"Pexels lists no downloadable file for video {video_id}.", 404)
    user = video.get("user") or {}
    credit = PexelsCredit(
        video_id=video_id,
        url=video.get("url") or f"https://www.pexels.com/video/{video_id}/",
        photographer=user.get("name") or "Unknown",
        photographer_url=user.get("url"),
    )
    label = f"{file['width']}×{file['height']}"
    temp = library.incoming_dir / f"pexels-{video_id}-{tag or 'download'}.mp4"
    try:
        pexels.download(file["link"], temp, lambda p: report(0.9 * p, f"Downloading {label}…"))
        report(0.92, "Adding to the library…")
        metadata = ClipMetadata(
            name=title_from_url(credit.url, video_id),
            pexels=credit,
            original_name=file["link"].rsplit("/", 1)[-1].split("?", 1)[0],
        )
        return library.add_clip(temp, "pexels", metadata)
    finally:
        temp.unlink(missing_ok=True)
