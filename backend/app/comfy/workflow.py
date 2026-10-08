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


def _upstream(workflow: Workflow, node_id: str, stop: set[str]) -> set[str]:
    """Node types reachable by following a node's inputs, not going past `stop` types."""
    seen: set[str] = set()
    found: set[str] = set()
    pending = [node_id]
    while pending:
        current = pending.pop()
        if current in seen or current not in workflow:
            continue
        seen.add(current)
        node = workflow[current]
        found.add(node.get("class_type", ""))
        if current != node_id and node.get("class_type") in stop:
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                pending.append(value[0])
    return found


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
