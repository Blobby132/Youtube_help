"""Talking to a language model on this PC through its OpenAI-compatible API: LM Studio, Ollama, or
any server with /v1/chat/completions (llama.cpp's, for example).

Only the backend talks to it. The address and model come from LLM_URL and LLM_MODEL in .env;
LLM_URL may end in /v1 or not. Answers are streamed, so a run can show which scene the model is
writing, and asked for as JSON that follows a schema (servers that can't enforce one get the plain
JSON mode, or the instructions alone).

Two servers can also be asked to unload the model from the GPU after a run: LM Studio 0.4 and newer
(POST /api/v1/models/unload) and Ollama (keep_alive 0 on its own /api/generate). Others keep the
model loaded until they unload it themselves.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from app.core.errors import AppError

log = logging.getLogger("shorts.llm")

Server = Literal["lmstudio", "ollama", "openai"]
SERVER_NAMES: dict[str, str] = {"lmstudio": "LM Studio", "ollama": "Ollama", "openai": "OpenAI-compatible server"}
# Where LM Studio and Ollama listen unless you change it, to say where one is answering when
# LLM_URL points elsewhere.
KNOWN_PORTS: dict[int, str] = {1234: "LM Studio", 11434: "Ollama"}

STATUS_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
# Loading a model and reading a long prompt can take a while before the first word arrives.
CHAT_TIMEOUT = httpx.Timeout(connect=3.0, read=300.0, write=30.0, pool=5.0)
UNLOAD_TIMEOUT = httpx.Timeout(30.0, connect=3.0)

# The ways to ask for JSON, best first. A server that refuses one (HTTP 400) gets the next.
FORMATS = ("json_schema", "json_object", "none")


def server_root(url: str) -> str:
    """The server's address without the /v1 of its OpenAI-compatible API."""
    root = url.strip().rstrip("/")
    return root[: -len("/v1")] if root.endswith("/v1") else root


class LlmUnreachable(AppError):
    def __init__(self, url: str, reason: str = "") -> None:
        detail = f" ({reason})" if reason else ""
        super().__init__(
            f"The language model server isn't answering at {url}{detail}. Start the server in LM Studio "
            "(Developer → Start server) or start Ollama, then check again. If it runs on another address, "
            "set LLM_URL in .env and restart the app.",
            503,
        )


def readable_error(response: httpx.Response) -> str:
    """A server's error answer as one line: OpenAI's {"error": {"message"}}, or {"error": "..."}."""
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:300] or response.reason_phrase
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])[:300]
    if isinstance(error, str) and error:
        return error[:300]
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return body["detail"][:300]
    return json.dumps(body)[:300]


def same_model(listed: str, wanted: str) -> bool:
    """Ollama lists "qwen3:latest" for "qwen3"; otherwise names have to match exactly."""
    return listed == wanted or listed.removesuffix(":latest") == wanted.removesuffix(":latest")


@dataclass
class Reply:
    """What the model answered: its text, and why it stopped ("stop", or "length" when it ran out of room)."""

    text: str
    finish_reason: str | None
    # The JSON request that got the answer: "json_schema", "json_object" or "none".
    format: str


class LlmClient:
    def __init__(self, url: str, model: str | None, transport: httpx.BaseTransport | None = None) -> None:
        self.root = server_root(url)
        self.url = f"{self.root}/v1"
        self.model = model
        self.transport = transport
        # Found out once the server answers.
        self._server: Server | None = None
        self._lmstudio_api = False
        # The first JSON request this server accepted, so later runs start with it.
        self._format_index = 0

    def _client(self, timeout: httpx.Timeout) -> httpx.Client:
        return httpx.Client(base_url=self.root, transport=self.transport, timeout=timeout)

    def _request(self, method: str, path: str, timeout: httpx.Timeout = STATUS_TIMEOUT, **kwargs: Any) -> httpx.Response:
        try:
            with self._client(timeout) as client:
                return client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise LlmUnreachable(self.url, "no answer in time") from exc
        except httpx.HTTPError as exc:
            raise LlmUnreachable(self.url, type(exc).__name__) from exc

    def _get_json(self, path: str) -> Any:
        """GET a path; its JSON, or None if the server doesn't have it."""
        response = self._request("GET", path)
        if response.status_code != 200:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    # Status --------------------------------------------------------------------------------------

    def models(self) -> list[str]:
        """The model names the server lists (GET /v1/models)."""
        data = self._get_json("/v1/models")
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise AppError(
                f"Something answers at {self.url}, but not like an OpenAI-compatible server (no model list at /v1/models). "
                "Check LLM_URL in .env.",
                502,
            )
        return [str(m["id"]) for m in data["data"] if isinstance(m, dict) and m.get("id")]

    def server(self) -> Server:
        """Which server this is: Ollama answers /api/version, LM Studio 0.4+ lists its models at
        /api/v1/models (older LM Studio at /api/v0/models). LM Studio answers unknown paths with 200
        and an error, so the answers' contents are checked, not just their status."""
        if self._server is None:
            version = self._get_json("/api/version")
            if isinstance(version, dict) and isinstance(version.get("version"), str):
                self._server = "ollama"
            else:
                native = self._get_json("/api/v1/models")
                self._lmstudio_api = isinstance(native, dict) and isinstance(native.get("models"), list)
                older = None if self._lmstudio_api else self._get_json("/api/v0/models")
                is_lmstudio = self._lmstudio_api or (isinstance(older, dict) and isinstance(older.get("data"), list))
                self._server = "lmstudio" if is_lmstudio else "openai"
        return self._server

    def can_unload(self) -> bool:
        server = self.server()
        return server == "ollama" or (server == "lmstudio" and self._lmstudio_api)

    def status(self) -> dict[str, Any]:
        """Whether the server answers, which one it is, and whether it has the model."""
        base = {"url": self.url, "model": self.model}
        try:
            models = self.models()
            server = self.server()
        except AppError as exc:
            hint = self._port_hint()
            return {**base, "reachable": False, "error": exc.message + (f" {hint}" if hint else "")}
        name = SERVER_NAMES[server]
        problem = warning = None
        if not self.model:
            listed = f" ({', '.join(models[:8])}{', …' if len(models) > 8 else ''})" if models else ""
            problem = f"Set LLM_MODEL in .env to the model to use{listed}, then restart the app."
            if not models:
                problem += f" {name} lists no models yet: download one first."
        elif models and not any(same_model(m, self.model) for m in models):
            warning = f"{name} doesn't list a model called “{self.model}”. It has: {', '.join(models[:8])}. Check LLM_MODEL in .env."
        return {
            **base,
            "reachable": True,
            "error": None,
            "server": server,
            "serverName": name,
            "models": models,
            "modelProblem": problem,
            "modelWarning": warning,
            "canUnload": self.can_unload(),
        }

    def _port_hint(self) -> str:
        """If nothing answers at LLM_URL but LM Studio's or Ollama's usual port does, say so."""
        parsed = httpx.URL(self.root)
        if parsed.host not in ("127.0.0.1", "localhost"):
            return ""
        for port, name in KNOWN_PORTS.items():
            if port == parsed.port:
                continue
            other = f"{str(parsed.copy_with(port=port)).rstrip('/')}/v1"
            try:
                with httpx.Client(transport=self.transport, timeout=STATUS_TIMEOUT) as client:
                    if client.get(f"{other}/models").status_code == 200:
                        return f"{name} is answering at {other}: set LLM_URL={other} in .env and restart the app."
            except httpx.HTTPError:
                pass
        return ""

    # Chat ----------------------------------------------------------------------------------------

    def chat(
        self,
        messages: list[dict[str, str]],
        schema: dict[str, Any],
        on_text: Callable[[str, int], None] | None = None,
        temperature: float = 0.5,
    ) -> Reply:
        """Sends the conversation and returns the answer, streamed: `on_text(text so far, characters
        of reasoning so far)` is called as it arrives. JSON is asked for with `schema`; a server that
        refuses that request (HTTP 400) is asked for plain JSON mode, then with no format at all."""
        if not self.model:
            raise AppError("Set LLM_MODEL in .env to the language model to use, then restart the app.", 400)
        index = self._format_index
        while True:
            fmt = FORMATS[index]
            body: dict[str, Any] = {"model": self.model, "messages": messages, "temperature": temperature, "stream": True}
            if fmt == "json_schema":
                body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "strict": True, "schema": schema}}
            elif fmt == "json_object":
                body["response_format"] = {"type": "json_object"}
            try:
                reply = self._stream(body, fmt, on_text)
            except _Refused as refused:
                if refused.status in (400, 422) and index < len(FORMATS) - 1:
                    log.info("%s refused response_format %s (%s); trying %s", self.url, fmt, refused.message, FORMATS[index + 1])
                    index += 1
                    continue
                raise AppError(f"The language model server refused the request (HTTP {refused.status}): {refused.message}", 502) from None
            # Remembered only once it worked: a 400 for another reason (no model loaded) mustn't stick.
            self._format_index = index
            return reply

    def _stream(self, body: dict[str, Any], fmt: str, on_text: Callable[[str, int], None] | None) -> Reply:
        text: list[str] = []
        reasoning = 0
        finish: str | None = None
        try:
            with self._client(CHAT_TIMEOUT) as client, client.stream("POST", "/v1/chat/completions", json=body) as response:
                if response.status_code >= 400:
                    response.read()
                    raise _Refused(response.status_code, readable_error(response))
                if "text/event-stream" not in response.headers.get("content-type", ""):
                    # A server that ignores "stream" answers in one piece.
                    response.read()
                    data = response.json()
                    choice = (data.get("choices") or [{}])[0]
                    content = (choice.get("message") or {}).get("content") or ""
                    if on_text:
                        on_text(content, 0)
                    return Reply(content, choice.get("finish_reason"), fmt)
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    error = chunk.get("error")
                    if error:
                        raise _Refused(500, str(error.get("message", error) if isinstance(error, dict) else error))
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if delta.get("content"):
                            text.append(delta["content"])
                        # Thinking models send their reasoning apart (LM Studio, Ollama).
                        reasoning += len(delta.get("reasoning_content") or delta.get("reasoning") or "")
                        finish = choice.get("finish_reason") or finish
                    if on_text:
                        on_text("".join(text), reasoning)
        except httpx.TimeoutException as exc:
            raise LlmUnreachable(self.url, "no answer in time") from exc
        except httpx.HTTPError as exc:
            raise LlmUnreachable(self.url, type(exc).__name__) from exc
        return Reply("".join(text), finish, fmt)

    # Unloading -----------------------------------------------------------------------------------

    def unload(self) -> str:
        """Asks the server to take the model off the GPU. Returns what happened, to show."""
        if not self.model:
            return ""
        try:
            server = self.server()
            name = SERVER_NAMES[server]
            if server == "ollama":
                response = self._request("POST", "/api/generate", UNLOAD_TIMEOUT, json={"model": self.model, "keep_alive": 0})
                if response.status_code >= 400:
                    return f"Ollama couldn't unload {self.model}: {readable_error(response)}"
                return f"Unloaded {self.model} from Ollama."
            if server == "lmstudio" and self._lmstudio_api:
                return self._unload_lmstudio()
            if server == "lmstudio":
                return f"{self.model} stays loaded: this LM Studio is older than 0.4, which can't be asked to unload a model. Unload it in LM Studio, or update it."
            return f"{self.model} stays loaded: this {name} can't be asked to unload a model."
        except AppError as exc:
            return f"Couldn't ask the language model server to unload {self.model}: {exc.message}"

    def _unload_lmstudio(self) -> str:
        data = self._get_json("/api/v1/models")
        instances: list[str] = []
        for model in (data or {}).get("models") or []:
            if not isinstance(model, dict):
                continue
            for instance in model.get("loaded_instances") or []:
                instance_id = str((instance or {}).get("id") or "")
                # LLM_MODEL is the model's key or one of its instances' ids ("key:2" for a second copy).
                if instance_id and (model.get("key") == self.model or instance_id == self.model or instance_id.startswith(f"{self.model}:")):
                    instances.append(instance_id)
        if not instances:
            return f"{self.model} wasn't loaded in LM Studio any more."
        for instance_id in instances:
            response = self._request("POST", "/api/v1/models/unload", UNLOAD_TIMEOUT, json={"instance_id": instance_id})
            if response.status_code >= 400:
                return f"LM Studio couldn't unload {instance_id}: {readable_error(response)}"
        return f"Unloaded {self.model} from LM Studio."


class _Refused(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
