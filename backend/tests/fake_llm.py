"""A fake language model server with the OpenAI-compatible API, run in a thread on a free port. It
answers like LM Studio (its /api/v1 model list and unload; unknown paths get HTTP 200 with an error,
as LM Studio does), Ollama (/api/version, keep_alive 0 on /api/generate) or a plain OpenAI-compatible
server. Tests queue its answers in `replies`; each chat request takes the next one."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from tests.fake_comfy import free_port

Kind = Literal["lmstudio", "ollama", "openai"]


class FakeLlm:
    def __init__(self, kind: Kind = "lmstudio", models: tuple[str, ...] = ("qwen/qwen3-8b",)) -> None:
        self.kind = kind
        self.models = list(models)
        self.port = free_port()
        self.root = f"http://127.0.0.1:{self.port}"
        self.url = f"{self.root}/v1"
        # Answers to give, in order: text (streamed), or {"status": 500, "error": "..."}.
        self.replies: list[str | dict[str, Any]] = []
        self.finish_reason = "stop"
        # The chat requests received (their JSON bodies), and the unload requests.
        self.requests: list[dict[str, Any]] = []
        self.unloads: list[dict[str, Any]] = []
        # LM Studio: the models loaded now (a chat loads its model, as LM Studio's JIT loading does).
        self.loaded: set[str] = set()
        # response_format types this server refuses with HTTP 400.
        self.refuse_formats: set[str] = set()
        # Off: answers come in one piece even when streaming is asked for.
        self.stream = True
        # Set to hold chat answers until it's set (to look at what happens meanwhile).
        self.hold: threading.Event | None = None
        self.chatting = threading.Event()
        routes = [
            Route("/v1/models", self.list_models),
            Route("/v1/chat/completions", self.chat, methods=["POST"]),
        ]
        if kind == "ollama":
            routes += [Route("/api/version", self.version), Route("/api/generate", self.generate, methods=["POST"])]
        if kind == "lmstudio":
            routes += [
                Route("/api/v1/models", self.native_models),
                Route("/api/v1/models/unload", self.unload, methods=["POST"]),
                Route("/{path:path}", self.unexpected, methods=["GET", "POST"]),
            ]
        self.server = uvicorn.Server(uvicorn.Config(Starlette(routes=routes), host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> FakeLlm:
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            assert time.time() < deadline, "the fake language model server didn't start"
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        if self.hold:
            self.hold.set()
        self.server.should_exit = True
        self.thread.join(timeout=10)

    # OpenAI-compatible API -------------------------------------------------------------------------

    async def list_models(self, request: Request) -> Response:
        return JSONResponse({"object": "list", "data": [{"id": m, "object": "model", "owned_by": "me"} for m in self.models]})

    async def chat(self, request: Request) -> Response:
        body = await request.json()
        self.requests.append(body)
        self.chatting.set()
        fmt = (body.get("response_format") or {}).get("type")
        if fmt in self.refuse_formats:
            return JSONResponse({"error": {"message": f"response_format type '{fmt}' is not supported"}}, status_code=400)
        if self.hold:
            await asyncio.to_thread(self.hold.wait, 20)
        assert self.replies, "the fake language model server got a request it has no answer for"
        reply = self.replies.pop(0)
        # The request loads the model (LM Studio's JIT loading), even when generating then fails.
        self.loaded.add(body["model"])
        if isinstance(reply, dict):
            return JSONResponse({"error": {"message": reply["error"]}}, status_code=reply["status"])
        if not (body.get("stream") and self.stream):
            return JSONResponse(
                {
                    "object": "chat.completion",
                    "model": body["model"],
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": self.finish_reason}],
                }
            )

        async def chunks() -> AsyncIterator[str]:
            def event(delta: dict[str, Any], finish: str | None = None) -> str:
                chunk = {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                return f"data: {json.dumps(chunk)}\n\n"

            yield event({"role": "assistant", "reasoning_content": "Let me think about the scenes."})
            for start in range(0, len(reply), 40):
                yield event({"content": reply[start : start + 40]})
            yield event({}, self.finish_reason)
            yield "data: [DONE]\n\n"

        return StreamingResponse(chunks(), media_type="text/event-stream")

    # Ollama ----------------------------------------------------------------------------------------

    async def version(self, request: Request) -> Response:
        return JSONResponse({"version": "0.12.6"})

    async def generate(self, request: Request) -> Response:
        body = await request.json()
        self.unloads.append(body)
        return JSONResponse({"model": body["model"], "response": "", "done": True, "done_reason": "unload"})

    # LM Studio -------------------------------------------------------------------------------------

    async def native_models(self, request: Request) -> Response:
        models = [
            {"type": "llm", "key": m, "display_name": m, "loaded_instances": [{"id": m, "config": {"context_length": 4096}}] if m in self.loaded else []}
            for m in self.models
        ]
        return JSONResponse({"models": models})

    async def unload(self, request: Request) -> Response:
        body = await request.json()
        self.unloads.append(body)
        if body.get("instance_id") not in self.loaded:
            return JSONResponse({"error": f"No model instance with id {body.get('instance_id')}"}, status_code=404)
        self.loaded.discard(body["instance_id"])
        return JSONResponse({"instance_id": body["instance_id"]})

    async def unexpected(self, request: Request) -> Response:
        # What LM Studio does with a path it doesn't know.
        return JSONResponse({"error": f"Unexpected endpoint or method. ({request.method} {request.url.path})"})
