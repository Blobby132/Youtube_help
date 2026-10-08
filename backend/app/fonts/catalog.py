"""The fonts offered for captions and titles."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

FONT_DIR = Path(__file__).parent / "files"


@dataclass(frozen=True)
class Font:
    id: str
    name: str
    file: str
    # Family name inside the file.
    family: str
    bold: bool = False


FONTS: tuple[Font, ...] = (
    Font("montserrat", "Montserrat Black", "Montserrat-Black.ttf", "Montserrat Black"),
    Font("anton", "Anton", "Anton-Regular.ttf", "Anton"),
    Font("bebas-neue", "Bebas Neue", "BebasNeue-Regular.ttf", "Bebas Neue"),
    Font("poppins", "Poppins ExtraBold", "Poppins-ExtraBold.ttf", "Poppins ExtraBold"),
    Font("archivo-black", "Archivo Black", "ArchivoBlack-Regular.ttf", "Archivo Black"),
    Font("bangers", "Bangers", "Bangers-Regular.ttf", "Bangers"),
    Font("oswald", "Oswald Bold", "Oswald-Bold.ttf", "Oswald", bold=True),
    Font("inter", "Inter ExtraBold", "Inter-ExtraBold.ttf", "Inter ExtraBold"),
)

DEFAULT_FONT_ID = FONTS[0].id
_BY_ID = {font.id: font for font in FONTS}


def get_font(font_id: str) -> Font:
    """The font with this id, or the default one for unknown ids."""
    return _BY_ID.get(font_id, _BY_ID[DEFAULT_FONT_ID])


def font_path(font: Font) -> Path:
    return FONT_DIR / font.file


def fonts_payload() -> list[dict[str, object]]:
    return [{k: v for k, v in asdict(font).items() if k in ("id", "name")} for font in FONTS]
