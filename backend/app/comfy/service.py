"""Generate shot: AI clips made by ComfyUI in the background, saved into the media library.

Every variation becomes one job, submitted to ComfyUI's own queue straight away. A tracker
thread follows them: queue position from /queue, live progress from ComfyUI's websocket, and
the result from /history. A finished video is downloaded and added through Library.add_clip
(source "ai", AI-generated). Jobs are kept in data/generations.json, so they survive a page
reload and a backend restart (tracking resumes where it left off).

Scene previews and finals (the Scenes tab) are jobs with a `scene` (project and scene id): the
same queue, progress and library, plus those ids and type "preview" or "final" in the clip's
metadata. A preview runs only the workflow's first pass (at the Final size) and keeps its
latents with the clip; its final loads them and runs only the upscale and refine passes, so the
final is that preview, sharper, not a new video (see workflow.py).
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from app.comfy import workflow as wf
from app.comfy.client import ComfyClient, ComfyUnreachable, failure_reason, node_files, node_text, output_files
from app.core.config import Settings
from app.core.errors import AppError
from app.core.files import atomic_write_text
from app.library.probe import probe
from app.library.store import ClipMetadata, Library
from app.projects.store import utc_now

log = logging.getLogger("shorts.comfy")

Quality = Literal["draft", "final"]
QUALITY_MEGAPIXELS: dict[str, float] = {"draft": 0.4, "final": 0.8}
# Scene previews are the first pass of a Final-quality shot (half its width and height), so
# their finals come out at the Final size.
SCENE_MEGAPIXELS = QUALITY_MEGAPIXELS["final"]
LATENT_KINDS = ("video", "audio")
OLD_PREVIEW = (
    "This preview was made before finals could match their previews (it has no saved first pass), "
    "so a final made from it would be a different video. Generate a new preview for this scene and use that one."
)
MIN_SECONDS, MAX_SECONDS = 2, 5
MAX_VARIATIONS = 4
# Seeds stay below 2**53 so the browser can show and send them back exactly.
MAX_SEED = 2**50
ACTIVE = ("queued", "running", "saving")
FINISHED = ("done", "error", "cancelled")
# A job that's in neither ComfyUI's queue nor its history this long was lost (ComfyUI restarted).
LOST_AFTER_SECONDS = 20
KEEP_FINISHED = 60

# How long each kind of node takes, roughly, to turn node-by-node progress into one bar.
STAGES: dict[str, tuple[float, str]] = {
    "SamplerCustomAdvanced": (30, "Generating"),
    "KSampler": (30, "Generating"),
    "VAEDecodeTiled": (8, "Decoding the video"),
    "VAEDecode": (8, "Decoding the video"),
    "LTXVAudioVAEDecode": (3, "Decoding the audio"),
    "LTXVLatentUpsampler": (3, "Upscaling"),
    "CLIPTextEncode": (4, "Reading the prompt"),
    "UNETLoader": (4, "Loading the video model"),
    "CLIPLoader": (3, "Loading the text model"),
    "CreateVideo": (1, "Assembling the video"),
    "SaveVideo": (2, "Saving the video"),
    "SaveLatent": (1, "Saving the preview's latents"),
    "LoadLatent": (1, "Loading the preview"),
}
OTHER_WEIGHT = 0.2


def scene_ref(scene: dict[str, Any] | None) -> dict[str, str] | None:
    """The project and scene a preview belongs to, checked: {"projectId", "sceneId"} or None."""
    if scene is None:
        return None
    ref = {key: str(scene.get(key) or "").strip() for key in ("projectId", "sceneId")}
    if not all(ref.values()):
        raise AppError("A scene preview needs its project and scene.", 400)
    return ref


def shot_name(prompt: str, variation: int, variations: int) -> str:
    """"A red fox runs through deep snow at dusk…" (2/3): the prompt's start, at a word boundary."""
    text = " ".join(prompt.split())
    if len(text) > 50:
        text = text[:50].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
    return f"{text} ({variation}/{variations})" if variations > 1 else text


class Progress:
    """Turns ComfyUI's node-by-node events for one job into a fraction and a message."""

    def __init__(self, classes: dict[str, str]) -> None:
        self.classes = classes
        self.total = sum(self.weight(n) for n in classes) or 1.0
        self.samplers = [n for n, c in classes.items() if c in ("SamplerCustomAdvanced", "KSampler")]
        self.done: set[str] = set()
        self.current: str | None = None
        self.step: tuple[int, int] | None = None

    def weight(self, node: str) -> float:
        return STAGES.get(self.classes.get(node, ""), (OTHER_WEIGHT, ""))[0]

    def executing(self, node: str | None) -> None:
        if node == self.current:
            return  # the same node announced again
        if self.current:
            self.done.add(self.current)
        self.current, self.step = node, None

    def cached(self, nodes: list[str]) -> None:
        self.done.update(n for n in nodes if n in self.classes)

    def fraction(self) -> float:
        done = sum(self.weight(n) for n in self.done)
        if self.current and self.step and self.step[1]:
            done += self.weight(self.current) * self.step[0] / self.step[1]
        return min(0.95, done / self.total)

    def message(self) -> str:
        cls = self.classes.get(self.current or "", "")
        label = STAGES.get(cls, (0, "Working"))[1]
        if cls in ("SamplerCustomAdvanced", "KSampler") and self.current in self.samplers:
            passes = len(self.samplers)
            number = sum(1 for n in self.samplers if n in self.done) + 1
            label = f"{label}, pass {min(number, passes)} of {passes}" if passes > 1 else label
        if self.step:
            label += f" (step {self.step[0]} of {self.step[1]})"
        return label + "…"


class GenerationService:
    def __init__(
        self,
        settings: Settings,
        client: ComfyClient | None = None,
        poll_seconds: float = 2.0,
    ) -> None:
        self.settings = settings
        self.client = client or ComfyClient(settings.comfyui_url)
        self.workflow_path = settings.comfy_workflow
        self.library = Library(settings.library_dir)
        self.path = settings.data_dir / "generations.json"
        self.poll_seconds = poll_seconds
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []
        self._progress: dict[str, Progress] = {}
        self._lost_since: dict[str, float] = {}
        self.client_id, self.jobs = self._load()

    # Storage -------------------------------------------------------------------------------------

    def _load(self) -> tuple[str, dict[str, dict[str, Any]]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            jobs = {job["id"]: job for job in data.get("jobs", []) if isinstance(job, dict) and job.get("id")}
            return str(data.get("clientId") or uuid.uuid4().hex), jobs
        except FileNotFoundError:
            return uuid.uuid4().hex, {}
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            log.warning("Ignoring unreadable %s: %s", self.path, exc)
            return uuid.uuid4().hex, {}

    def _save(self) -> None:
        with self._lock:
            finished = sorted((j for j in self.jobs.values() if j["status"] in FINISHED), key=lambda j: j["createdAt"])
            for job in finished[:-KEEP_FINISHED]:
                del self.jobs[job["id"]]
            data = {"clientId": self.client_id, "jobs": sorted(self.jobs.values(), key=lambda j: j["createdAt"])}
            atomic_write_text(self.path, json.dumps(data, indent=2, ensure_ascii=False))

    def _set(self, job: dict[str, Any], persist: bool = True, **changes: Any) -> None:
        with self._lock:
            job.update(changes)
            if persist:
                self._save()

    # Status --------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Whether ComfyUI answers and the workflow file can be used."""
        finals = None
        try:
            finals = wf.finals_problem(wf.load(self.workflow_path))
            problem = None
        except AppError as exc:
            problem = exc.message
        return {**self.client.status(), "workflow": self.workflow_path.name, "workflowProblem": problem, "finalsProblem": finals}

    # Jobs ----------------------------------------------------------------------------------------

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(j) for j in sorted(self.jobs.values(), key=lambda j: (j["createdAt"], j["variation"]), reverse=True)]

    def generate(
        self,
        prompt: str,
        duration: int,
        quality: Quality,
        variations: int = 1,
        seed: int | None = None,
        based_on: str | None = None,
        scene: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Queues `variations` shots in ComfyUI, each with its own random seed (or `seed`).
        With `scene` ({"projectId", "sceneId"}) they're previews for that scene: only the first
        pass of a Final-quality shot, with its latents kept for the final."""
        prompt = prompt.strip()
        scene = scene_ref(scene)
        if not prompt:
            raise AppError("Describe the shot first: the prompt is empty.", 400)
        if not MIN_SECONDS <= duration <= MAX_SECONDS:
            raise AppError(f"Shots are {MIN_SECONDS} to {MAX_SECONDS} seconds long.", 400)
        if quality not in QUALITY_MEGAPIXELS:
            raise AppError("Quality is draft or final.", 400)
        if not 1 <= variations <= MAX_VARIATIONS:
            raise AppError(f"Make 1 to {MAX_VARIATIONS} variations at a time.", 400)
        workflow = wf.load(self.workflow_path)
        if scene:
            wf.find_passes(workflow)  # says why finals couldn't match previews made with it
        self._check_reachable()

        batch = f"b-{secrets.token_hex(4)}"
        created = []
        for variation in range(1, variations + 1):
            shot_seed = seed if seed is not None and variations == 1 else secrets.randbelow(MAX_SEED - 1) + 1
            megapixels = SCENE_MEGAPIXELS if scene else QUALITY_MEGAPIXELS[quality]
            job_id = f"g-{secrets.token_hex(5)}"
            filled = wf.apply(workflow, prompt=prompt, seed=shot_seed, megapixels=megapixels, duration=duration)
            nodes = None
            if scene:
                filled, nodes = wf.preview_workflow(filled, f"latents/shorts_{job_id}")
            job: dict[str, Any] = {
                "id": job_id,
                "kind": "preview" if scene else "shot",
                "batch": batch,
                "variation": variation,
                "variations": variations,
                "prompt": prompt,
                "seed": shot_seed,
                "quality": quality,
                "megapixels": megapixels,
                "duration": duration,
                "fps": wf.FPS,
                "workflow": self.workflow_path.name,
                "basedOn": based_on,
                "scene": scene,
                # The nodes added to a preview's workflow, whose results are saved with it.
                "nodes": nodes,
                "promptId": None,
                "status": "queued",
                "queuePosition": None,
                "progress": 0.0,
                "message": "Sending to ComfyUI…",
                "itemId": None,
                "error": None,
                "cancelRequested": False,
                "createdAt": utc_now(),
                "startedAt": None,
                "finishedAt": None,
            }
            try:
                self._submit(job, filled)
            except AppError as exc:
                if not created:
                    raise  # nothing queued yet: the request fails with the reason
                job.update(status="error", error=exc.message, message="", finishedAt=utc_now())
                with self._lock:
                    self.jobs[job["id"]] = job
            created.append(job)
            log.info("Queued %s %s (%d/%d, seed %d, %s) as ComfyUI prompt %s", job["kind"], job["id"], variation, variations, shot_seed, quality, job["promptId"])
        self._save()
        self.start()
        self._wake.set()
        return [dict(j) for j in created]

    def generate_final(self, preview_item_id: str, scene: dict[str, Any], seed: int | None = None) -> dict[str, Any]:
        """Queues a scene's final, made from one of its previews (a library clip): the preview's
        saved latents go to ComfyUI and only the upscale and refine passes run, so the final is
        that preview at the Final size. `seed` is the refine pass's (None: the workflow's own)."""
        scene = scene_ref(scene)
        assert scene is not None
        preview = self.library.get(preview_item_id)
        generation = preview.get("generation") or {}
        if generation.get("type") != "preview":
            raise AppError("Finals are made from a scene's previews; that clip isn't one.", 400)
        try:
            latents = {kind: self.library.latent_path(preview_item_id, kind) for kind in LATENT_KINDS}
        except AppError as exc:
            raise AppError(OLD_PREVIEW, 409) from exc
        workflow = wf.load(self.workflow_path)
        wf.find_passes(workflow)
        self._check_reachable()
        names = {kind: self.client.upload(path, f"shorts_{preview_item_id}_{kind}.latent") for kind, path in latents.items()}
        prompt = str(generation.get("prompt") or "")
        duration = int(generation.get("duration") or MIN_SECONDS)
        megapixels = float(generation.get("megapixels") or SCENE_MEGAPIXELS)
        filled = wf.apply(workflow, prompt=prompt, seed=int(generation.get("seed") or 1), megapixels=megapixels, duration=duration)
        refine_seed = seed if seed is not None else wf.refine_seed(filled)
        final = wf.final_workflow(
            filled,
            video_latent=names["video"],
            audio_latent=names["audio"],
            prompt_text=generation.get("promptText"),
            seed=seed,
        )
        job: dict[str, Any] = {
            "id": f"g-{secrets.token_hex(5)}",
            "kind": "final",
            "batch": f"b-{secrets.token_hex(4)}",
            "variation": 1,
            "variations": 1,
            "prompt": prompt,
            "seed": generation.get("seed"),
            "refineSeed": refine_seed,
            "quality": "final",
            "megapixels": megapixels,
            "duration": duration,
            "fps": wf.FPS,
            "workflow": self.workflow_path.name,
            "basedOn": preview_item_id,
            "scene": scene,
            "previewItemId": preview_item_id,
            "previewShotId": generation.get("shotId"),
            "nodes": None,
            "promptId": None,
            "status": "queued",
            "queuePosition": None,
            "progress": 0.0,
            "message": "Sending to ComfyUI…",
            "itemId": None,
            "error": None,
            "cancelRequested": False,
            "createdAt": utc_now(),
            "startedAt": None,
            "finishedAt": None,
        }
        self._submit(job, final)
        log.info("Queued the final %s of preview %s (refine seed %s) as ComfyUI prompt %s", job["id"], preview_item_id, refine_seed, job["promptId"])
        self._save()
        self.start()
        self._wake.set()
        return dict(job)

    def _check_reachable(self) -> None:
        status = self.client.status()
        if not status["reachable"]:
            raise AppError(status["error"], 503)

    def _submit(self, job: dict[str, Any], workflow: wf.Workflow) -> None:
        """Sends a job's workflow to ComfyUI's queue and starts following it (raises if refused)."""
        job["promptId"] = self.client.submit(workflow, self.client_id)
        job["message"] = "Waiting in ComfyUI's queue…"
        self._progress[job["id"]] = Progress({n: node["class_type"] for n, node in workflow.items()})
        with self._lock:
            self.jobs[job["id"]] = job

    def cancel(self, job_id: str) -> dict[str, Any]:
        job = self._get(job_id)
        if job["status"] not in ACTIVE:
            return dict(job)
        if job["status"] == "saving":
            raise AppError("This shot is already finished and being saved to the library.", 409)
        try:
            running, pending = self.client.queue()
            self.client.cancel(job["promptId"])
        except ComfyUnreachable:
            running, pending = [], []  # ComfyUI is closed, so the job isn't running anyway
        if job["promptId"] in running:
            self._set(job, cancelRequested=True, message="Cancelling…")
        else:
            self._set(job, status="cancelled", cancelRequested=True, message="", queuePosition=None, finishedAt=utc_now())
        self._wake.set()
        return dict(job)

    def dismiss(self, job_id: str) -> None:
        job = self._get(job_id)
        if job["status"] in ACTIVE:
            raise AppError("Cancel the shot before removing it from the list.", 409)
        with self._lock:
            del self.jobs[job_id]
        self._save()

    def clear_finished(self) -> None:
        """Removes the finished shots from the list. Scene previews aren't in that list (the
        Scenes tab shows them), so they stay."""
        with self._lock:
            for job_id in [j["id"] for j in self.jobs.values() if j["status"] in FINISHED and not j.get("scene")]:
                del self.jobs[job_id]
        self._save()

    def _get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise AppError(f"Shot {job_id!r} was not found.", 404)
        return job

    # Tracking ------------------------------------------------------------------------------------

    def start(self) -> None:
        """Starts the tracker (and the progress listener) once."""
        with self._lock:
            if self._threads:
                return
            self._stopping.clear()
            for target, name in ((self._track, "comfy-tracker"), (self._listen, "comfy-progress")):
                thread = threading.Thread(target=target, name=name, daemon=True)
                thread.start()
                self._threads.append(thread)

    def resume(self) -> None:
        """After a restart: keep following jobs that were still in ComfyUI."""
        if any(j["status"] in ACTIVE for j in self.jobs.values()):
            log.info("Resuming %d unfinished ComfyUI shot(s)", sum(j["status"] in ACTIVE for j in self.jobs.values()))
            self.start()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        for thread in self._threads:
            thread.join(timeout=5)
        self._threads = []

    def _active(self) -> list[dict[str, Any]]:
        with self._lock:
            return [j for j in self.jobs.values() if j["status"] in ACTIVE and j.get("promptId")]

    def _track(self) -> None:
        while not self._stopping.is_set():
            try:
                self.poll()
            except Exception:  # never let the tracker die
                log.exception("Following ComfyUI jobs failed; trying again")
            self._wake.wait(self.poll_seconds)
            self._wake.clear()

    def poll(self) -> None:
        """One round: queue positions, finished jobs, lost jobs."""
        active = self._active()
        if not active:
            return
        try:
            running, pending = self.client.queue()
        except ComfyUnreachable:
            for job in active:
                if job["status"] != "saving":
                    self._set(job, persist=False, message="ComfyUI isn't answering. Open ComfyUI Desktop to continue.")
            return
        for job in active:
            prompt_id = job["promptId"]
            if job["status"] == "saving":
                self._finish(job)
            elif prompt_id in running or prompt_id in pending:
                self._lost_since.pop(job["id"], None)
                with self._lock:
                    if job["status"] not in ACTIVE:
                        continue  # cancelled since the queue was read
                    if prompt_id in running:
                        changes: dict[str, Any] = {"queuePosition": 0}
                        if job["status"] != "running":
                            changes.update(status="running", startedAt=job["startedAt"] or utc_now(), message="Starting…")
                        self._set(job, persist=job["status"] != "running", **changes)
                    else:
                        ahead = len(running) + pending.index(prompt_id)
                        self._set(
                            job,
                            persist=False,
                            status="queued",
                            queuePosition=ahead,
                            message=f"Waiting in ComfyUI's queue ({ahead} ahead)" if ahead else "Next in ComfyUI's queue",
                        )
            else:
                self._check_history(job)

    def _check_history(self, job: dict[str, Any]) -> None:
        entry = self.client.history(job["promptId"])
        if entry is None:
            since = self._lost_since.setdefault(job["id"], time.monotonic())
            if time.monotonic() - since > LOST_AFTER_SECONDS:
                self._fail(job, "ComfyUI no longer knows about this shot. Was ComfyUI restarted? Generate it again.")
            return
        self._lost_since.pop(job["id"], None)
        status = (entry.get("status") or {}).get("status_str")
        if status == "success":
            self._set(job, status="saving", progress=0.96, message="Saving to the library…", queuePosition=None)
            self._finish(job, entry)
        elif status == "error" or (entry.get("status") or {}).get("completed") is False:
            reason, interrupted = failure_reason(entry)
            if interrupted or job.get("cancelRequested"):
                self._set(job, status="cancelled", message="", queuePosition=None, finishedAt=utc_now())
            else:
                self._fail(job, reason)

    def _fail(self, job: dict[str, Any], reason: str) -> None:
        log.warning("Shot %s failed: %s", job["id"], reason)
        self._set(job, status="error", error=reason, message="", queuePosition=None, finishedAt=utc_now())

    def _finish(self, job: dict[str, Any], entry: dict[str, Any] | None = None) -> None:
        """Downloads the finished video and adds it to the library."""
        try:
            entry = entry or self.client.history(job["promptId"])
            if entry is None:
                raise AppError("ComfyUI no longer has this shot's result. Generate it again.", 502)
            try:
                preferred = wf.output_node(wf.load(self.workflow_path))
            except AppError:
                preferred = None
            files = output_files(entry, preferred)
            if not files:
                raise AppError("ComfyUI finished but saved no video. Check the Save Video node in the workflow.", 502)
            file = files[0]
            temp = self.library.incoming_dir / f"comfy-{job['id']}{Path(file['filename']).suffix or '.mp4'}"
            latents = {kind: self.library.incoming_dir / f"comfy-{job['id']}-{kind}.latent" for kind in LATENT_KINDS} if job.get("nodes") else {}
            try:
                self.client.download(file, temp, lambda p: self._set(job, persist=False, progress=0.96 + 0.02 * p))
                for kind, target in latents.items():
                    saved = node_files(entry, job["nodes"][f"{kind}Latent"], ".latent")
                    if not saved:
                        raise AppError(
                            f"ComfyUI made the preview but didn't save its {kind} latent, so no final could match it. "
                            "Check that ComfyUI has the SaveLatent node, then retry.",
                            502,
                        )
                    self.client.download(saved[0], target)
                info = probe(temp)
                generation = {
                    "prompt": job["prompt"],
                    "seed": job["seed"],
                    "quality": job["quality"],
                    "megapixels": job["megapixels"],
                    "resolution": f"{info.width}x{info.height}",
                    "duration": job["duration"],
                    "fps": job["fps"],
                    "workflow": job["workflow"],
                    "comfyPromptId": job["promptId"],
                    "comfyFile": file["filename"],
                    "basedOn": job.get("basedOn"),
                    "generatedAt": utc_now(),
                }
                if job.get("kind") == "final":
                    # A scene final: its scene, and the preview (and that preview's job) it's made from.
                    generation.update(
                        type="final",
                        **job["scene"],
                        shotId=job["id"],
                        previewItemId=job["previewItemId"],
                        previewShotId=job.get("previewShotId"),
                        refineSeed=job.get("refineSeed"),
                    )
                elif job.get("scene"):
                    # A scene preview: which project and scene it's for, and the job that made it.
                    generation.update(type="preview", **job["scene"], shotId=job["id"])
                    text = node_text(entry, job["nodes"]["promptText"]) if (job.get("nodes") or {}).get("promptText") else None
                    if text is not None:
                        # The exact text the prompt became (the enhancer may rewrite it): its final reads the same.
                        generation["promptText"] = text
                name = shot_name(job["prompt"], job["variation"], job["variations"])
                metadata = ClipMetadata(
                    name=f"Final: {name}" if job.get("kind") == "final" else name,
                    ai_generated=True,
                    original_name=file["filename"],
                    generation=generation,
                )
                item = self.library.add_clip(temp, "ai", metadata, latents=latents or None)
            finally:
                temp.unlink(missing_ok=True)
                for path in latents.values():
                    path.unlink(missing_ok=True)
        except ComfyUnreachable:
            self._set(job, persist=False, message="ComfyUI isn't answering. Open ComfyUI Desktop to save the shot.")
            return
        except AppError as exc:
            self._fail(job, exc.message)
            return
        log.info("Shot %s saved to the library as %s", job["id"], item["id"])
        self._set(job, status="done", itemId=item["id"], progress=1.0, message="", finishedAt=utc_now())

    def _listen(self) -> None:
        """Live progress from ComfyUI's websocket (reconnects while ComfyUI is closed)."""
        while not self._stopping.is_set():
            if not self._active():
                self._stopping.wait(1.0)
                continue
            try:
                for event in self.client.events(self.client_id, self._stopping.is_set):
                    self.on_event(event)
            except Exception as exc:  # closed ComfyUI, dropped connection, ...
                log.debug("ComfyUI websocket: %s", exc)
            self._stopping.wait(2.0)

    def on_event(self, event: dict[str, Any]) -> None:
        kind, data = event.get("type"), event.get("data") or {}
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            return
        with self._lock:
            job = next((j for j in self.jobs.values() if j.get("promptId") == prompt_id), None)
        if job is None or job["status"] not in ("queued", "running"):
            return
        progress = self._progress.get(job["id"])
        if progress is None:
            progress = self._progress[job["id"]] = Progress(self._classes(job))
        if kind == "execution_start":
            self._set(job, status="running", queuePosition=0, startedAt=job["startedAt"] or utc_now(), message="Starting…")
            return
        if kind == "execution_cached":
            progress.cached([str(n) for n in data.get("nodes") or []])
        elif kind == "executing":
            node = data.get("node")
            progress.executing(str(node) if node is not None else None)
        elif kind == "progress":
            if data.get("node") and str(data["node"]) != progress.current:
                progress.executing(str(data["node"]))
            progress.step = (int(data.get("value") or 0), int(data.get("max") or 0))
        else:
            return
        message = "Cancelling…" if job.get("cancelRequested") else progress.message()
        self._set(job, persist=False, status="running", queuePosition=0, progress=round(progress.fraction(), 4), message=message)

    def _classes(self, job: dict[str, Any]) -> dict[str, str]:
        """The node types of the workflow a job ran (after a restart, rebuilt from the file)."""
        try:
            workflow = wf.load(self.workflow_path)
            if job.get("kind") == "final":
                workflow = wf.final_workflow(workflow, video_latent="", audio_latent="")
            elif job.get("nodes"):
                workflow = wf.preview_workflow(workflow, "")[0]
        except AppError:
            return {}
        return {n: node["class_type"] for n, node in workflow.items()}


@lru_cache
def get_generation_service(settings: Settings) -> GenerationService:
    return GenerationService(settings)
