"""The ComfyUI workflow (comfy/ltx_t2v_api.json, exported with "Export (API)") and the one place
that says which of its inputs the app changes.

Nodes are found by type and title, not by their numeric ids, so re-exporting the workflow from
ComfyUI keeps working as long as the nodes below are still there. If one can't be found, the
error names it.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.errors import AppError

Workflow = dict[str, dict[str, Any]]

ASPECT_RATIO = "9:16 (Portrait Widescreen)"
FPS = 24


@dataclass(frozen=True)
class Target:
    """Where one setting lives in the workflow: the input `input` of a node of type `class_type`
    (and title `title`, when several nodes share the type)."""

    label: str
    class_type: str
    input: str
    title: str | None = None
    # Picks one node when several match (gets the workflow and the matching node ids).
    choose: Callable[[Workflow, list[str]], list[str]] | None = None

    def describe(self) -> str:
        titled = f" titled “{self.title}”" if self.title else ""
        return f"{self.label} (the “{self.input}” input of a {self.class_type} node{titled})"


def is_link(value: Any) -> bool:
    """An input connected to another node's output: [node id, output index]."""
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int)


def _reachable(workflow: Workflow, node_id: str | None, stop: frozenset[str] | set[str] = frozenset()) -> set[str]:
    """Ids of the nodes reached by following a node's inputs (itself included), not going past
    nodes of the `stop` types."""
    seen: set[str] = set()
    pending = [node_id] if node_id else []
    while pending:
        current = pending.pop()
        if current in seen or current not in workflow:
            continue
        seen.add(current)
        node = workflow[current]
        if current != node_id and node.get("class_type") in stop:
            continue
        pending.extend(value[0] for value in (node.get("inputs") or {}).values() if is_link(value))
    return seen


def _upstream(workflow: Workflow, node_id: str, stop: set[str]) -> set[str]:
    """Node types reachable by following a node's inputs, not going past `stop` types."""
    return {workflow[n].get("class_type", "") for n in _reachable(workflow, node_id, stop)}


def first_pass_noise(workflow: Workflow, candidates: list[str]) -> list[str]:
    """LTX-2.5 samples twice: once from an empty latent, then a refine pass on the upscaled
    result. The variation seed is the first pass's noise; the refine pass keeps its own seed."""
    chosen = []
    for node_id, node in workflow.items():
        if node.get("class_type") != "SamplerCustomAdvanced":
            continue
        noise = (node.get("inputs") or {}).get("noise")
        latent = (node.get("inputs") or {}).get("latent_image")
        if not (isinstance(noise, list) and noise[0] in candidates and isinstance(latent, list)):
            continue
        reached = _upstream(workflow, latent[0], stop={"SamplerCustomAdvanced", "LTXVLatentUpsampler"})
        if "EmptyLTXVLatentVideo" in reached:
            chosen.append(noise[0])
    return chosen


# The mapping: every input the app sets, in one place.
INPUTS: dict[str, Target] = {
    "prompt": Target("Prompt text", "PrimitiveStringMultiline", "value", title="Prompt"),
    "seed": Target("Seed", "RandomNoise", "noise_seed", choose=first_pass_noise),
    "megapixels": Target("Resolution (megapixels)", "ResolutionSelector", "megapixels"),
    "aspect_ratio": Target("Aspect ratio", "ResolutionSelector", "aspect_ratio"),
    "duration": Target("Duration (seconds)", "PrimitiveInt", "value", title="Duration"),
    "fps": Target("Frame rate", "PrimitiveInt", "value", title="Frame Rate"),
}
# The node whose result is the video file.
OUTPUT = Target("Video output", "SaveVideo", "filename_prefix")


class WorkflowError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(message, 422)


def find(workflow: Workflow, target: Target) -> str | None:
    """The id of the node `target` points at, or None."""
    matches = [
        node_id
        for node_id, node in workflow.items()
        if isinstance(node, dict)
        and node.get("class_type") == target.class_type
        and (target.title is None or ((node.get("_meta") or {}).get("title") or "").strip().lower() == target.title.lower())
        and target.input in (node.get("inputs") or {})
    ]
    if len(matches) > 1 and target.choose:
        matches = target.choose(workflow, matches)
    return matches[0] if len(matches) == 1 else None


def check(workflow: Workflow) -> list[str]:
    """What's missing for the app to drive this workflow (empty when it's fine)."""
    problems = []
    for target in [*INPUTS.values(), OUTPUT]:
        node_id = find(workflow, target)
        if node_id is None:
            problems.append(f"{target.describe()} is missing")
        elif target is not OUTPUT and isinstance(workflow[node_id]["inputs"][target.input], list):
            problems.append(f"{target.describe()} is connected to another node; it must be a plain value")
    return problems


def load(path: Path) -> Workflow:
    """Reads and checks the workflow file; raises a WorkflowError naming what's wrong."""
    if not path.is_file():
        raise WorkflowError(
            f"The ComfyUI workflow {path} was not found. Export your workflow from ComfyUI with "
            "Workflow → Export (API) and save it there."
        )
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise WorkflowError(f"The ComfyUI workflow {path.name} can't be read: {exc}") from exc
    if not isinstance(workflow, dict) or not all(isinstance(n, dict) and "class_type" in n for n in workflow.values()):
        raise WorkflowError(
            f"{path.name} isn't an API-format workflow. In ComfyUI use Workflow → Export (API), not Save or Export."
        )
    problems = check(workflow)
    if problems:
        raise WorkflowError(f"{path.name} can't be used: " + "; ".join(problems) + ".")
    return workflow


def apply(workflow: Workflow, *, prompt: str, seed: int, megapixels: float, duration: int) -> Workflow:
    """A copy of the workflow with the shot's settings filled in (always 9:16 at 24 fps)."""
    filled = copy.deepcopy(workflow)
    values = {
        "prompt": prompt,
        "seed": seed,
        "megapixels": megapixels,
        "aspect_ratio": ASPECT_RATIO,
        "duration": duration,
        "fps": FPS,
    }
    for key, value in values.items():
        target = INPUTS[key]
        node_id = find(filled, target)
        if node_id is None:
            raise WorkflowError(f"The workflow can't be used: {target.describe()} is missing.")
        filled[node_id]["inputs"][target.input] = value
    return filled


def output_node(workflow: Workflow) -> str:
    node_id = find(workflow, OUTPUT)
    if node_id is None:
        raise WorkflowError(f"The workflow can't be used: {OUTPUT.describe()} is missing.")
    return node_id


# Previews and finals (the Scenes tab) -------------------------------------------------------------
#
# A scene's final has to be the preview you chose, made bigger and sharper, not a new video (the
# same seed at another size makes a different one). LTX-2.5 already works that way: a first pass
# at half size, then LTXVLatentUpsampler doubles its latent and a refine pass sharpens it. So a
# preview runs only the first pass, decodes it straight away and saves its video and audio
# latents (SaveLatent); its final loads those latents (LoadLatent) and runs only the upscale and
# refine passes. Both are made from the same workflow file by rewiring it, so a final is exactly
# what the whole workflow would have made from that preview's first pass.

SAMPLER = "SamplerCustomAdvanced"
SPLIT = "LTXVSeparateAVLatent"
UPSCALER = "LTXVLatentUpsampler"
TEXT_ENCODER = "CLIPTextEncode"


@dataclass(frozen=True)
class Passes:
    """Where the two sampling passes are in the workflow."""

    first: str  # the first pass's sampler
    first_latents: str  # the Separate AV Latent after it: output 0 is the video latent, 1 the audio
    refine: str  # the refine pass's sampler (after the upscaler)
    refine_latents: str  # the Separate AV Latent after it, which the video is decoded from
    prompt_encoder: str | None  # the CLIPTextEncode reading the prompt for the refine pass


def _source(node: dict[str, Any], name: str) -> str | None:
    value = (node.get("inputs") or {}).get(name)
    return value[0] if is_link(value) else None


def _splits_of(workflow: Workflow, sampler: str) -> list[str]:
    return [
        node_id
        for node_id, node in workflow.items()
        if node.get("class_type") == SPLIT and (node.get("inputs") or {}).get("av_latent") == [sampler, 0]
    ]


def _prompt_encoder(workflow: Workflow, sampler: str) -> str | None:
    """The CLIPTextEncode behind a sampler's positive conditioning (guider → … → positive)."""
    node_id = _source(workflow[sampler], "guider")
    for _ in range(8):
        if node_id is None or node_id not in workflow:
            return None
        if workflow[node_id].get("class_type") == TEXT_ENCODER:
            return node_id
        node_id = _source(workflow[node_id], "positive")
    return None


def find_passes(workflow: Workflow) -> Passes:
    """The two sampling passes, or a WorkflowError saying why finals can't match previews."""

    def problem(reason: str) -> WorkflowError:
        return WorkflowError(f"Finals can't be made from previews with this workflow: {reason}.")

    samplers = [n for n, node in workflow.items() if node.get("class_type") == SAMPLER]
    firsts = [n for n in samplers if "EmptyLTXVLatentVideo" in _upstream(workflow, _source(workflow[n], "latent_image") or "", {SAMPLER, UPSCALER})]
    if len(firsts) != 1:
        raise problem(f"it needs one first sampling pass (a {SAMPLER} starting from an Empty LTXV Latent Video), and has {len(firsts)}")
    first = firsts[0]
    splits = _splits_of(workflow, first)
    if len(splits) != 1:
        raise problem(f"the first pass's result has to go into one Separate AV Latent node ({SPLIT}), and goes into {len(splits)}")
    first_latents = splits[0]
    upscalers = [n for n, node in workflow.items() if node.get("class_type") == UPSCALER and _source(node, "samples") == first_latents]
    if len(upscalers) != 1:
        raise problem(f"the first pass's video latent has to go into one {UPSCALER} node, and goes into {len(upscalers)}")
    refines = [n for n in samplers if n != first and upscalers[0] in _reachable(workflow, _source(workflow[n], "latent_image"), {SAMPLER})]
    if len(refines) != 1:
        raise problem(f"it needs one refine pass (a {SAMPLER} sampling the upscaled latent), and has {len(refines)}")
    refine = refines[0]
    splits = _splits_of(workflow, refine)
    if len(splits) != 1:
        raise problem(f"the refine pass's result has to go into one Separate AV Latent node ({SPLIT}), and goes into {len(splits)}")
    output = find(workflow, OUTPUT)
    if output is None or splits[0] not in _reachable(workflow, output):
        raise problem("the Save Video node doesn't save the refine pass's result")
    return Passes(first, first_latents, refine, splits[0], _prompt_encoder(workflow, refine))


def finals_problem(workflow: Workflow) -> str | None:
    """Why finals can't match their previews with this workflow (None when they can)."""
    try:
        find_passes(workflow)
    except WorkflowError as exc:
        return exc.message
    return None


def _relink(workflow: Workflow, links: dict[tuple[str, int], list[Any]]) -> None:
    """Points every input connected to one of `links`' outputs at its replacement."""
    for node in workflow.values():
        inputs = node.get("inputs") or {}
        for name, value in inputs.items():
            if is_link(value) and (value[0], value[1]) in links:
                inputs[name] = list(links[(value[0], value[1])])


def _prune(workflow: Workflow, outputs: list[str]) -> Workflow:
    """Only the given output nodes and what they need."""
    keep: set[str] = set()
    for node_id in outputs:
        keep |= _reachable(workflow, node_id)
    return {node_id: node for node_id, node in workflow.items() if node_id in keep}


def _new_ids(workflow: Workflow, count: int) -> list[str]:
    """Numeric node ids the workflow doesn't use yet."""
    numbers = [int(part) for node_id in workflow for part in node_id.split(":") if part.isdigit()]
    start = max(numbers, default=0) + 1
    return [str(start + i) for i in range(count)]


def refine_seed(workflow: Workflow) -> int | None:
    """The refine pass's own seed (the workflow keeps it; regenerating a final can change it)."""
    passes = find_passes(workflow)
    noise = _source(workflow[passes.refine], "noise")
    value = (workflow.get(noise or "", {}).get("inputs") or {}).get("noise_seed")
    return value if isinstance(value, int) else None


def preview_workflow(workflow: Workflow, latent_prefix: str) -> tuple[Workflow, dict[str, str]]:
    """A scene preview: the filled-in workflow's first pass only, decoded by the workflow's own
    decoders and saved by its Save Video node, plus SaveLatent nodes for the video and audio
    latents its final starts from. Returns the workflow and the ids of the added nodes:
    "videoLatent", "audioLatent" and, when the prompt text comes from other nodes (the prompt
    enhancer), "promptText", whose result is the exact text the final has to use."""
    passes = find_passes(workflow)
    output = output_node(workflow)
    graph = copy.deepcopy(workflow)
    _relink(graph, {(passes.refine_latents, 0): [passes.first_latents, 0], (passes.refine_latents, 1): [passes.first_latents, 1]})
    video, audio, text = _new_ids(graph, 3)
    added = {"videoLatent": video, "audioLatent": audio}
    for node_id, index, kind in ((video, 0, "video"), (audio, 1, "audio")):
        graph[node_id] = {
            "inputs": {"samples": [passes.first_latents, index], "filename_prefix": f"{latent_prefix}_{kind}"},
            "class_type": "SaveLatent",
            "_meta": {"title": f"Save the preview's {kind} latent (Shorts Creator)"},
        }
    prompt = (graph[passes.prompt_encoder]["inputs"].get("text") if passes.prompt_encoder else None)
    if is_link(prompt):
        graph[text] = {"inputs": {"source": list(prompt)}, "class_type": "PreviewAny", "_meta": {"title": "Prompt text (Shorts Creator)"}}
        added["promptText"] = text
    return _prune(graph, [output, *added.values()]), added


def final_workflow(
    workflow: Workflow,
    *,
    video_latent: str,
    audio_latent: str,
    prompt_text: str | None = None,
    seed: int | None = None,
) -> Workflow:
    """A scene final: LoadLatent nodes with the preview's latents (files in ComfyUI's input
    folder) in place of the first pass, then the workflow's upscale and refine passes. With
    `prompt_text` the refine pass reads exactly that text (what the preview's prompt became);
    with `seed` the refine pass uses that seed instead of the workflow's."""
    passes = find_passes(workflow)
    output = output_node(workflow)
    graph = copy.deepcopy(workflow)
    video, audio = _new_ids(graph, 2)
    for node_id, name, kind in ((video, video_latent, "video"), (audio, audio_latent, "audio")):
        graph[node_id] = {
            "inputs": {"latent": name},
            "class_type": "LoadLatent",
            "_meta": {"title": f"The preview's {kind} latent (Shorts Creator)"},
        }
    _relink(graph, {(passes.first_latents, 0): [video, 0], (passes.first_latents, 1): [audio, 0]})
    if prompt_text is not None and passes.prompt_encoder:
        graph[passes.prompt_encoder]["inputs"]["text"] = prompt_text
    if seed is not None:
        noise = _source(graph[passes.refine], "noise")
        if noise is None or "noise_seed" not in (graph[noise].get("inputs") or {}):
            raise WorkflowError("The workflow can't be used: the refine pass's seed (a RandomNoise node) is missing.")
        graph[noise]["inputs"]["noise_seed"] = seed
    graph = _prune(graph, [output])
    if passes.first in graph:
        raise WorkflowError("Finals can't be made from previews with this workflow: the refine pass still needs the first pass.")
    return graph
