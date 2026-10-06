from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.config import Settings, get_settings
from app.pronunciations.store import PronunciationStore
from app.voiceover.normalize import Pronunciation

router = APIRouter(prefix="/api/pronunciations", tags=["pronunciations"])


def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> PronunciationStore:
    return PronunciationStore(settings.data_dir)


StoreDep = Annotated[PronunciationStore, Depends(get_store)]


class Entry(BaseModel):
    written: str
    spoken: str


class PronunciationList(BaseModel):
    entries: list[Entry]


def _payload(entries: list[Pronunciation]) -> dict[str, Any]:
    return {"entries": [{"written": e.written, "spoken": e.spoken} for e in entries]}


@router.get("")
def get_pronunciations(store: StoreDep) -> dict[str, Any]:
    return _payload(store.load())


@router.put("")
def save_pronunciations(body: PronunciationList, store: StoreDep) -> dict[str, Any]:
    return _payload(store.save([Pronunciation(e.written, e.spoken) for e in body.entries]))
