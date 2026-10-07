"""Error handling: every failure reaches the UI as {"detail": "<real reason>"} and is
logged in full (with traceback) in the backend console."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("shorts")


class AppError(Exception):
    """An expected failure with a message that is safe and useful to show in the UI."""

    def __init__(
        self,
        message: str,
        status_code: int = 400,
        *,
        extra: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        # Machine-readable details sent next to "detail", e.g. {"retryAfter": 42}.
        self.extra = extra or {}
        self.headers = headers


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        log.warning("%s %s failed: %s", request.method, request.url.path, exc.message)
        return JSONResponse({**exc.extra, "detail": exc.message}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error in %s %s", request.method, request.url.path)
        return JSONResponse(
            {"detail": f"{type(exc).__name__}: {exc}"},
            status_code=500,
        )
