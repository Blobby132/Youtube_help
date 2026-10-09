"""Write scenes with AI and Rewrite prompt, against a fake language model server (LM Studio, Ollama
or a plain OpenAI-compatible one) and the fake ComfyUI: valid answers, an invalid answer then a
valid one, failures with the raw answers, edited fields kept, merges and splits held to the 2 to 5
second rule, and the GPU shared with ComfyUI (never both at once, ComfyUI freed first, the model
unloaded after)."""

from __future__ import annotations

import dataclasses
import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import REPO_ROOT, Settings, get_settings
from app.llm import service as service_module
from app.llm.writer import parse_json
from app.main import create_app
from tests.fake_comfy import FakeComfy
from tests.fake_llm import FakeLlm

MODEL = "qwen/qwen3-8b"
GUIDE = REPO_ROOT / "prompts" / "ltx_guide.md"
SCRIPT = "Every airplane window has a tiny hole in it. It keeps the window from fogging up. The hole lets air move between the panes."


def timed_words(text: str, start: float = 0.0, each: float = 0.3) -> list[dict[str, Any]]:
    return [{"text": w, "start": round(start + i * each, 4), "end": round(start + i * each + 0.28, 4)} for i, w in enumerate(text.split())]


WORDS = timed_words(SCRIPT)


def scene(scene_id: str, first: int, last: int, end: float | None = None, **fields: Any) -> dict[str, Any]:
    """A scene over words first..last (by index), as the frontend sends it."""
    words = WORDS[first : last + 1]
    return {
        "id": scene_id,
        "start": words[0]["start"] if first else 0.0,
        "end": end if end is not None else WORDS[last + 1]["start"] if last + 1 < len(WORDS) else 8.0,
        "words": words,
        "source": "ai",
        "description": "",
        "prompt": "",
        "searchText": "",
        "edited": [],
        **fields,
    }


# Three scenes of 2.7, 2.1 and 3.2 seconds, a sentence each.
SCENES = [scene("s-1", 0, 8), scene("s-2", 9, 15), scene("s-3", 16, 23)]


def entry(number: int, **overrides: Any) -> dict[str, Any]:
    return {
        "scene": number,
        "source": "ai",
        "description": f"Description {number}",
        "searchText": f"search {number}",
        "prompt": f"Close-up shot {number}, the camera stays still. Sound: a soft hum.",
        "mergeWithNext": False,
        "split": [],
        "why": "",
        **overrides,
    }


def answer(*entries: dict[str, Any]) -> str:
    return json.dumps({"scenes": list(entries)})


VALID = answer(entry(1, source="stock", searchText="airplane window"), entry(2), entry(3))


# Fixtures ----------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service_module, "FREE_WAIT_SECONDS", 0)


@pytest.fixture
def comfy(tmp_path: Path) -> Iterator[FakeComfy]:
    fake = FakeComfy(tmp_path / "unused.mp4").start()
    yield fake
    fake.stop()


@pytest.fixture
def llm() -> Iterator[FakeLlm]:
    fake = FakeLlm("lmstudio", (MODEL, "google/gemma-3-12b")).start()
    yield fake
    fake.stop()


def make_client(settings: Settings, llm: FakeLlm | None, comfy: FakeComfy, **changes: Any) -> Iterator[TestClient]:
    defaults = {"llm_url": llm.url if llm else "http://127.0.0.1:9/v1", "llm_model": MODEL, "comfyui_url": comfy.url, "ltx_guide": GUIDE}
    configured = dataclasses.replace(settings, **{**defaults, **changes})
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: configured
    with TestClient(app) as client:
        yield client


@pytest.fixture
def api(settings: Settings, llm: FakeLlm, comfy: FakeComfy) -> Iterator[TestClient]:
    yield from make_client(settings, llm, comfy)


def wait_job(api: TestClient, job: dict[str, Any], timeout: float = 15) -> dict[str, Any]:
    deadline = time.time() + timeout
    while job["status"] in ("queued", "running"):
        assert time.time() < deadline, f"job {job['kind']} didn't finish: {job}"
        time.sleep(0.02)
        job = api.get(f"/api/jobs/{job['id']}").json()
    return job


def write(api: TestClient, scenes: list[dict[str, Any]] = SCENES) -> dict[str, Any]:
    response = api.post("/api/llm/scenes", json={"script": SCRIPT, "scenes": scenes})
    assert response.status_code == 200, response.text
    return wait_job(api, response.json())


def messages(request: dict[str, Any]) -> list[dict[str, str]]:
    return request["messages"]


# Status ------------------------------------------------------------------------------------------


def test_status_finds_lm_studio_its_models_and_comfyui(api: TestClient, llm: FakeLlm) -> None:
    status = api.get("/api/llm/status").json()
    assert status["reachable"] is True
    assert status["url"] == llm.url
    assert (status["server"], status["serverName"], status["canUnload"]) == ("lmstudio", "LM Studio", True)
    assert status["models"] == [MODEL, "google/gemma-3-12b"]
    assert (status["model"], status["modelProblem"], status["modelWarning"]) == (MODEL, None, None)
    assert status["comfy"] == {"reachable": True, "running": 0, "pending": 0, "busy": None}
    assert (status["guide"], status["guideProblem"], status["running"]) == ("ltx_guide.md", None, False)


@pytest.mark.parametrize(("kind", "name", "can_unload"), [("ollama", "Ollama", True), ("openai", "OpenAI-compatible server", False)])
def test_status_tells_ollama_from_a_plain_server(settings: Settings, comfy: FakeComfy, kind: str, name: str, can_unload: bool) -> None:
    fake = FakeLlm(kind, ("qwen3:latest",)).start()  # type: ignore[arg-type]
    try:
        for api in make_client(settings, fake, comfy, llm_model="qwen3"):
            status = api.get("/api/llm/status").json()
            assert (status["serverName"], status["canUnload"]) == (name, can_unload)
            assert status["modelWarning"] is None  # Ollama's "qwen3:latest" is "qwen3"
    finally:
        fake.stop()


def test_status_without_a_model_or_a_server(settings: Settings, llm: FakeLlm, comfy: FakeComfy) -> None:
    for api in make_client(settings, llm, comfy, llm_model=None):
        status = api.get("/api/llm/status").json()
        assert status["modelProblem"] == f"Set LLM_MODEL in .env to the model to use ({MODEL}, google/gemma-3-12b), then restart the app."
        response = api.post("/api/llm/scenes", json={"script": SCRIPT, "scenes": SCENES})
        assert response.status_code == 400
        assert "Set LLM_MODEL in .env" in response.json()["detail"]
    for api in make_client(settings, llm, comfy, llm_model="llama-9000"):
        assert api.get("/api/llm/status").json()["modelWarning"] == (
            f"LM Studio doesn't list a model called “llama-9000”. It has: {MODEL}, google/gemma-3-12b. Check LLM_MODEL in .env."
        )
    for api in make_client(settings, None, comfy):
        status = api.get("/api/llm/status").json()
        assert status["reachable"] is False
        assert status["error"].startswith("The language model server isn't answering at http://127.0.0.1:9/v1")
        assert "set LLM_URL in .env" in status["error"]


# Writing scenes ----------------------------------------------------------------------------------


def test_valid_answer_fills_in_every_scene(api: TestClient, llm: FakeLlm, comfy: FakeComfy) -> None:
    llm.replies = [VALID]
    job = write(api)
    assert job["status"] == "done", job
    result = job["result"]
    assert result["scenes"] == [
        {"id": "s-1", "set": {"source": "stock", "description": "Description 1", "searchText": "airplane window", "prompt": entry(1)["prompt"]}, "ask": {}},
        {"id": "s-2", "set": {k: entry(2)[k] for k in ("source", "description", "searchText", "prompt")}, "ask": {}},
        {"id": "s-3", "set": {k: entry(3)[k] for k in ("source", "description", "searchText", "prompt")}, "ask": {}},
    ]
    assert (result["merges"], result["splits"], result["skipped"]) == ([], [], [])
    assert (result["model"], result["attempts"], result["requests"]) == (MODEL, 1, 1)

    # One streamed request, asking for JSON that follows the schema, with the guide (not its notes).
    [request] = llm.requests
    assert request["model"] == MODEL and request["stream"] is True
    fmt = request["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["schema"]["properties"]["scenes"]["minItems"] == 3
    system, user = messages(request)
    assert "6. **Careful with destruction words.**" in system["content"]
    assert "Everything outside these comment markers" not in system["content"]
    assert "Scene 2 · 0:02.70–0:04.80 (2.1 s)\nNarration: “It keeps the window from fogging up.”" in user["content"]

    # The GPU: ComfyUI was asked to unload its models first, and LM Studio unloaded the model after.
    assert comfy.freed == [{"unload_models": True, "free_memory": True}]
    assert llm.unloads == [{"instance_id": MODEL}] and llm.loaded == set()
    assert result["notes"] == ["Asked ComfyUI to unload its models first.", f"Unloaded {MODEL} from LM Studio."]


def test_invalid_answer_is_sent_back_once_then_the_valid_one_is_used(api: TestClient, llm: FakeLlm) -> None:
    broken = answer(entry(1), entry(2, prompt=""), entry(3, source="video"))
    llm.replies = ["<think>Three scenes.</think>\nHere you go:\n" + broken, "```json\n" + VALID + "\n```"]
    job = write(api)
    assert job["status"] == "done", job
    assert job["result"]["attempts"] == 2
    assert job["result"]["scenes"][1]["set"]["prompt"] == entry(2)["prompt"]
    # The second request has the first answer and what was wrong with it.
    retry = messages(llm.requests[1])
    assert retry[2] == {"role": "assistant", "content": llm.requests[1]["messages"][2]["content"]}
    assert broken in retry[2]["content"]
    assert retry[3]["role"] == "user"
    assert 'scene 2: "prompt" is empty' in retry[3]["content"]
    assert 'scene 3: "source" is "video", but it has to be "ai" or "stock"' in retry[3]["content"]
    assert "Answer again with the whole JSON object for scenes 1 to 3, fixed." in retry[3]["content"]


def test_two_unusable_answers_fail_with_the_raw_output(api: TestClient, llm: FakeLlm) -> None:
    first, second = "I can't help with that.", answer(entry(1), entry(2))
    llm.replies = [first, second]
    job = write(api)
    assert job["status"] == "error"
    assert job["error"] == "The language model's answer for scenes 1 to 3 couldn't be used, even after asking again: scene 3 is missing."
    assert job["errorData"] == {"raw": [first, second]}
    assert llm.unloads == [{"instance_id": MODEL}]  # unloaded even so


def test_an_answer_cut_short_says_the_context_is_too_small(api: TestClient, llm: FakeLlm) -> None:
    llm.finish_reason = "length"
    llm.replies = [VALID[:120], VALID[:120]]
    job = write(api)
    assert job["status"] == "error"
    assert "the answer stopped before it was finished" in job["error"]
    assert "give the model a longer context (LM Studio: Context Length when loading the model; Ollama: OLLAMA_CONTEXT_LENGTH)" in job["error"]


def test_a_server_error_is_shown_and_the_model_still_unloaded(api: TestClient, llm: FakeLlm) -> None:
    llm.replies = [{"status": 500, "error": "Model crashed while generating"}]
    job = write(api)
    assert job["status"] == "error"
    assert job["error"] == "The language model server refused the request (HTTP 500): Model crashed while generating"
    assert len(llm.requests) == 1
    assert llm.unloads == [{"instance_id": MODEL}]


def test_a_server_without_json_schema_gets_plain_json_mode(api: TestClient, llm: FakeLlm) -> None:
    llm.refuse_formats = {"json_schema"}
    llm.stream = False  # and one that answers in one piece
    llm.replies = [VALID, VALID]
    assert write(api)["status"] == "done"
    assert [r["response_format"]["type"] for r in llm.requests] == ["json_schema", "json_object"]
    # The next run starts with what worked.
    assert write(api)["status"] == "done"
    assert llm.requests[2]["response_format"] == {"type": "json_object"}


def test_edited_fields_are_kept_and_the_ai_text_comes_back_to_ask_about(api: TestClient, llm: FakeLlm) -> None:
    mine = scene("s-1", 0, 8, source="stock", description="A tiny hole in a plane window", searchText="plane window", edited=["source", "description", "searchText"])
    llm.replies = [answer(entry(1, source="ai", searchText="plane window"), entry(2), entry(3))]
    job = write(api, [mine, *SCENES[1:]])
    assert job["status"] == "done", job
    first = job["result"]["scenes"][0]
    # Only the prompt is filled in; the AI's other text is offered, not used (its search text is the same as yours).
    assert first["set"] == {"prompt": entry(1)["prompt"]}
    assert first["ask"] == {"source": "ai", "description": "Description 1"}
    # The model was told what you wrote.
    user = messages(llm.requests[0])[1]["content"]
    assert "Source, written by the user: “stock”" in user
    assert "Visual description, written by the user: “A tiny hole in a plane window”" in user


def test_merges_and_splits_follow_the_2_to_5_second_rule_and_cut_on_words(api: TestClient, llm: FakeLlm) -> None:
    words = timed_words("One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", each=0.5)
    scenes = []
    for scene_id, first, last in (("a", 0, 3), ("b", 4, 7), ("c", 8, 15)):
        part = words[first : last + 1]
        scenes.append({**SCENES[0], "id": scene_id, "start": part[0]["start"], "end": part[0]["start"] + 0.5 * len(part), "words": part})
    # a 0-2 s, b 2-4 s, c 4-8 s. Merging a and b makes 4 s (fine); splitting c before "thirteen" (6 s) makes 2 + 2 s.
    split = {"startsWith": "thirteen fourteen", **{k: v for k, v in entry(4).items() if k in ("source", "description", "searchText", "prompt")}}
    llm.replies = [answer(entry(1, mergeWithNext=True, why="One shot reads better."), entry(2), entry(3, split=[split], why="Two ideas."))]
    result = write(api, scenes)["result"]
    assert result["merges"] == [{"id": "a", "next": "b", "start": 0.0, "end": 4.0, "why": "One shot reads better.", "replacesEdits": []}]
    assert result["splits"] == [
        {"id": "c", "at": 6.0, "before": "thirteen fourteen fifteen sixteen", "second": {k: split[k] for k in ("source", "description", "searchText", "prompt")}, "why": "Two ideas."}
    ]
    assert result["skipped"] == []

    # A split leaving a part under 2 s, one before words that aren't there, and a merge over 5 s are left out, with why.
    scenes[2]["edited"] = []
    llm.replies = [
        answer(
            entry(1),
            entry(2, mergeWithNext=True),
            entry(3, split=[{**split, "startsWith": "sixteen"}]),
        ),
        answer(entry(1), entry(2), entry(3, split=[{**split, "startsWith": "twenty"}])),
    ]
    first = write(api, scenes)["result"]
    assert first["merges"] == [] and first["splits"] == []
    assert first["skipped"] == [
        "Scenes 2 and 3 weren't merged: together they'd be 6.0 s, and scenes are 2 to 5 seconds long.",
        "Scene 3 wasn't split before “sixteen”: the parts would be 3.5 s and 0.5 s, and scenes are 2 to 5 seconds long.",
    ]
    second = write(api, scenes)["result"]
    assert second["skipped"] == ["Scene 3 wasn't split: “twenty” isn't in its narration after the first word."]


def test_a_merge_says_which_of_your_text_it_would_replace(api: TestClient, llm: FakeLlm) -> None:
    scenes = [SCENES[0], {**SCENES[1], "description": "My window", "edited": ["description"]}, SCENES[2]]
    llm.replies = [answer(entry(1, mergeWithNext=True), entry(2), entry(3))]
    [merge] = write(api, scenes)["result"]["merges"]
    assert (merge["id"], merge["next"], merge["end"], merge["replacesEdits"]) == ("s-1", "s-2", 4.8, ["description"])


def test_long_videos_go_to_the_model_a_few_scenes_at_a_time(api: TestClient, llm: FakeLlm) -> None:
    words = timed_words(" ".join(f"word{i}" for i in range(24)), each=1.0)
    scenes = [{**SCENES[0], "id": f"s{i}", "start": i * 3.0, "end": i * 3.0 + 3, "words": words[i * 3 : i * 3 + 3]} for i in range(8)]
    llm.replies = [answer(*(entry(n) for n in range(1, 7))), answer(entry(7, mergeWithNext=True), entry(8))]
    job = write(api, scenes)
    assert job["status"] == "done", job
    assert job["result"]["requests"] == 2 and len(job["result"]["scenes"]) == 8
    second = messages(llm.requests[1])[1]["content"]
    assert "Plan scenes 7 to 8 of 8:" in second
    assert "Scenes already planned before these (keep them consistent):\nScene 1: Description 1" in second
    assert "Scene 6: Description 6" in second
    assert llm.requests[1]["response_format"]["json_schema"]["schema"]["properties"]["scenes"]["maxItems"] == 2
    # Merging 7 and 8 would make 6 s.
    assert job["result"]["skipped"] == ["Scenes 7 and 8 weren't merged: together they'd be 6.0 s, and scenes are 2 to 5 seconds long."]
    assert len(llm.unloads) == 1  # once, after the whole run


# Sharing the GPU with ComfyUI --------------------------------------------------------------------


def test_nothing_runs_while_comfyui_is_generating(api: TestClient, llm: FakeLlm, comfy: FakeComfy) -> None:
    # Something in ComfyUI's queue (from the app or from ComfyUI itself).
    httpx.post(f"{comfy.url}/prompt", json={"prompt": {}, "client_id": "someone"})
    comfy.start_next(notify=False)
    httpx.post(f"{comfy.url}/prompt", json={"prompt": {}, "client_id": "someone"})
    busy = (
        "ComfyUI is generating (2 jobs in its queue), so the language model waits until it's done. The language model and "
        "ComfyUI share the GPU, and running both at once can run out of video memory or slow both to a crawl."
    )
    assert api.get("/api/llm/status").json()["comfy"] == {"reachable": True, "running": 1, "pending": 1, "busy": busy}
    for path, body in (
        ("/api/llm/scenes", {"script": SCRIPT, "scenes": SCENES}),
        ("/api/llm/prompt", {"script": SCRIPT, "scene": {"number": 1, "start": 0, "end": 2.7}}),
    ):
        response = api.post(path, json=body)
        assert response.status_code == 409
        assert response.json()["detail"] == busy
    assert llm.requests == [] and comfy.freed == [] and llm.unloads == []

    # Once ComfyUI's queue is empty, it runs.
    comfy.pending.clear()
    comfy.running = None
    llm.replies = [VALID]
    assert write(api)["status"] == "done"


def test_a_closed_comfyui_holds_no_gpu_memory(settings: Settings, llm: FakeLlm, comfy: FakeComfy) -> None:
    comfy.stop()
    for api in make_client(settings, llm, comfy):
        assert api.get("/api/llm/status").json()["comfy"] == {"reachable": False, "running": 0, "pending": 0, "busy": None}
        llm.replies = [VALID]
        job = write(api)
        assert job["status"] == "done"
        assert job["result"]["notes"] == [f"Unloaded {MODEL} from LM Studio."]


def test_an_older_comfyui_that_cant_free_memory_is_mentioned(api: TestClient, llm: FakeLlm, comfy: FakeComfy) -> None:
    comfy.can_free = False
    llm.replies = [VALID]
    notes = write(api)["result"]["notes"]
    assert notes[0] == "This ComfyUI can't be asked to unload its models (it's older than 2024), so they may still be in GPU memory."


def test_comfyui_waits_while_the_language_model_writes(api: TestClient, llm: FakeLlm, comfy: FakeComfy) -> None:
    llm.hold = threading.Event()
    llm.replies = [VALID]
    started = api.post("/api/llm/scenes", json={"script": SCRIPT, "scenes": SCENES}).json()
    assert llm.chatting.wait(10)
    busy = (
        "The language model is writing 3 scenes, so ComfyUI waits until it's done. The language model and ComfyUI share "
        "the GPU, and running both at once can run out of video memory or slow both to a crawl."
    )
    assert api.get("/api/comfy/status").json()["llmBusy"] == busy
    assert api.get("/api/llm/status").json()["running"] is True
    response = api.post("/api/comfy/shots", json={"prompt": "A fox in the snow", "duration": 3})
    assert (response.status_code, response.json()["detail"]) == (409, busy)
    assert comfy.submitted == {}

    llm.hold.set()
    assert wait_job(api, started)["status"] == "done"
    assert api.get("/api/comfy/status").json()["llmBusy"] is None
    assert api.post("/api/comfy/shots", json={"prompt": "A fox in the snow", "duration": 3}).status_code == 200


# Rewrite prompt ----------------------------------------------------------------------------------


def test_rewrite_prompt_with_ollama(settings: Settings, comfy: FakeComfy) -> None:
    fake = FakeLlm("ollama", ("qwen3:8b",)).start()
    try:
        for api in make_client(settings, fake, comfy, llm_model="qwen3:8b"):
            fake.replies = ['{"prompt": ""}', '{"prompt": "Wide shot of a jet wing above the clouds. Sound: wind."}']
            body = {
                "script": SCRIPT,
                "scene": {
                    "number": 2,
                    "start": 2.7,
                    "end": 4.8,
                    "narration": "It keeps the window from fogging up.",
                    "description": "Frost on a window",
                    "prompt": "window frost",
                    "before": "An airplane window",
                },
            }
            job = wait_job(api, api.post("/api/llm/prompt", json=body).json())
            assert job["status"] == "done", job
            result = job["result"]
            assert (result["prompt"], result["attempts"], result["model"]) == ("Wide shot of a jet wing above the clouds. Sound: wind.", 2, "qwen3:8b")
            user = messages(fake.requests[0])[1]["content"]
            assert "Visual description: “Frost on a window”\nCurrent prompt: “window frost”\nThe scene before shows: An airplane window" in user
            assert fake.requests[0]["response_format"]["json_schema"]["schema"]["required"] == ["prompt"]
            assert 'the answer needs a "prompt" with the text' in messages(fake.requests[1])[3]["content"]
            # Ollama unloads with keep_alive 0 on its own API.
            assert fake.unloads == [{"model": "qwen3:8b", "keep_alive": 0}]
            assert result["notes"][-1] == "Unloaded qwen3:8b from Ollama."
    finally:
        fake.stop()


def test_a_plain_server_keeps_its_model_loaded_and_says_so(settings: Settings, comfy: FakeComfy) -> None:
    fake = FakeLlm("openai", (MODEL,)).start()
    try:
        for api in make_client(settings, fake, comfy):
            fake.replies = ['{"prompt": "Close-up of frost. Sound: a hiss."}']
            job = wait_job(api, api.post("/api/llm/prompt", json={"script": SCRIPT, "scene": {"number": 1, "start": 0, "end": 2.7}}).json())
            assert job["result"]["notes"][-1] == f"{MODEL} stays loaded: this OpenAI-compatible server can't be asked to unload a model."
    finally:
        fake.stop()


# The guide and reading answers -------------------------------------------------------------------


def test_a_missing_guide_is_explained(settings: Settings, llm: FakeLlm, comfy: FakeComfy, tmp_path: Path) -> None:
    for api in make_client(settings, llm, comfy, ltx_guide=tmp_path / "ltx_guide.md"):
        assert "The prompt guide ltx_guide.md was not found" in api.get("/api/llm/status").json()["guideProblem"]
        response = api.post("/api/llm/scenes", json={"script": SCRIPT, "scenes": SCENES})
        assert response.status_code == 500
        assert "restore it with `git checkout prompts/ltx_guide.md`" in response.json()["detail"]


def test_the_guide_is_read_again_at_every_run(settings: Settings, llm: FakeLlm, comfy: FakeComfy, tmp_path: Path) -> None:
    guide = tmp_path / "guide.md"
    guide.write_text("<!-- my notes -->\nAlways mention the weather.", encoding="utf-8")
    for api in make_client(settings, llm, comfy, ltx_guide=guide):
        llm.replies = [VALID, VALID]
        write(api)
        guide.write_text("Always mention the time of day.", encoding="utf-8")
        write(api)
    first, second = (messages(r)[0]["content"] for r in llm.requests)
    assert first.endswith("Always mention the weather.") and "my notes" not in first
    assert second.endswith("Always mention the time of day.")


@pytest.mark.parametrize(
    "text",
    [
        '{"prompt": "x"}',
        '<think>\nHmm {"no": 1}\n</think>\n{"prompt": "x"}',
        'Sure! Here it is:\n```json\n{"prompt": "x"}\n```\nEnjoy.',
        'The prompt: {"prompt": "x"} as asked.',
    ],
)
def test_json_is_found_in_what_models_wrap_around_it(text: str) -> None:
    assert parse_json(text) == {"prompt": "x"}


@pytest.mark.parametrize(("text", "reason"), [("", "the answer is empty"), ("No JSON here.", "no JSON object"), ('{"prompt": "x"', "no JSON object")])
def test_answers_without_json_say_why(text: str, reason: str) -> None:
    with pytest.raises(ValueError, match=reason):
        parse_json(text)


def test_progress_follows_the_streamed_answer(llm: FakeLlm) -> None:
    from app.llm.client import LlmClient
    from app.llm.writer import write_scenes

    llm.replies = [VALID]
    seen: list[tuple[float, str]] = []
    result = write_scenes(LlmClient(llm.url, MODEL), "Rules.", SCRIPT, SCENES, lambda fraction, message: seen.append((fraction, message)))
    assert result["attempts"] == 1
    texts = [message for _, message in seen]
    assert texts[:2] == ["Reading scenes 1 to 3 of 3…", "Thinking about scenes 1 to 3…"]  # its reasoning arrives first
    assert {"Writing scene 1 of 3…", "Writing scene 2 of 3…", "Writing scene 3 of 3…"} <= set(texts)
    fractions = [fraction for fraction, _ in seen]
    assert fractions == sorted(fractions) and fractions[-1] < 1
