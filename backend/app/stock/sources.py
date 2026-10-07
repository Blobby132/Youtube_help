"""The interface Auto-fill uses, so it works the same with Pexels and Pixabay."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from app.library.store import Library

Report = Callable[[float, str], None]

NO_SOURCE = (
    "Auto-fill and stock search need a free API key: add PIXABAY_API_KEY (from "
    "https://pixabay.com/api/docs/) or PEXELS_API_KEY to the .env file in the app folder, then "
    "restart the app."
)


class StockSource(Protocol):
    name: str
    label: str

    @property
    def has_key(self) -> bool: ...

    def require_key(self) -> None: ...

    def candidates(self, query: str) -> list[int]:
        """Video ids matching the query, best first (portrait before wide)."""
        ...

    def add(self, library: Library, video_id: int, report: Report, tag: str) -> dict[str, Any]:
        """Downloads the video into the library (or returns it if it's already there)."""
        ...
