"""Generate shot: the workflow mapping (on the real comfy/ltx_t2v_api.json) and the jobs, against
a fake ComfyUI server (submit, progress, history, download, cancel, unreachable)."""

from __future__ import annotations

import copy
import dataclasses
import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.comfy import service as service_module
from app.comfy import workflow as wf
from app.comfy.client import ComfyClient, readable_refusal
from app.comfy.router import get_service
from app.comfy.service import GenerationService, shot_name
from app.core.config import REPO_ROOT, Settings, get_settings
from app.core.errors import AppError
from app.main import create_app
from tests.fake_comfy import FakeComfy, free_port
from tests.media_files import make_video, needs_ffmpeg

WORKFLOW = REPO_ROOT / "comfy" / "ltx_t2v_api.json"
PROMPT = "A red fox trots through deep snow at dusk, slow tracking shot, cinematic"


def wait_until(check: Callable[[], bool], timeout: float = 10, what: str = "condition") -> None:
    deadline = time.time() + timeout
    while not check():
        assert time.time() < deadline, f"timed out waiting for {what}"
        time.sleep(0.02)


# The workflow mapping ----------------------------------------------------------------------------


def real_workflow() -> dict:
    return json.loads(WORKFLOW.read_text(encoding="utf-8"))


def test_the_real_workflow_has_every_input() -> None:
    workflow = wf.load(WORKFLOW)
    assert wf.check(workflow) == []
    found = {key: wf.find(workflow, target) for key, target in wf.INPUTS.items()}
    assert found == {
        "prompt": "405:376",
        "seed": "405:339",  # the first pass's noise, not the refine pass's (405:338)
        "megapixels": "409",
        "aspect_ratio": "409",
        "duration": "405:362",
        "fps": "405:361",
    }
    assert wf.output_node(workflow) == "75"


def test_apply_fills_in_the_shot_and_leaves_the_rest() -> None:
    workflow = wf.load(WORKFLOW)
    filled = wf.apply(workflow, prompt=PROMPT, seed=12345, megapixels=0.8, duration=5)
    assert filled["405:376"]["inputs"]["value"] == PROMPT
    assert filled["405:339"]["inputs"]["noise_seed"] == 12345
    assert filled["405:338"]["inputs"]["noise_seed"] == 42  # refine pass keeps the workflow's seed
    assert filled["409"]["inputs"] == {"aspect_ratio": "9:16 (Portrait Widescreen)", "megapixels": 0.8, "multiple": 32}
    assert filled["405:362"]["inputs"]["value"] == 5
    assert filled["405:361"]["inputs"]["value"] == 24
    # Everything else is untouched, and the original isn't changed.
    for node_id in set(workflow) - {"405:376", "405:339", "409", "405:362", "405:361"}:
        assert filled[node_id] == workflow[node_id]
    assert workflow["405:376"]["inputs"]["value"] != PROMPT


@pytest.mark.parametrize(
    ("change", "missing"),
    [
        (lambda w: w.pop("405:362"), "Duration (seconds) (the “value” input of a PrimitiveInt node titled “Duration”) is missing"),
        (lambda w: w["405:376"]["_meta"].update(title="Text"), "Prompt text (the “value” input of a PrimitiveStringMultiline node titled “Prompt”) is missing"),
        (lambda w: w.pop("409"), "Resolution (megapixels) (the “megapixels” input of a ResolutionSelector node) is missing"),
        (lambda w: w.pop("75"), "Video output (the “filename_prefix” input of a SaveVideo node) is missing"),
        (lambda w: w["405:361"]["inputs"].update(value=["405:362", 0]), "Frame rate (the “value” input of a PrimitiveInt node titled “Frame Rate”) is connected to another node"),
    ],
)
def test_a_changed_workflow_names_what_is_missing(tmp_path: Path, change, missing: str) -> None:
    workflow = real_workflow()
    change(workflow)
    path = tmp_path / "ltx_t2v_api.json"
    path.write_text(json.dumps(workflow))
    with pytest.raises(wf.WorkflowError) as error:
        wf.load(path)
    assert missing in error.value.message
    assert error.value.message.startswith("ltx_t2v_api.json can't be used: ")


def test_two_first_pass_samplers_make_the_seed_ambiguous(tmp_path: Path) -> None:
    workflow = real_workflow()
    workflow["405:368"]["inputs"]["latent_image"] = ["405:377", 0]  # both samplers start from the empty latent
    path = tmp_path / "w.json"
    path.write_text(json.dumps(workflow))
    with pytest.raises(wf.WorkflowError, match="Seed .* is missing"):
        wf.load(path)


def test_a_non_api_export_or_missing_file_is_explained(tmp_path: Path) -> None:
    ui_export = tmp_path / "ui.json"
    ui_export.write_text(json.dumps({"nodes": [], "links": [], "version": 0.4}))
    with pytest.raises(wf.WorkflowError, match=r"isn't an API-format workflow. In ComfyUI use Workflow → Export \(API\)"):
        wf.load(ui_export)
    with pytest.raises(wf.WorkflowError, match="was not found"):
        wf.load(tmp_path / "nope.json")


def test_shot_names_and_refusals() -> None:
    assert shot_name("A red fox", 1, 1) == "A red fox"
    assert shot_name(PROMPT, 2, 3) == "A red fox trots through deep snow at dusk, slow… (2/3)"
    refusal = {
        "error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation"},
        "node_errors": {"405:384": {"class_type": "UNETLoader", "errors": [{"message": "Value not in list", "details": "unet_name: 'ltx.safetensors' not in []"}]}},
    }
    assert readable_refusal(refusal) == "Prompt outputs failed validation; UNETLoader 405:384: unet_name: 'ltx.safetensors' not in []"


def test_progress_follows_the_two_sampling_passes() -> None:
    from app.comfy.service import Progress

    progress = Progress({n: node["class_type"] for n, node in wf.load(WORKFLOW).items()})
    progress.cached(["405:387", "405:384"])
    progress.executing("405:344")
    progress.step = (4, 8)
    progress.executing("405:344")  # announced again: still the same pass
    progress.step = (4, 8)
    assert progress.message() == "Generating, pass 1 of 2 (step 4 of 8)…"
    first = progress.fraction()
    progress.executing("405:368")
    progress.step = (1, 3)
    assert progress.message() == "Generating, pass 2 of 2 (step 1 of 3)…"
    progress.executing("405:374")
    assert progress.message() == "Decoding the video…"
    assert 0 < first < progress.fraction() <= 0.95


# Jobs against a fake ComfyUI ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """What LTX-2.5 makes at Draft quality: 480x864, 24 fps, with sound."""
    return make_video(tmp_path_factory.mktemp("comfy") / "LTX_2.5_t2v_00001_.mp4", 480, 864, seconds=1.0, audio=True)


@pytest.fixture
def comfy(video: Path) -> Iterator[FakeComfy]:
    fake = FakeComfy(video).start()
    yield fake
    fake.stop()


@pytest.fixture
def comfy_settings(settings: Settings, comfy: FakeComfy) -> Settings:
    return dataclasses.replace(settings, comfyui_url=comfy.url, comfy_workflow=WORKFLOW)


@pytest.fixture
def make_service(comfy_settings: Settings) -> Iterator[Callable[..., GenerationService]]:
    made: list[GenerationService] = []

    def build(settings: Settings | None = None) -> GenerationService:
        service = GenerationService(settings or comfy_settings, poll_seconds=0.05)
        made.append(service)
        return service

    yield build
    for service in made:
        service.stop()


@pytest.fixture
def service(make_service) -> GenerationService:
    return make_service()


@pytest.fixture
def client(comfy_settings: Settings, service: GenerationService) -> Iterator[TestClient]:
    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: comfy_settings
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client


def shots(client: TestClient, **body) -> list[dict]:
    response = client.post("/api/comfy/shots", json={"prompt": PROMPT, **body})
    assert response.status_code == 200, response.text
    return response.json()["jobs"]


def job(client: TestClient, job_id: str) -> dict:
    return next(j for j in client.get("/api/comfy/shots").json()["jobs"] if j["id"] == job_id)


def test_status_reports_comfyui_and_the_workflow(client: TestClient, comfy: FakeComfy) -> None:
    body = client.get("/api/comfy/status").json()
    assert body == {
        "reachable": True,
        "url": comfy.url,
        "version": "0.9.0-fake",
        "device": "cuda:0 Fake GPU",
        "error": None,
        "workflow": "ltx_t2v_api.json",
        "workflowProblem": None,
    }


def test_unreachable_comfyui_explains_how_to_fix_it(make_service, comfy_settings: Settings) -> None:
    closed = dataclasses.replace(comfy_settings, comfyui_url=f"http://127.0.0.1:{free_port()}")
    service = make_service(closed)
    status = service.status()
    assert status["reachable"] is False
    assert "Open ComfyUI Desktop" in status["error"] and closed.comfyui_url in status["error"]

    app = create_app(warm=False)
    app.dependency_overrides[get_settings] = lambda: closed
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        response = client.post("/api/comfy/shots", json={"prompt": PROMPT})
    assert response.status_code == 503
    assert "ComfyUI isn't answering" in response.json()["detail"]
    assert service.list() == []


def test_variations_get_their_own_seeds_and_queue_positions(client: TestClient, comfy: FakeComfy) -> None:
    jobs = shots(client, duration=4, quality="final", variations=3)
    assert [j["variation"] for j in jobs] == [1, 2, 3]
    assert len({j["seed"] for j in jobs}) == 3
    assert all(j["quality"] == "final" and j["megapixels"] == 0.8 and j["duration"] == 4 and j["fps"] == 24 for j in jobs)

    # Each was sent to ComfyUI with its own seed and the shot's settings.
    sent = [comfy.submitted[j["promptId"]]["prompt"] for j in jobs]
    assert [s["405:339"]["inputs"]["noise_seed"] for s in sent] == [j["seed"] for j in jobs]
    assert all(s["405:376"]["inputs"]["value"] == PROMPT and s["409"]["inputs"]["megapixels"] == 0.8 for s in sent)
    assert all(s["405:362"]["inputs"]["value"] == 4 for s in sent)

    comfy.start_next()
    wait_until(lambda: job(client, jobs[0]["id"])["status"] == "running", what="the first shot to run")
    wait_until(lambda: job(client, jobs[2]["id"])["queuePosition"] == 2, what="queue positions")
    second = job(client, jobs[1]["id"])
    assert (second["status"], second["queuePosition"], second["message"]) == ("queued", 1, "Waiting in ComfyUI's queue (1 ahead)")


@needs_ffmpeg
def test_a_finished_shot_lands_in_the_library(client: TestClient, comfy: FakeComfy, service: GenerationService) -> None:
    [queued] = shots(client, duration=3, quality="draft")
    prompt_id = comfy.start_next()

    # Live progress from the websocket: the first of two sampling passes.
    comfy.progress(prompt_id, "405:344", 3, 8)
    wait_until(lambda: "pass 1 of 2 (step 3 of 8)" in job(client, queued["id"])["message"], what="progress")
    running = job(client, queued["id"])
    assert running["status"] == "running" and 0 < running["progress"] < 0.95
    assert running["message"] == "Generating, pass 1 of 2 (step 3 of 8)…"

    comfy.finish(prompt_id)
    wait_until(lambda: job(client, queued["id"])["status"] == "done", what="the shot to be saved")
    done = job(client, queued["id"])
    [item] = client.get("/api/library").json()
    assert done["itemId"] == item["id"] and done["progress"] == 1.0
    assert item["source"] == "ai" and item["aiGenerated"] is True
    assert item["hasAudio"] is True  # LTX's sound is kept
    assert (item["width"], item["height"], item["lowRes"]) == (480, 864, True)
    assert item["name"] == "A red fox trots through deep snow at dusk, slow…"
    assert item["generation"] == {
        "prompt": PROMPT,
        "seed": queued["seed"],
        "quality": "draft",
        "megapixels": 0.4,
        "resolution": "480x864",
        "duration": 3,
        "fps": 24,
        "workflow": "ltx_t2v_api.json",
        "comfyPromptId": prompt_id,
        "comfyFile": "LTX_2.5_t2v_00001_.mp4",
        "basedOn": None,
        "generatedAt": item["generation"]["generatedAt"],
    }


def test_a_failed_shot_shows_comfyuis_reason(client: TestClient, comfy: FakeComfy) -> None:
    [queued] = shots(client)
    prompt_id = comfy.start_next()
    comfy.finish(prompt_id, error="CUDA out of memory. Tried to allocate 2.00 GiB")
    wait_until(lambda: job(client, queued["id"])["status"] == "error", what="the error")
    assert job(client, queued["id"])["error"] == "ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory. Tried to allocate 2.00 GiB"
    assert client.get("/api/library").json() == []


def test_cancel_a_waiting_shot(client: TestClient, comfy: FakeComfy) -> None:
    first, second = shots(client, variations=2)
    comfy.start_next()
    cancelled = client.post(f"/api/comfy/shots/{second['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert comfy.deleted == [second["promptId"]]
    assert comfy.interrupted == []  # the running one wasn't touched


def test_cancel_a_running_shot(client: TestClient, comfy: FakeComfy) -> None:
    [queued] = shots(client)
    comfy.start_next()
    wait_until(lambda: job(client, queued["id"])["status"] == "running", what="the shot to run")
    assert client.post(f"/api/comfy/shots/{queued['id']}/cancel").json()["message"] == "Cancelling…"
    assert comfy.interrupted == [queued["promptId"]]
    wait_until(lambda: job(client, queued["id"])["status"] == "cancelled", what="the cancel")
    assert client.get("/api/library").json() == []


def test_comfyui_refusing_the_workflow_says_why(client: TestClient, comfy: FakeComfy) -> None:
    comfy.refusal = {
        "error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation"},
        "node_errors": {"405:384": {"class_type": "UNETLoader", "errors": [{"message": "Value not in list", "details": "unet_name: 'ltx-2.5-22b.safetensors' not in []"}]}},
    }
    response = client.post("/api/comfy/shots", json={"prompt": PROMPT})
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "ComfyUI refused the workflow: Prompt outputs failed validation; "
        "UNETLoader 405:384: unet_name: 'ltx-2.5-22b.safetensors' not in []"
    )


def test_a_shot_comfyui_forgot_becomes_an_error(client: TestClient, comfy: FakeComfy, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service_module, "LOST_AFTER_SECONDS", 0.2)
    [queued] = shots(client)
    comfy.forget(queued["promptId"])
    wait_until(lambda: job(client, queued["id"])["status"] == "error", what="the lost shot")
    assert "Was ComfyUI restarted?" in job(client, queued["id"])["error"]


@needs_ffmpeg
def test_jobs_survive_a_restart_and_keep_going(make_service, comfy: FakeComfy, comfy_settings: Settings) -> None:
    before = make_service()
    [queued] = before.generate(PROMPT, 3, "draft")
    before.stop()

    # The backend restarts: the new service reads the jobs back and follows them.
    after = make_service()
    assert [j["id"] for j in after.list()] == [queued["id"]]
    assert after.client_id == before.client_id  # so ComfyUI's progress messages still arrive
    after.resume()
    comfy.finish(comfy.start_next())
    wait_until(lambda: after.list()[0]["status"] == "done", what="the resumed shot")
    assert after.list()[0]["itemId"]


def test_final_quality_reuses_the_seed(client: TestClient, comfy: FakeComfy) -> None:
    [again] = shots(client, quality="final", seed=777, basedOn="m-draft")
    assert (again["seed"], again["quality"], again["basedOn"]) == (777, "final", "m-draft")
    assert comfy.submitted[again["promptId"]]["prompt"]["405:339"]["inputs"]["noise_seed"] == 777
    # A seed only applies to a single variation.
    assert len({j["seed"] for j in shots(client, variations=2, seed=777)} - {777}) == 2


def test_shot_settings_are_checked(client: TestClient) -> None:
    for body in ({"duration": 1}, {"duration": 6}, {"variations": 5}, {"quality": "ultra"}, {"prompt": ""}):
        assert client.post("/api/comfy/shots", json={"prompt": PROMPT, **body}).status_code == 422
    assert client.post("/api/comfy/shots", json={"prompt": "   "}).status_code == 400


def test_finished_shots_can_be_cleared(client: TestClient, comfy: FakeComfy) -> None:
    first, second = shots(client, variations=2)
    assert client.delete(f"/api/comfy/shots/{first['id']}").status_code == 409  # still active
    client.post(f"/api/comfy/shots/{first['id']}/cancel")
    client.post(f"/api/comfy/shots/{second['id']}/cancel")
    assert client.delete(f"/api/comfy/shots/{first['id']}").json() == {"deleted": first["id"]}
    assert [j["id"] for j in client.post("/api/comfy/shots/clear").json()["jobs"]] == []


def test_the_workflow_problem_shows_in_the_status(make_service, comfy_settings: Settings, tmp_path: Path) -> None:
    broken = copy.deepcopy(real_workflow())
    broken.pop("405:362")
    path = tmp_path / "ltx_t2v_api.json"
    path.write_text(json.dumps(broken))
    service = make_service(dataclasses.replace(comfy_settings, comfy_workflow=path))
    assert "Duration (seconds)" in service.status()["workflowProblem"]
    with pytest.raises(wf.WorkflowError, match="Duration"):
        service.generate(PROMPT, 3, "draft")


def test_client_lists_queue_in_order(comfy: FakeComfy) -> None:
    client = ComfyClient(comfy.url)
    ids = [client.submit({"1": {"class_type": "X", "inputs": {}}}, "c") for _ in range(3)]
    comfy.start_next(notify=False)
    assert client.queue() == ([ids[0]], ids[1:])


# Scene previews (the Scenes tab) -----------------------------------------------------------------

SCENE = {"projectId": "p-scenes", "sceneId": "s-three"}


def previews(client: TestClient, count: int = 2, **body) -> list[dict]:
    return shots(client, duration=3, quality="draft", variations=count, scene=SCENE, **body)


@needs_ffmpeg
def test_scene_previews_are_shots_saved_with_their_scene(client: TestClient, comfy: FakeComfy, make_service) -> None:
    first, second = previews(client)
    assert first["scene"] == second["scene"] == SCENE
    assert first["seed"] != second["seed"]
    sent = [comfy.submitted[j["promptId"]]["prompt"] for j in (first, second)]
    assert [s["405:339"]["inputs"]["noise_seed"] for s in sent] == [first["seed"], second["seed"]]
    assert all(s["409"]["inputs"]["megapixels"] == 0.4 and s["405:362"]["inputs"]["value"] == 3 for s in sent)

    # The scene is kept with the job, so a restarted backend still knows it.
    assert make_service().list()[0]["scene"] == SCENE

    for queued in (first, second):
        comfy.finish(comfy.start_next())
        wait_until(lambda: job(client, queued["id"])["status"] == "done", what="the preview to be saved")
    items = {item["id"]: item for item in client.get("/api/library").json()}
    for queued in (first, second):
        item = items[job(client, queued["id"])["itemId"]]
        assert item["source"] == "ai" and item["aiGenerated"] is True
        generation = item["generation"]
        assert (generation["prompt"], generation["seed"], generation["quality"]) == (PROMPT, queued["seed"], "draft")
        assert (generation["type"], generation["projectId"], generation["sceneId"]) == ("preview", "p-scenes", "s-three")
        assert generation["shotId"] == queued["id"]


@needs_ffmpeg
def test_retry_reruns_only_the_failed_preview(client: TestClient, comfy: FakeComfy) -> None:
    failed, ok = previews(client)
    comfy.finish(comfy.start_next(), error="CUDA out of memory. Tried to allocate 2.00 GiB")
    wait_until(lambda: job(client, failed["id"])["status"] == "error", what="the failure")
    assert job(client, failed["id"])["error"].endswith("CUDA out of memory. Tried to allocate 2.00 GiB")
    comfy.finish(comfy.start_next())
    wait_until(lambda: job(client, ok["id"])["status"] == "done", what="the other preview")
    done = job(client, ok["id"])
    submitted = len(comfy.submitted)

    # Retry: the failed preview again, with its own seed, prompt and length. Nothing else is sent.
    [retry] = previews(client, count=1, seed=failed["seed"])
    assert len(comfy.submitted) == submitted + 1
    assert (retry["seed"], retry["prompt"], retry["duration"], retry["scene"]) == (failed["seed"], PROMPT, 3, SCENE)
    assert comfy.submitted[retry["promptId"]]["prompt"]["405:339"]["inputs"]["noise_seed"] == failed["seed"]
    assert client.delete(f"/api/comfy/shots/{failed['id']}").status_code == 200
    assert job(client, ok["id"]) == done  # the preview that worked is left alone

    comfy.finish(comfy.start_next())
    wait_until(lambda: job(client, retry["id"])["status"] == "done", what="the retried preview")
    seeds = sorted(item["generation"]["seed"] for item in client.get("/api/library").json())
    assert seeds == sorted([failed["seed"], ok["seed"]])
    assert failed["id"] not in [j["id"] for j in client.get("/api/comfy/shots").json()["jobs"]]


def test_clearing_finished_shots_keeps_scene_previews(client: TestClient) -> None:
    [shot] = shots(client)
    [preview] = previews(client, count=1)
    for queued in (shot, preview):
        client.post(f"/api/comfy/shots/{queued['id']}/cancel")
    remaining = client.post("/api/comfy/shots/clear").json()["jobs"]
    assert [j["id"] for j in remaining] == [preview["id"]]


def test_a_scene_preview_needs_its_project_and_scene(client: TestClient, service: GenerationService) -> None:
    for scene in ({"projectId": "", "sceneId": "s-1"}, {"projectId": "p-1"}):
        assert client.post("/api/comfy/shots", json={"prompt": PROMPT, "scene": scene}).status_code == 422
    with pytest.raises(AppError, match="needs its project and scene"):
        service.generate(PROMPT, 3, "draft", scene={"projectId": "p-1", "sceneId": " "})
    assert service.list() == []
