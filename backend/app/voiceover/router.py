from __future__ import annotations

from fastapi import APIRouter

from app.voiceover.voices import voices_payload

router = APIRouter(prefix="/api/voices", tags=["voiceover"])


@router.get("")
def list_voices() -> list[dict[str, str]]:
    return voices_payload()
