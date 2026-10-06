"""Background jobs for slow work (AI voiceover, later captions and rendering).

The frontend starts a job, then polls GET /api/jobs/{id} for progress. Heavy jobs run one
at a time so two models never compete for memory.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter

from app.core.errors import AppError

log = logging.getLogger("shorts.jobs")

_KEEP_SECONDS = 3600


@dataclass
class Job:
    kind: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = "Waiting…"
    result: Any = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(self, progress: float | None = None, message: str | None = None) -> None:
        with self._lock:
            if progress is not None:
                self.progress = max(0.0, min(1.0, progress))
            if message is not None:
                self.message = message

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "status": self.status,
                "progress": round(self.progress, 4),
                "message": self.message,
                "result": self.result,
                "error": self.error,
            }


class JobManager:
    def __init__(self, workers: int = 1) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, kind: str, work: Callable[[Job], Any]) -> Job:
        job = Job(kind)
        with self._lock:
            cutoff = time.time() - _KEEP_SECONDS
            self._jobs = {k: j for k, j in self._jobs.items() if j.created > cutoff or j.status in ("queued", "running")}
            self._jobs[job.id] = job
        self._executor.submit(self._run, job, work)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _run(self, job: Job, work: Callable[[Job], Any]) -> None:
        job.status = "running"
        try:
            result = work(job)
        except AppError as exc:
            log.warning("Job %s (%s) failed: %s", job.id, job.kind, exc.message)
            job.error, job.status = exc.message, "error"
        except Exception as exc:
            log.exception("Job %s (%s) crashed", job.id, job.kind)
            job.error, job.status = f"{type(exc).__name__}: {exc}", "error"
        else:
            job.result = result
            job.update(1.0, "Done")
            job.status = "done"


jobs = JobManager()

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise AppError("That job no longer exists. Was the backend restarted?", 404)
    return job.to_dict()
