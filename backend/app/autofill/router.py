from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.autofill.service import autofill
from app.core.jobs import jobs
from app.library.router import LibraryDep
from app.pexels.router import PexelsDep

router = APIRouter(tags=["autofill"])


class AutofillRequest(BaseModel):
    # The script split into the stretches that each get one clip.
    sentences: Annotated[list[Annotated[str, Field(min_length=1, max_length=2000)]], Field(min_length=1, max_length=80)]


@router.post("/api/autofill")
def start_autofill(body: AutofillRequest, pexels: PexelsDep, library: LibraryDep) -> dict[str, Any]:
    """Finds and downloads one stock clip per sentence; poll /api/jobs/{id} for the clips."""
    pexels.require_key()  # the real reason, straight away
    return jobs.submit("autofill", lambda job: autofill(pexels, library, body.sentences, job), pool="media").to_dict()
