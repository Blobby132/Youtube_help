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


# Scene previews and finals: the workflow split in two ------------------------------------------

FIRST_PASS = {"405:344", "405:339", "405:352", "405:388", "405:404", "405:377", "405:356", "405:366", "405:353", "405:355", "405:378", "405:360", "405:372", "405:362", "409"}
REFINE_PASS = {"405:348", "405:371", "405:340", "405:368", "405:338", "405:341", "405:391", "405:395", "405:369"}


def links(node: dict) -> dict:
    return {name: value for name, value in node["inputs"].items() if wf.is_link(value)}


def test_the_real_workflow_has_two_passes_to_split() -> None:
    passes = wf.find_passes(wf.load(WORKFLOW))
    assert passes == wf.Passes(first="405:344", first_latents="405:367", refine="405:368", refine_latents="405:369", prompt_encoder="405:364")
    assert wf.finals_problem(wf.load(WORKFLOW)) is None
    assert wf.refine_seed(wf.load(WORKFLOW)) == 42


def test_a_preview_is_the_first_pass_with_its_latents_saved() -> None:
    full = wf.apply(wf.load(WORKFLOW), prompt=PROMPT, seed=12345, megapixels=0.8, duration=3)
    preview, added = wf.preview_workflow(full, "latents/shorts_g-1")
    assert added == {"videoLatent": "410", "audioLatent": "411", "promptText": "412"}
    # No upscale or refine pass; the workflow's own decoders and Save Video show the first pass.
    assert not REFINE_PASS & set(preview)
    assert preview["405:374"]["inputs"]["samples"] == ["405:367", 0]
    assert preview["405:358"]["inputs"]["samples"] == ["405:367", 1]
    assert preview["75"] == full["75"]
    # The first pass itself is the full workflow's, node for node, at the shot's size and seed.
    for node_id in FIRST_PASS:
        assert preview[node_id] == full[node_id]
    assert preview["409"]["inputs"]["megapixels"] == 0.8 and preview["405:339"]["inputs"]["noise_seed"] == 12345
    # Its video and audio latents are saved, and the text the prompt became is shown.
    assert preview["410"] == {"inputs": {"samples": ["405:367", 0], "filename_prefix": "latents/shorts_g-1_video"}, "class_type": "SaveLatent", "_meta": {"title": "Save the preview's video latent (Shorts Creator)"}}
    assert preview["411"]["inputs"] == {"samples": ["405:367", 1], "filename_prefix": "latents/shorts_g-1_audio"}
    assert preview["412"]["class_type"] == "PreviewAny" and preview["412"]["inputs"] == {"source": ["405:382", 0]}
    assert full["405:374"]["inputs"]["samples"] == ["405:369", 0]  # the workflow passed in isn't changed


def test_a_final_is_the_upscale_and_refine_passes_on_the_previews_latents() -> None:
    full = wf.apply(wf.load(WORKFLOW), prompt=PROMPT, seed=12345, megapixels=0.8, duration=3)
    final = wf.final_workflow(full, video_latent="shorts_m-1_video.latent", audio_latent="shorts_m-1_audio.latent", prompt_text="An enhanced fox")
    assert final["410"] == {"inputs": {"latent": "shorts_m-1_video.latent"}, "class_type": "LoadLatent", "_meta": {"title": "The preview's video latent (Shorts Creator)"}}
    assert final["411"]["inputs"] == {"latent": "shorts_m-1_audio.latent"}
    # Nothing of the first pass runs again (not even the size, length or prompt enhancer).
    assert not FIRST_PASS & set(final)
    assert not {"405:380", "405:382", "405:376", "405:393"} & set(final)
    # Everything else is the full workflow's, node for node, except where the first pass came in.
    assert final["405:348"]["inputs"]["samples"] == ["410", 0]
    assert final["405:340"]["inputs"]["audio_latent"] == ["411", 0]
    assert final["405:364"]["inputs"]["text"] == "An enhanced fox"
    for node_id in set(final) - {"410", "411", "405:348", "405:340", "405:364"}:
        assert final[node_id] == full[node_id], node_id
    assert {k: v for k, v in final["405:348"]["inputs"].items() if k != "samples"} == {k: v for k, v in full["405:348"]["inputs"].items() if k != "samples"}
    assert final["405:338"]["inputs"]["noise_seed"] == 42  # the workflow's refine seed, unless asked
    assert final["75"] == full["75"]

    again = wf.final_workflow(full, video_latent="v.latent", audio_latent="a.latent", seed=999)
    assert again["405:338"]["inputs"]["noise_seed"] == 999
    assert again["405:364"]["inputs"]["text"] == ["405:382", 0]  # no text given: the prompt as the workflow reads it


def test_a_workflow_without_two_passes_says_finals_cant_match() -> None:
    single = real_workflow()
    # One pass: the video is decoded from the first pass, and the upscale and refine are gone.
    single["405:374"]["inputs"]["samples"] = ["405:367", 0]
    single["405:358"]["inputs"]["samples"] = ["405:367", 1]
    for node_id in REFINE_PASS - {"405:338", "405:341", "405:391", "405:395"}:
        single.pop(node_id)
    assert wf.finals_problem(single) == (
        "Finals can't be made from previews with this workflow: the first pass's video latent has to go "
        "into one LTXVLatentUpsampler node, and goes into 0."
    )


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
        "finalsProblem": None,
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
def test_scene_previews_are_shots_saved_with_their_scene(client: TestClient, comfy: FakeComfy, make_service, service: GenerationService) -> None:
    first, second = previews(client)
    assert first["scene"] == second["scene"] == SCENE
    assert first["seed"] != second["seed"]
    sent = [comfy.submitted[j["promptId"]]["prompt"] for j in (first, second)]
    assert [s["405:339"]["inputs"]["noise_seed"] for s in sent] == [first["seed"], second["seed"]]
    # Only the first pass of a Final-quality (0.8 megapixel) shot, its latents saved.
    assert all(s["409"]["inputs"]["megapixels"] == 0.8 and s["405:362"]["inputs"]["value"] == 3 for s in sent)
    assert all("405:368" not in s and s["410"]["class_type"] == s["411"]["class_type"] == "SaveLatent" for s in sent)
    assert sent[0]["410"]["inputs"]["filename_prefix"] == f"latents/shorts_{first['id']}_video"
    assert (first["kind"], first["megapixels"], first["nodes"]) == ("preview", 0.8, {"videoLatent": "410", "audioLatent": "411", "promptText": "412"})

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
        assert generation["promptText"] == PROMPT
        # Its first pass's latents are kept with it in the library, for its final.
        for kind in ("video", "audio"):
            assert item["latents"][kind] == f"{item['id']}-{kind}.latent"
            saved = comfy.submitted[queued["promptId"]]["prompt"]["410" if kind == "video" else "411"]["inputs"]["samples"]
            assert service.library.latent_path(item["id"], kind).read_bytes() == f"{queued['promptId']}:{saved}".encode()


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


# Scene finals (the Scenes tab) -------------------------------------------------------------------


def final(client: TestClient, item_id: str, scene: dict | None = None, **body) -> dict:
    response = client.post("/api/comfy/finals", json={"previewItemId": item_id, "scene": scene or SCENE, **body})
    assert response.status_code == 200, response.text
    return response.json()["job"]


def finish_previews(client: TestClient, comfy: FakeComfy, scene: dict = SCENE, count: int = 1, **body) -> list[dict]:
    """Makes a scene's previews and runs them; returns their library items."""
    queued = shots(client, duration=3, quality="draft", variations=count, scene=scene, **body)
    for one in queued:
        comfy.finish(comfy.start_next())
        wait_until(lambda: job(client, one["id"])["status"] == "done", what="the preview")
    items = {item["id"]: item for item in client.get("/api/library").json()}
    return [items[job(client, one["id"])["itemId"]] for one in queued]


@needs_ffmpeg
def test_a_final_is_made_from_the_chosen_previews_own_latents(client: TestClient, comfy: FakeComfy, service: GenerationService) -> None:
    comfy.enhanced_prompt = "A red fox trots through deep, powdery snow at dusk; slow tracking shot"
    first, chosen = finish_previews(client, comfy, count=2)

    queued = final(client, chosen["id"])
    assert (queued["kind"], queued["scene"], queued["previewItemId"], queued["refineSeed"]) == ("final", SCENE, chosen["id"], 42)
    assert (queued["seed"], queued["prompt"], queued["duration"], queued["quality"]) == (chosen["generation"]["seed"], PROMPT, 3, "final")

    # The chosen preview's saved latents went to ComfyUI's input folder, and the final loads them.
    assert comfy.uploads == {
        f"shorts_{chosen['id']}_{kind}.latent": service.library.latent_path(chosen["id"], kind).read_bytes() for kind in ("video", "audio")
    }
    sent = comfy.submitted[queued["promptId"]]["prompt"]
    assert sent["410"]["inputs"]["latent"] == f"shorts_{chosen['id']}_video.latent"
    assert sent["411"]["inputs"]["latent"] == f"shorts_{chosen['id']}_audio.latent"
    assert sent["405:348"]["inputs"]["samples"] == ["410", 0] and sent["405:340"]["inputs"]["audio_latent"] == ["411", 0]
    # No first pass: nothing that could make a different video. The prompt is the text the preview used.
    assert not FIRST_PASS & set(sent)
    assert sent["405:364"]["inputs"]["text"] == comfy.enhanced_prompt

    # Progress follows the one sampling pass that runs.
    prompt_id = comfy.start_next()
    comfy.progress(prompt_id, "405:368", 2, 3)
    wait_until(lambda: job(client, queued["id"])["message"] == "Generating (step 2 of 3)…", what="the final's progress")
    comfy.finish(prompt_id)
    wait_until(lambda: job(client, queued["id"])["status"] == "done", what="the final to be saved")
    item = next(i for i in client.get("/api/library").json() if i["id"] == job(client, queued["id"])["itemId"])
    assert item["name"] == "Final: A red fox trots through deep snow at dusk, slow…"
    assert item["source"] == "ai" and item["aiGenerated"] is True and item["latents"] is None
    generation = item["generation"]
    assert (generation["type"], generation["projectId"], generation["sceneId"]) == ("final", "p-scenes", "s-three")
    assert (generation["previewItemId"], generation["previewShotId"], generation["shotId"]) == (chosen["id"], chosen["generation"]["shotId"], queued["id"])
    assert (generation["seed"], generation["refineSeed"], generation["quality"]) == (chosen["generation"]["seed"], 42, "final")
    assert generation["basedOn"] == chosen["id"]

    # "Regenerate final": the same preview with a new refine seed. The other preview is untouched.
    again = final(client, chosen["id"], seed=777)
    assert again["refineSeed"] == 777 and comfy.submitted[again["promptId"]]["prompt"]["405:338"]["inputs"]["noise_seed"] == 777
    assert set(comfy.uploads) == {f"shorts_{chosen['id']}_video.latent", f"shorts_{chosen['id']}_audio.latent"}
    assert next(i for i in client.get("/api/library").json() if i["id"] == first["id"]) == first


@needs_ffmpeg
def test_finals_for_every_scene_queue_and_run_one_at_a_time_and_a_failure_retries_alone(client: TestClient, comfy: FakeComfy) -> None:
    scenes = [{"projectId": "p-scenes", "sceneId": f"s-{n}"} for n in (1, 2, 3)]
    chosen = [finish_previews(client, comfy, scene)[0] for scene in scenes]
    jobs = [final(client, item["id"], scene) for item, scene in zip(chosen, scenes, strict=True)]
    assert [j["scene"]["sceneId"] for j in jobs] == ["s-1", "s-2", "s-3"]
    assert comfy.pending == [j["promptId"] for j in jobs]  # all in ComfyUI's queue, which runs one at a time

    first = comfy.start_next()
    wait_until(lambda: [job(client, j["id"])["queuePosition"] for j in jobs] == [0, 1, 2], what="queue positions")
    comfy.finish(first)
    wait_until(lambda: job(client, jobs[0]["id"])["status"] == "done", what="the first final")

    # Scene 2's final fails with ComfyUI's reason; scene 3's keeps going.
    comfy.finish(comfy.start_next(), error="CUDA out of memory. Tried to allocate 2.00 GiB")
    wait_until(lambda: job(client, jobs[1]["id"])["status"] == "error", what="the failure")
    assert job(client, jobs[1]["id"])["error"] == "ComfyUI failed in SamplerCustomAdvanced (405:344): CUDA out of memory. Tried to allocate 2.00 GiB"
    comfy.finish(comfy.start_next())
    wait_until(lambda: job(client, jobs[2]["id"])["status"] == "done", what="the third final")

    # Retry: only scene 2's final again, from the same preview with the same refine seed.
    submitted = len(comfy.submitted)
    retry = final(client, chosen[1]["id"], scenes[1], seed=jobs[1]["refineSeed"])
    assert len(comfy.submitted) == submitted + 1
    assert (retry["previewItemId"], retry["refineSeed"], retry["scene"]) == (chosen[1]["id"], 42, scenes[1])
    comfy.finish(comfy.start_next())
    wait_until(lambda: job(client, retry["id"])["status"] == "done", what="the retried final")

    finals = [i["generation"] for i in client.get("/api/library").json() if (i["generation"] or {}).get("type") == "final"]
    assert sorted((g["sceneId"], g["previewItemId"]) for g in finals) == [("s-1", chosen[0]["id"]), ("s-2", chosen[1]["id"]), ("s-3", chosen[2]["id"])]


@needs_ffmpeg
def test_a_cancelled_final_comes_back_as_cancelled(client: TestClient, comfy: FakeComfy) -> None:
    [item] = finish_previews(client, comfy)
    queued = final(client, item["id"])
    assert client.post(f"/api/comfy/shots/{queued['id']}/cancel").json()["status"] == "cancelled"
    assert comfy.deleted == [queued["promptId"]]


def test_a_final_needs_a_preview_with_its_latents(client: TestClient, comfy: FakeComfy, service: GenerationService, video: Path, tmp_path: Path) -> None:
    from app.library.store import ClipMetadata

    # A preview made before finals could match (part A): no latents with it.
    copy_of = tmp_path / "old.mp4"
    copy_of.write_bytes(video.read_bytes())
    old = service.library.add_clip(copy_of, "ai", ClipMetadata(name="Old", generation={"type": "preview", "prompt": PROMPT, "seed": 5, **SCENE}))
    response = client.post("/api/comfy/finals", json={"previewItemId": old["id"], "scene": SCENE})
    assert response.status_code == 409
    assert response.json()["detail"] == service_module.OLD_PREVIEW
    assert "made before finals could match their previews" in response.json()["detail"]

    # Not a preview at all, or gone from the library.
    other = tmp_path / "other.mp4"
    other.write_bytes(video.read_bytes())
    shot = service.library.add_clip(other, "ai", ClipMetadata(name="Shot", generation={"prompt": PROMPT, "seed": 5}))
    assert client.post("/api/comfy/finals", json={"previewItemId": shot["id"], "scene": SCENE}).status_code == 400
    assert client.post("/api/comfy/finals", json={"previewItemId": "m-gone", "scene": SCENE}).status_code == 404
    assert comfy.submitted == {} and comfy.uploads == {}


@needs_ffmpeg
def test_a_preview_whose_latents_werent_saved_fails_and_says_so(client: TestClient, comfy: FakeComfy) -> None:
    comfy.save_latents = False
    [queued] = previews(client, count=1)
    comfy.finish(comfy.start_next())
    wait_until(lambda: job(client, queued["id"])["status"] == "error", what="the error")
    assert "didn't save its video latent, so no final could match it" in job(client, queued["id"])["error"]
    assert client.get("/api/library").json() == []


def test_scene_previews_and_finals_need_a_workflow_with_two_passes(make_service, comfy_settings: Settings, comfy: FakeComfy, tmp_path: Path) -> None:
    single = real_workflow()
    single["405:374"]["inputs"]["samples"] = ["405:367", 0]
    single["405:358"]["inputs"]["samples"] = ["405:367", 1]
    for node_id in ("405:348", "405:371", "405:340", "405:368", "405:369"):
        single.pop(node_id)
    path = tmp_path / "ltx_t2v_api.json"
    path.write_text(json.dumps(single))
    service = make_service(dataclasses.replace(comfy_settings, comfy_workflow=path))
    status = service.status()
    assert status["workflowProblem"] is None  # ordinary shots still work
    assert status["finalsProblem"].startswith("Finals can't be made from previews with this workflow")
    with pytest.raises(wf.WorkflowError, match="Finals can't be made from previews"):
        service.generate(PROMPT, 3, "draft", scene=SCENE)
    assert service.generate(PROMPT, 3, "draft")[0]["kind"] == "shot"
    assert len(comfy.submitted) == 1


@needs_ffmpeg
def test_deleting_a_preview_deletes_its_latents(client: TestClient, comfy: FakeComfy, service: GenerationService) -> None:
    [item] = finish_previews(client, comfy)
    paths = [service.library.latent_path(item["id"], kind) for kind in ("video", "audio")]
    assert all(path.is_file() for path in paths)
    assert client.delete(f"/api/library/{item['id']}").status_code == 200
    assert not any(path.exists() for path in paths)


@needs_ffmpeg
def test_a_final_keeps_going_after_a_restart(make_service, comfy: FakeComfy) -> None:
    before = make_service()
    [preview] = before.generate(PROMPT, 3, "draft", scene=SCENE)
    comfy.finish(comfy.start_next())
    wait_until(lambda: before.list()[0]["status"] == "done", what="the preview")
    queued = before.generate_final(before.list()[0]["itemId"], SCENE)
    before.stop()

    after = make_service()
    after.resume()
    prompt_id = comfy.start_next()
    comfy.progress(prompt_id, "405:368", 1, 3)  # its progress, from the final's own workflow
    wait_until(lambda: next(j for j in after.list() if j["id"] == queued["id"])["message"] == "Generating (step 1 of 3)…", what="progress")
    comfy.finish(prompt_id)
    wait_until(lambda: next(j for j in after.list() if j["id"] == queued["id"])["status"] == "done", what="the resumed final")
    item = after.library.get(next(j for j in after.list() if j["id"] == queued["id"])["itemId"])
    assert item["generation"]["type"] == "final" and item["generation"]["previewShotId"] == preview["id"]
