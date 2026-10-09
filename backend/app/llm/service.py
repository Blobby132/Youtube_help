"""The language model's runs, and sharing the GPU with ComfyUI.

ComfyUI and the language model use the same GPU, and either can fill its memory, so they never run
at once: a run doesn't start while ComfyUI has anything in its queue (and says so), ComfyUI is asked
to unload its models before the run, and the language model server is asked to unload its model
after it (where it can be). While a run is waiting or going, Generate shot, previews and finals
wait too (comfy/service.py asks `busy`).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from typing import Any

from app.comfy.client import ComfyClient, ComfyUnreachable
from app.core.config import Settings
from app.core.errors import AppError
from app.core.jobs import Job, jobs
from app.llm import writer
from app.llm.client import LlmClient

log = logging.getLogger("shorts.llm")

SHARED_GPU = "The language model and ComfyUI share the GPU, and running both at once can run out of video memory or slow both to a crawl."
# How long ComfyUI gets to unload its models once asked (it does so as soon as it's idle).
FREE_WAIT_SECONDS = 1.5


def comfy_busy_message(running: int, pending: int) -> str:
    count = running + pending
    what = f"{count} {'job' if count == 1 else 'jobs'} in its queue"
    return f"ComfyUI is generating ({what}), so the language model waits until it's done. {SHARED_GPU}"


class LlmService:
    def __init__(
        self,
        settings: Settings,
        client: LlmClient | None = None,
        comfy: ComfyClient | None = None,
        free_wait: float | None = None,
    ) -> None:
        self.settings = settings
        self.client = client or LlmClient(settings.llm_url, settings.llm_model)
        self.comfy = comfy or ComfyClient(settings.comfyui_url)
        self.free_wait = FREE_WAIT_SECONDS if free_wait is None else free_wait
        self._lock = threading.Lock()
        # Runs waiting or going, and what the newest one is doing (for `busy`).
        self._runs = 0
        self._doing = ""

    # Status --------------------------------------------------------------------------------------

    @property
    def busy(self) -> str | None:
        """Why ComfyUI should wait now (a run is waiting or going), or None."""
        with self._lock:
            if not self._runs:
                return None
            return f"The language model is {self._doing}, so ComfyUI waits until it's done. {SHARED_GPU}"

    def comfy_queue(self) -> dict[str, Any]:
        """What ComfyUI is doing: {"reachable", "running", "pending", "busy"}."""
        try:
            running, pending = self.comfy.queue()
        except ComfyUnreachable:
            return {"reachable": False, "running": 0, "pending": 0, "busy": None}
        except AppError as exc:
            log.warning("Couldn't read ComfyUI's queue: %s", exc.message)
            return {"reachable": True, "running": 0, "pending": 0, "busy": None}
        busy = comfy_busy_message(len(running), len(pending)) if running or pending else None
        return {"reachable": True, "running": len(running), "pending": len(pending), "busy": busy}

    def status(self) -> dict[str, Any]:
        """The server and model (checked now), ComfyUI's queue, the guide, and any run going on."""
        try:
            writer.read_guide(self.settings.ltx_guide)
            guide_problem = None
        except AppError as exc:
            guide_problem = exc.message
        return {
            **self.client.status(),
            "comfy": self.comfy_queue(),
            "running": self.busy is not None,
            "guide": self.settings.ltx_guide.name,
            "guideProblem": guide_problem,
        }

    # Runs ----------------------------------------------------------------------------------------

    def write_scenes(self, script: str, scenes: list[dict[str, Any]]) -> Job:
        """Starts "Write scenes with AI" (poll /api/jobs/{id}). Raises straight away when it can't run."""
        if not scenes:
            raise AppError("There are no scenes to write. Create scenes from the script first.", 400)
        guide = self._ready()
        count = len(scenes)
        return self._submit(
            "llm-scenes",
            f"writing {count} {'scene' if count == 1 else 'scenes'}",
            lambda job: writer.write_scenes(self.client, guide(), script, scenes, job.update),
        )

    def rewrite_prompt(self, script: str, scene: dict[str, Any]) -> Job:
        """Starts "Rewrite prompt" for one scene (poll /api/jobs/{id})."""
        guide = self._ready()
        return self._submit(
            "llm-prompt",
            f"rewriting scene {scene['number']}'s prompt",
            lambda job: writer.rewrite_prompt(self.client, guide(), script, scene, job.update),
        )

    def _ready(self) -> Callable[[], str]:
        """Checks what can be checked before a run starts. Returns how to read the guide then, so
        an edit made while a run waits is used."""
        if not self.settings.llm_model:
            raise AppError("Set LLM_MODEL in .env to the language model to use (the name LM Studio or Ollama lists), then restart the app.", 400)
        writer.read_guide(self.settings.ltx_guide)
        self._check_comfy()
        return lambda: writer.read_guide(self.settings.ltx_guide)

    def _check_comfy(self) -> None:
        busy = self.comfy_queue()["busy"]
        if busy:
            raise AppError(busy, 409)

    def _submit(self, kind: str, doing: str, work: Callable[[Job], dict[str, Any]]) -> Job:
        with self._lock:
            self._runs += 1
            self._doing = doing
        try:
            return jobs.submit(kind, lambda job: self._run(job, work), pool="llm")
        except Exception:
            self._release()
            raise

    def _release(self) -> None:
        with self._lock:
            self._runs = max(0, self._runs - 1)

    def _run(self, job: Job, work: Callable[[Job], dict[str, Any]]) -> dict[str, Any]:
        """One run: ComfyUI must be idle; it's asked to free the GPU, the work runs, and the
        language model is unloaded afterwards, whatever happened."""
        notes: list[str] = []
        try:
            # ComfyUI may have started something while this run waited for the one before.
            self._check_comfy()
            job.update(0.01, "Asking ComfyUI to free the GPU…")
            notes.extend(self._free_comfy())
            try:
                result = work(job)
            finally:
                job.update(message="Unloading the language model…")
                unloaded = self.client.unload()
                if unloaded:
                    notes.append(unloaded)
                    log.info("%s", unloaded)
        finally:
            self._release()
        return {**result, "model": self.client.model, "notes": notes}

    def _free_comfy(self) -> list[str]:
        try:
            freed = self.comfy.free_memory()
        except ComfyUnreachable:
            return []  # ComfyUI isn't running, so it holds no GPU memory
        except AppError as exc:
            return [f"Couldn't ask ComfyUI to free the GPU: {exc.message}"]
        if not freed:
            return ["This ComfyUI can't be asked to unload its models (it's older than 2024), so they may still be in GPU memory."]
        time.sleep(self.free_wait)
        return ["Asked ComfyUI to unload its models first."]


@lru_cache
def get_llm_service(settings: Settings) -> LlmService:
    return LlmService(settings)
