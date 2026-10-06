from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.core.errors import AppError
from app.fonts.catalog import FONTS, font_path, fonts_payload

router = APIRouter(prefix="/api/fonts", tags=["fonts"])

_IDS = {font.id: font for font in FONTS}


@router.get("")
def list_fonts() -> list[dict[str, object]]:
    return fonts_payload()


@router.get("/{font_id}")
def get_font_file(font_id: str) -> FileResponse:
    font = _IDS.get(font_id)
    if font is None:
        raise AppError(f"Unknown font: {font_id}", 404)
    return FileResponse(
        font_path(font),
        media_type="font/ttf",
        headers={"Cache-Control": "public, max-age=86400"},
    )
