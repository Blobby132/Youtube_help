"""Searching Pixabay page by page with an orientation filter, and bringing a video into the
media library."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.core.errors import AppError
from app.library.store import ClipMetadata, Library, PixabayCredit
from app.pixabay.client import MAX_HITS, PER_PAGE, PixabayClient, best_file, dimensions, summarize_hit, title_of, uploader_url
from app.stock.files import matches_orientation

# Results per page in the Media tab.
PAGE_SIZE = 24

Report = Callable[[float, str], None]


def search(
    client: PixabayClient,
    query: str,
    orientation: str,
    page: int,
    in_library: dict[int, str],
) -> dict[str, Any]:
    """One page of results. Pixabay can't filter videos by orientation, so each video's own
    width and height decide; Pixabay pages of 200 are read (and cached) until there are enough."""
    matched: list[dict[str, Any]] = []
    wanted = page * PAGE_SIZE + 1  # one extra to know whether there's a next page
    pixabay_page, total_hits, exhausted = 1, 0, False
    while len(matched) < wanted:
        data = client.search(query, page=pixabay_page)
        hits = [h for h in data.get("hits") or [] if isinstance(h, dict)]
        total_hits = min(int(data.get("totalHits") or 0), MAX_HITS)
        matched += [h for h in hits if matches_orientation(*dimensions(h), orientation)]
        if not hits or pixabay_page * PER_PAGE >= total_hits:
            exhausted = True
            break
        pixabay_page += 1
    start = (page - 1) * PAGE_SIZE
    results = [r for r in (summarize_hit(h, in_library) for h in matched[start : start + PAGE_SIZE]) if r]
    if orientation == "any":
        total, exact = total_hits, True
    else:
        total, exact = len(matched), exhausted
    return {
        "source": "pixabay",
        "page": page,
        "totalResults": total,
        "totalExact": exact,
        "hasMore": len(matched) > page * PAGE_SIZE,
        "results": results,
    }


def add_video(client: PixabayClient, library: Library, video_id: int, report: Report, tag: str = "") -> dict[str, Any]:
    """Downloads a Pixabay video into the library (or returns it if it's already there).
    Keeps the video id, page URL and uploader for the credit."""
    existing = library.find_pixabay(video_id)
    if existing:
        return existing
    report(0.0, "Asking Pixabay for the video…")
    hit = client.video(video_id)
    file = best_file(hit)
    if file is None:
        raise AppError(f"Pixabay lists no downloadable file for video {video_id}.", 404)
    credit = PixabayCredit(
        video_id=video_id,
        url=hit.get("pageURL") or f"https://pixabay.com/videos/id-{video_id}/",
        uploader=hit.get("user") or "Unknown",
        uploader_url=uploader_url(hit),
    )
    label = f"{file['width']}×{file['height']}"
    temp = library.incoming_dir / f"pixabay-{video_id}-{tag or 'download'}.mp4"
    try:
        client.download(file["url"], temp, lambda p: report(0.9 * p, f"Downloading {label}…"))
        report(0.92, "Adding to the library…")
        metadata = ClipMetadata(
            name=title_of(hit),
            pixabay=credit,
            original_name=file["url"].rsplit("/", 1)[-1].split("?", 1)[0],
        )
        return library.add_clip(temp, "pixabay", metadata)
    finally:
        temp.unlink(missing_ok=True)


def candidates(client: PixabayClient, query: str) -> list[int]:
    """Auto-fill: video ids for a query, portrait ones first (most Pixabay videos are wide)."""
    hits = [h for h in client.search(query).get("hits") or [] if isinstance(h, dict) and isinstance(h.get("id"), int)]
    usable = [h for h in hits if best_file(h)]
    portrait = [h["id"] for h in usable if matches_orientation(*dimensions(h), "portrait")]
    return portrait + [h["id"] for h in usable if h["id"] not in portrait]




class PixabaySource:
    """Pixabay for Auto-fill (app.stock.sources.StockSource)."""

    name = "pixabay"
    label = "Pixabay"

    def __init__(self, client: PixabayClient) -> None:
        self.client = client

    @property
    def has_key(self) -> bool:
        return bool(self.client.api_key)

    def require_key(self) -> None:
        self.client.require_key()

    def candidates(self, query: str) -> list[int]:
        return candidates(self.client, query)

    def add(self, library: Library, video_id: int, report: Report, tag: str) -> dict[str, Any]:
        return add_video(self.client, library, video_id, report, tag)
