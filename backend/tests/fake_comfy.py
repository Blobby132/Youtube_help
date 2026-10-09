"""A fake ComfyUI: the same HTTP and websocket API, run in a thread on a free port. Tests move
jobs along by hand (start_next, progress, finish), so nothing depends on timing."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeComfy:
    OUTPUT_NODE = "75"

    def __init__(self, video: Path) -> None:
        self.video = video
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.submitted: dict[str, dict[str, Any]] = {}  # prompt id -> {"prompt", "client_id"}
        self.pending: list[str] = []
        self.running: str | None = None
        self.history: dict[str, dict[str, Any]] = {}
        self.deleted: list[str] = []
        self.interrupted: list[str] = []
        self.refusal: dict[str, Any] | None = None
        # Files put in ComfyUI's input folder (/upload/image), by name.
        self.uploads: dict[str, bytes] = {}
        # Files in the output folder other than the video, by (subfolder, name): saved latents.
        self.files: dict[tuple[str, str], bytes] = {}
        # Set to make Preview as Text show this (as if the prompt enhancer rewrote the prompt).
        self.enhanced_prompt: str | None = None
        # Off: SaveLatent nodes save nothing (as if they failed quietly).
        self.save_latents = True
        # The bodies of POST /free (asking ComfyUI to unload its models); off: an older ComfyUI without it.
        self.freed: list[dict[str, Any]] = []
        self.can_free = True
        self.sockets: dict[str, list[WebSocket]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self._counter = 0
        self._lock = threading.Lock()
        app = Starlette(
            routes=[
                Route("/system_stats", self.system_stats),
                Route("/prompt", self.prompt, methods=["POST"]),
                Route("/queue", self.queue, methods=["GET", "POST"]),
                Route("/history/{prompt_id}", self.get_history),
                Route("/view", self.view),
                Route("/upload/image", self.upload, methods=["POST"]),
                Route("/interrupt", self.interrupt, methods=["POST"]),
                Route("/free", self.free, methods=["POST"]),
                WebSocketRoute("/ws", self.ws),
            ]
        )
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    # Lifecycle -------------------------------------------------------------------------------------

    def start(self) -> FakeComfy:
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            assert time.time() < deadline, "fake ComfyUI didn't start"
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)

    # HTTP ------------------------------------------------------------------------------------------

    async def system_stats(self, request: Request) -> Response:
        return JSONResponse({"system": {"comfyui_version": "0.9.0-fake"}, "devices": [{"name": "cuda:0 Fake GPU"}]})

    async def prompt(self, request: Request) -> Response:
        body = await request.json()
        if self.refusal is not None:
            return JSONResponse(self.refusal, status_code=400)
        with self._lock:
            self._counter += 1
            prompt_id = f"prompt-{self._counter}"
            self.submitted[prompt_id] = {"prompt": body["prompt"], "client_id": body.get("client_id")}
            self.pending.append(prompt_id)
        return JSONResponse({"prompt_id": prompt_id, "number": self._counter, "node_errors": {}})

    async def queue(self, request: Request) -> Response:
        if request.method == "POST":
            body = await request.json()
            with self._lock:
                for prompt_id in body.get("delete", []):
                    if prompt_id in self.pending:
                        self.pending.remove(prompt_id)
                        self.deleted.append(prompt_id)
            return JSONResponse({})
        number = {pid: i for i, pid in enumerate(self.submitted)}
        entry = lambda pid: [number[pid], pid, {}, {}, [self.OUTPUT_NODE]]  # noqa: E731
        return JSONResponse(
            {
                "queue_running": [entry(self.running)] if self.running else [],
                "queue_pending": [entry(pid) for pid in self.pending],
            }
        )

    async def get_history(self, request: Request) -> Response:
        prompt_id = request.path_params["prompt_id"]
        return JSONResponse({prompt_id: self.history[prompt_id]} if prompt_id in self.history else {})

    async def view(self, request: Request) -> Response:
        assert request.query_params["type"] == "output"
        subfolder, filename = request.query_params["subfolder"], request.query_params["filename"]
        if subfolder == "video":
            return FileResponse(self.video)
        if (subfolder, filename) in self.files:
            return Response(self.files[(subfolder, filename)], media_type="application/octet-stream")
        return Response(status_code=404)

    async def upload(self, request: Request) -> Response:
        form = await request.form()
        image = form["image"]
        assert form.get("type") == "input" and form.get("overwrite") == "true"
        name = image.filename  # type: ignore[union-attr]
        self.uploads[name] = await image.read()  # type: ignore[union-attr]
        return JSONResponse({"name": name, "subfolder": "", "type": "input"})

    async def interrupt(self, request: Request) -> Response:
        body = await request.json() if await request.body() else {}
        wanted = body.get("prompt_id")
        if self.running and (wanted is None or wanted == self.running):
            prompt_id = self.running
            self.interrupted.append(prompt_id)
            self._finish(prompt_id, [["execution_interrupted", {"prompt_id": prompt_id, "node_id": "405:344"}]], ok=False)
        return JSONResponse({})

    async def free(self, request: Request) -> Response:
        if not self.can_free:
            return Response("404: Not Found", status_code=404)
        self.freed.append(await request.json())
        return Response(status_code=200)

    async def ws(self, websocket: WebSocket) -> None:
        client_id = websocket.query_params.get("clientId", "")
        await websocket.accept()
        self.loop = asyncio.get_running_loop()
        self.sockets.setdefault(client_id, []).append(websocket)
        await websocket.send_text(json.dumps({"type": "status", "data": {"status": {"exec_info": {"queue_remaining": 0}}, "sid": client_id}}))
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            self.sockets[client_id].remove(websocket)

    # Test controls ---------------------------------------------------------------------------------

    def wait_for_socket(self, client_id: str, timeout: float = 10) -> None:
        deadline = time.time() + timeout
        while not self.sockets.get(client_id):
            assert time.time() < deadline, "the backend never connected to the websocket"
            time.sleep(0.02)

    def send(self, prompt_id: str, kind: str, data: dict[str, Any]) -> None:
        client_id = self.submitted[prompt_id]["client_id"]
        self.wait_for_socket(client_id)
        message = json.dumps({"type": kind, "data": {**data, "prompt_id": prompt_id}})
        assert self.loop is not None
        for websocket in list(self.sockets.get(client_id, [])):
            asyncio.run_coroutine_threadsafe(websocket.send_text(message), self.loop).result(timeout=5)
        preview = b"\x00\x00\x00\x01preview"  # previews arrive as binary frames, which are ignored
        for websocket in list(self.sockets.get(client_id, [])):
            asyncio.run_coroutine_threadsafe(websocket.send_bytes(preview), self.loop).result(timeout=5)

    def start_next(self, notify: bool = True) -> str:
        """Starts the next waiting job (and tells the backend over the websocket)."""
        with self._lock:
            prompt_id = self.pending.pop(0)
            self.running = prompt_id
        if notify:
            self.send(prompt_id, "execution_start", {"timestamp": 0})
        return prompt_id

    def progress(self, prompt_id: str, node: str, value: int, maximum: int) -> None:
        self.send(prompt_id, "executing", {"node": node})
        self.send(prompt_id, "progress", {"node": node, "value": value, "max": maximum})

    def finish(self, prompt_id: str, error: str | None = None) -> None:
        if error:
            messages = [
                ["execution_start", {"prompt_id": prompt_id}],
                ["execution_error", {"prompt_id": prompt_id, "node_id": "405:344", "node_type": "SamplerCustomAdvanced", "exception_message": error}],
            ]
            self._finish(prompt_id, messages, ok=False)
        else:
            self._finish(prompt_id, [["execution_success", {"prompt_id": prompt_id}]], ok=True)

    def _finish(self, prompt_id: str, messages: list, ok: bool) -> None:
        outputs: dict[str, Any] = {}
        if ok:
            outputs[self.OUTPUT_NODE] = {
                "images": [{"filename": "LTX_2.5_t2v_00001_.mp4", "subfolder": "video", "type": "output"}],
                "animated": [True],
            }
            graph = self.submitted[prompt_id]["prompt"]
            for node_id, node in graph.items():
                if node["class_type"] == "SaveLatent" and self.save_latents:
                    # Like ComfyUI: <prefix>_00001_.latent in the prefix's folder, made from that pass.
                    folder, _, base = node["inputs"]["filename_prefix"].rpartition("/")
                    name = f"{base}_00001_.latent"
                    self.files[(folder, name)] = f"{prompt_id}:{node['inputs']['samples']}".encode()
                    outputs[node_id] = {"latents": [{"filename": name, "subfolder": folder, "type": "output"}]}
                elif node["class_type"] == "PreviewAny":
                    prompt = next(n["inputs"]["value"] for n in graph.values() if (n.get("_meta") or {}).get("title") == "Prompt")
                    outputs[node_id] = {"text": [self.enhanced_prompt or prompt]}
        self.history[prompt_id] = {
            "prompt": [0, prompt_id, self.submitted[prompt_id]["prompt"], {}, [self.OUTPUT_NODE]],
            "outputs": outputs,
            "status": {"status_str": "success" if ok else "error", "completed": ok, "messages": messages},
        }
        with self._lock:
            if self.running == prompt_id:
                self.running = None

    def forget(self, prompt_id: str) -> None:
        """As if ComfyUI was restarted: the job is gone from the queue and the history."""
        with self._lock:
            if self.running == prompt_id:
                self.running = None
            if prompt_id in self.pending:
                self.pending.remove(prompt_id)
            self.history.pop(prompt_id, None)
