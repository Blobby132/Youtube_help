"""Console logging for the backend."""

from __future__ import annotations

import logging


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # The frontend polls /api/health while it waits for the backend; keep that out of the log.
    logging.getLogger("uvicorn.access").addFilter(
        lambda record: "/api/health" not in record.getMessage()
    )
