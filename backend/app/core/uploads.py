"""Saving uploaded files to disk with an extension allow-list and a size limit."""

from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import UploadFile

from app.core.errors import AppError

_CHUNK = 1 << 20


def extension_of(filename: str | None) -> str:
    return Path(filename or "").suffix.lower()


async def save_upload(
    upload: UploadFile,
    folder: Path,
    allowed: frozenset[str],
    max_bytes: int,
    kind: str,
) -> Path:
    """Streams the upload into `folder` as a temporary .upload-* file and returns its path."""
    extension = extension_of(upload.filename)
    if extension not in allowed:
        raise AppError(
            f"{upload.filename or 'That file'} isn't a supported {kind} file. Use {', '.join(sorted(allowed))}.",
            415,
        )
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f".upload-{secrets.token_hex(6)}{extension}"
    size = 0
    try:
        with target.open("wb") as out:
            while chunk := await upload.read(_CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise AppError(f"{upload.filename} is larger than {max_bytes // (1 << 20)} MB.", 413)
                out.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if size == 0:
        target.unlink(missing_ok=True)
        raise AppError(f"{upload.filename} is empty.", 400)
    return target
