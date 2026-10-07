from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.autofill.service import autofill
from app.core.errors import AppError
from app.core.jobs import jobs
from app.library.router import LibraryDep
from app.pexels.router import PexelsDep
from app.pexels.service import PexelsSource
from app.pixabay.router import PixabayDep
from app.pixabay.service import PixabaySource
from app.stock.sources import NO_SOURCE, StockSource

router = APIRouter(tags=["autofill"])


class AutofillRequest(BaseModel):
    # The script split into the stretches that each get one clip.
    sentences: Annotated[list[Annotated[str, Field(min_length=1, max_length=2000)]], Field(min_length=1, max_length=80)]
    # The source picked in the Media tab; without one, whichever has a key (Pexels first).
    source: Literal["pexels", "pixabay"] | None = None


def pick_source(requested: str | None, sources: list[StockSource]) -> StockSource:
    if requested:
        source = next(s for s in sources if s.name == requested)
        source.require_key()  # the real reason, straight away
        return source
    available = [s for s in sources if s.has_key]
    if not available:
        raise AppError(NO_SOURCE, 400)
    return available[0]


@router.post("/api/autofill")
def start_autofill(body: AutofillRequest, pexels: PexelsDep, pixabay: PixabayDep, library: LibraryDep) -> dict[str, Any]:
    """Finds and downloads one stock clip per sentence; poll /api/jobs/{id} for the clips."""
    source = pick_source(body.source, [PexelsSource(pexels), PixabaySource(pixabay)])
    return jobs.submit("autofill", lambda job: autofill(source, library, body.sentences, job), pool="media").to_dict()
