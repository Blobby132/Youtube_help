"""Talking to ComfyUI (Desktop or not) over its HTTP and websocket API.

Only the backend talks to ComfyUI; the browser never does. The address comes from COMFYUI_URL
in .env (http://127.0.0.1:8188 by default).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx

from app.core.errors import AppError
from app.stock.files import download_file

log = logging.getLogger("shorts.comfy")

TIMEOUT = httpx.Timeout(10.0, connect=3.0)
STATUS_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
DOWNLOAD_TIMEOUT = httpx.Timeout(120.0, connect=5.0)
VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".mkv", ".gif")
# ComfyUI Desktop serves on port 8000 unless you change it; the portable build on 8188.
DESKTOP_PORT = 8000


class ComfyUnreachable(AppError):
    def __init__(self, url: str, reason: str = "") -> None:
        detail = f" ({reason})" if reason else ""
        super().__init__(
            f"ComfyUI isn't answering at {url}{detail}. Open ComfyUI Desktop and wait until it has "
            "finished starting, then try again. If it runs on another address, set COMFYUI_URL in .env.",
            503,
        )


def readable_refusal(body: Any) -> str:
    """ComfyUI's 400 answer to /prompt as one sentence, e.g. a model file that isn't installed."""
    if not isinstance(body, dict):
        return str(body)[:300]
    parts = []
    error = body.get("error")
    if isinstance(error, dict) and error.get("message"):
        parts.append(str(error["message"]).rstrip("."))
    for node_id, info in (body.get("node_errors") or {}).items():
        if not isinstance(info, dict):
            continue
        for item in info.get("errors") or []:
            text = item.get("details") or item.get("message")
            if text:
                parts.append(f"{info.get('class_type', 'node')} {node_id}: {text}")
    return "; ".join(parts) or json.dumps(body)[:300]


class ComfyClient:
    def __init__(self, url: str, transport: httpx.BaseTransport | None = None) -> None:
        self.url = url.rstrip("/")
        self.transport = transport

    def _client(self, timeout: httpx.Timeout = TIMEOUT) -> httpx.Client:
        return httpx.Client(base_url=self.url, transport=self.transport, timeout=timeout)

    def _request(self, method: str, path: str, timeout: httpx.Timeout = TIMEOUT, **kwargs: Any) -> httpx.Response:
        try:
            with self._client(timeout) as client:
                return client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ComfyUnreachable(self.url, "no answer in time") from exc
        except httpx.HTTPError as exc:
            raise ComfyUnreachable(self.url, type(exc).__name__) from exc

    def _json(self, response: httpx.Response, what: str) -> Any:
        if response.status_code >= 400:
            raise AppError(f"ComfyUI couldn't {what} (HTTP {response.status_code}): {response.text[:300]}", 502)
        try:
            return response.json()
        except ValueError as exc:
            raise AppError(f"ComfyUI sent an unexpected answer when asked to {what}.", 502) from exc

    # Status --------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Whether ComfyUI answers, and its version and GPU when it does."""
        try:
            response = self._request("GET", "/system_stats", STATUS_TIMEOUT)
            stats = self._json(response, "report its status")
        except AppError as exc:
            hint = self._desktop_hint()
            return {"reachable": False, "url": self.url, "error": exc.message + (f" {hint}" if hint else "")}
        system = stats.get("system") or {}
        devices = [d.get("name") for d in stats.get("devices") or [] if isinstance(d, dict) and d.get("name")]
        return {
            "reachable": True,
            "url": self.url,
            "version": system.get("comfyui_version"),
            "device": devices[0] if devices else None,
            "error": None,
        }

    def _desktop_hint(self) -> str:
        """If nothing answers on the configured port but ComfyUI Desktop's usual port does, say so."""
        parsed = httpx.URL(self.url)
        if parsed.port == DESKTOP_PORT or parsed.host not in ("127.0.0.1", "localhost"):
            return ""
        desktop = str(parsed.copy_with(port=DESKTOP_PORT))
        try:
            with httpx.Client(transport=self.transport, timeout=STATUS_TIMEOUT) as client:
                if client.get(f"{desktop.rstrip('/')}/system_stats").status_code == 200:
                    return f"ComfyUI is answering at {desktop.rstrip('/')}: set COMFYUI_URL={desktop.rstrip('/')} in .env and restart the app."
        except httpx.HTTPError:
            pass
        return ""

    # Jobs ----------------------------------------------------------------------------------------

    def submit(self, workflow: dict[str, Any], client_id: str) -> str:
        """Queues a workflow; returns ComfyUI's prompt id."""
        response = self._request("POST", "/prompt", json={"prompt": workflow, "client_id": client_id})
        if response.status_code == 400:
            try:
                body = response.json()
            except ValueError:
                body = response.text
            raise AppError(f"ComfyUI refused the workflow: {readable_refusal(body)}", 422)
        data = self._json(response, "queue the workflow")
        if not isinstance(data, dict) or not data.get("prompt_id"):
            raise AppError("ComfyUI didn't return a job id for the workflow.", 502)
        if data.get("node_errors"):
            raise AppError(f"ComfyUI refused the workflow: {readable_refusal(data)}", 422)
        return str(data["prompt_id"])

    def queue(self) -> tuple[list[str], list[str]]:
        """Prompt ids running now, and waiting (in order)."""
        data = self._json(self._request("GET", "/queue"), "list its queue")

        def ids(entries: Any) -> list[tuple[float, str]]:
            found = []
            for entry in entries or []:
                if isinstance(entry, list) and len(entry) > 1:
                    found.append((float(entry[0]) if isinstance(entry[0], int | float) else 0.0, str(entry[1])))
            return sorted(found)

        return [i for _, i in ids(data.get("queue_running"))], [i for _, i in ids(data.get("queue_pending"))]

    def history(self, prompt_id: str) -> dict[str, Any] | None:
        """The finished job's record, or None while it hasn't finished (or ComfyUI forgot it)."""
        data = self._json(self._request("GET", f"/history/{prompt_id}"), "look up a finished job")
        entry = data.get(prompt_id) if isinstance(data, dict) else None
        return entry if isinstance(entry, dict) else None

    def free_memory(self) -> bool:
        """Asks ComfyUI to unload its models and free the GPU memory they hold (what its own "Unload
        models" button does); it does so as soon as nothing is running. False when this ComfyUI has
        no such API (versions before 2024)."""
        response = self._request("POST", "/free", json={"unload_models": True, "free_memory": True})
        if response.status_code in (404, 405):
            return False
        if response.status_code >= 400:
            raise AppError(f"ComfyUI couldn't free its memory (HTTP {response.status_code}): {response.text[:300]}", 502)
        return True

    def cancel(self, prompt_id: str) -> None:
        """Removes a waiting job from ComfyUI's queue, or stops it if it's running."""
        running, pending = self.queue()
        if prompt_id in pending:
            self._request("POST", "/queue", json={"delete": [prompt_id]})
        if prompt_id in running:
            # Newer ComfyUI only interrupts when this prompt is the one running.
            self._request("POST", "/interrupt", json={"prompt_id": prompt_id})

    def download(self, file: dict[str, Any], target: Path, on_progress: Callable[[float], None] | None = None) -> None:
        params = {"filename": file["filename"], "subfolder": file.get("subfolder", ""), "type": file.get("type", "output")}
        url = f"{self.url}/view?{httpx.QueryParams(params)}"
        download_file(httpx.Client(transport=self.transport, timeout=DOWNLOAD_TIMEOUT), url, target, "ComfyUI", on_progress)

    def upload(self, path: Path, name: str) -> str:
        """Puts a file in ComfyUI's input folder (replacing one with that name), where loader
        nodes such as LoadLatent find it. Returns the name to give those nodes."""
        try:
            content = path.read_bytes()
        except OSError as exc:
            raise AppError(f"Can't read {path.name} to send it to ComfyUI: {exc}", 500) from exc
        response = self._request(
            "POST",
            "/upload/image",
            DOWNLOAD_TIMEOUT,
            files={"image": (name, content, "application/octet-stream")},
            data={"type": "input", "overwrite": "true"},
        )
        data = self._json(response, f"take the file {name}")
        if not isinstance(data, dict) or not data.get("name"):
            raise AppError(f"ComfyUI didn't say where it saved {name}.", 502)
        subfolder = str(data.get("subfolder") or "").strip("/")
        return f"{subfolder}/{data['name']}" if subfolder else str(data["name"])

    def events(self, client_id: str, stop: Callable[[], bool]) -> Iterator[dict[str, Any]]:
        """ComfyUI's progress messages for jobs queued with `client_id`, until `stop()` is true
        or the connection drops (raises OSError then)."""
        from websockets.exceptions import WebSocketException
        from websockets.sync.client import connect

        ws_url = self.url.replace("https://", "wss://").replace("http://", "ws://") + f"/ws?clientId={client_id}"
        try:
            with connect(ws_url, open_timeout=3, close_timeout=1, max_size=None) as socket:
                while not stop():
                    try:
                        message = socket.recv(timeout=0.5)
                    except TimeoutError:
                        continue
                    if isinstance(message, str):  # binary messages are preview images
                        try:
                            event = json.loads(message)
                        except ValueError:
                            continue
                        if isinstance(event, dict):
                            yield event
        except WebSocketException as exc:
            raise OSError(f"ComfyUI websocket closed: {exc}") from exc


def output_files(history: dict[str, Any], preferred_node: str | None) -> list[dict[str, Any]]:
    """The video files a finished job saved (the SaveVideo node's first, then any others)."""
    outputs = history.get("outputs") or {}
    nodes = sorted(outputs, key=lambda node_id: node_id != preferred_node)
    files = []
    for node_id in nodes:
        for value in (outputs.get(node_id) or {}).values():
            for file in value if isinstance(value, list) else []:
                if isinstance(file, dict) and str(file.get("filename", "")).lower().endswith(VIDEO_EXTENSIONS):
                    files.append(file)
    return files


def node_files(history: dict[str, Any], node_id: str, extension: str) -> list[dict[str, Any]]:
    """The files one node of a finished job saved with that extension (e.g. SaveLatent's .latent)."""
    files = []
    for value in ((history.get("outputs") or {}).get(node_id) or {}).values():
        for file in value if isinstance(value, list) else []:
            if isinstance(file, dict) and str(file.get("filename", "")).lower().endswith(extension):
                files.append(file)
    return files


def node_text(history: dict[str, Any], node_id: str) -> str | None:
    """The text a node such as Preview as Text showed, or None."""
    texts = ((history.get("outputs") or {}).get(node_id) or {}).get("text")
    if isinstance(texts, list) and texts and isinstance(texts[0], str):
        return texts[0]
    return None


def failure_reason(history: dict[str, Any]) -> tuple[str, bool]:
    """Why a job failed, and whether it was interrupted (cancelled) rather than an error."""
    messages = (history.get("status") or {}).get("messages") or []
    for event, data in reversed([m for m in messages if isinstance(m, list) and len(m) == 2]):
        if event == "execution_interrupted":
            return "Cancelled in ComfyUI.", True
        if event == "execution_error" and isinstance(data, dict):
            node = f"{data.get('node_type', 'a node')} ({data.get('node_id', '?')})"
            return f"ComfyUI failed in {node}: {data.get('exception_message', 'unknown error').strip()}", False
    return "ComfyUI reported an error without details. See the ComfyUI window for more.", False
