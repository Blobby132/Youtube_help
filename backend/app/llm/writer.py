"""Write scenes with AI: the language model fills in each scene's source (an AI clip or stock
footage), visual description, stock search text and ComfyUI prompt, and may suggest merging or
splitting scenes. "Rewrite prompt" asks it for one scene's prompt only.

The prompt-writing rules come from prompts/ltx_guide.md, read at every run, so editing that file
changes the next run. The model answers in JSON (a schema the server enforces where it can). Every
answer is checked; one that can't be used is sent back once with what's wrong, and if the second
can't be used either, the run fails with both raw answers, to show what the model wrote. Scenes go
to the model a few at a time, so a long video fits a small context window.

Fields you've edited are never overwritten: the model is told you wrote them, and its text for them
comes back apart (`ask`), for the app to ask about. A merge or split is only offered when the scenes
it makes are 2 to 5 seconds long, and a split cuts where a word starts (the word timings come with
the request); the others are listed with the reason they were left out.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.errors import AppError
from app.llm.client import LlmClient, Reply

MIN_SCENE_SECONDS, MAX_SCENE_SECONDS = 2.0, 5.0
# Scenes per request: their answers fit a 4096-token context with room to spare.
SCENES_PER_REQUEST = 6
FIELDS = ("source", "description", "searchText", "prompt")
SOURCES = ("ai", "stock")
# The longest each field can be (the Scenes tab's own limits).
LIMITS = {"description": 2000, "searchText": 100, "prompt": 4000}
# A prompt shorter than this can't describe a shot by the guide (small models write "LTX-2.5").
MIN_PROMPT_WORDS = 12
# A prompt sharing this many words in a row with the guide copied its example (small models do).
COPIED_WORDS = 8
EPS = 1e-6

Progress = Callable[[float, str], None]
# Runs of COPIED_WORDS words in a row (to spot a prompt copied from the guide).
Runs = AbstractSet[tuple[str, ...]]


# The guide ---------------------------------------------------------------------------------------


def read_guide(path: Path) -> str:
    """prompts/ltx_guide.md without its HTML comments (notes for you, not for the model)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise AppError(
            f"The prompt guide {path.name} was not found (looked in {path.parent}). It holds the rules for writing "
            "prompts: restore it with `git checkout prompts/ltx_guide.md`, or point LTX_GUIDE in .env at your copy.",
            500,
        ) from None
    except OSError as exc:
        raise AppError(f"Can't read the prompt guide {path}: {exc}", 500) from exc
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()
    if not text:
        raise AppError(f"The prompt guide {path.name} is empty: write the rules for prompts in it.", 500)
    return text


# Reading answers ---------------------------------------------------------------------------------


def parse_json(text: str) -> Any:
    """The JSON in an answer, allowing for what models add around it: a <think> block, ``` fences
    or a sentence before or after."""
    cleaned = re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.DOTALL).strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", cleaned, flags=re.DOTALL)
    if fenced:
        cleaned = fenced.group(1).strip()
    if not cleaned:
        raise ValueError("the answer is empty")
    try:
        return json.loads(cleaned)
    except ValueError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("the answer has no JSON object in it")
    try:
        return json.loads(cleaned[start : end + 1])
    except ValueError as exc:
        raise ValueError(f"the answer isn't valid JSON ({exc})") from None


def clean_text(value: str, limit: int) -> str:
    """One paragraph, cut at a word boundary if it's over the field's limit."""
    text = " ".join(value.split())
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0]
    return text


def word_runs(text: str, size: int = COPIED_WORDS) -> Runs:
    words = re.findall(r"[\w']+", text.lower())
    return {tuple(words[i : i + size]) for i in range(len(words) - size + 1)}


def prompt_problem(prompt: str, guide_runs: Runs) -> str | None:
    """Why a prompt can't be used even though it isn't empty, or None."""
    if len(prompt.split()) < MIN_PROMPT_WORDS:
        return f"is too short to describe the shot: write the whole shot by the guide (at least {MIN_PROMPT_WORDS} words)"
    if word_runs(prompt) & guide_runs:
        return "copies the guide's example: describe this scene's own shot"
    return None


def check_texts(item: Any, where: str, errors: list[str], guide_runs: Runs = frozenset()) -> dict[str, str] | None:
    """The four fields of one scene (or a split's second part), or None with `errors` added."""
    if not isinstance(item, dict):
        errors.append(f"{where} isn't an object")
        return None
    texts: dict[str, str] = {}
    ok = True
    for name in FIELDS:
        value = item.get(name)
        if not isinstance(value, str) or not value.strip():
            errors.append(f'{where}: "{name}" is {"missing" if value is None else "empty" if isinstance(value, str) else "not text"}')
            ok = False
            continue
        if name == "source":
            source = value.strip().lower()
            if source not in SOURCES:
                errors.append(f'{where}: "source" is "{value}", but it has to be "ai" or "stock"')
                ok = False
            texts[name] = source
        else:
            texts[name] = clean_text(value, LIMITS[name])
            problem = prompt_problem(texts[name], guide_runs) if name == "prompt" else None
            if problem:
                errors.append(f'{where}: "prompt" {problem}')
                ok = False
    return texts if ok else None


@dataclass
class Entry:
    """The model's answer for one scene."""

    number: int
    texts: dict[str, str]
    merge: bool = False
    # A split: the words the second part starts with, and that part's fields.
    split_before: str | None = None
    second: dict[str, str] | None = None
    why: str = ""


def check_scenes(data: Any, numbers: list[int], guide_runs: Runs = frozenset()) -> tuple[dict[int, Entry], list[str]]:
    """The answer for the scenes `numbers`, and what's wrong with it (nothing: it can be used)."""
    errors: list[str] = []
    items = data.get("scenes") if isinstance(data, dict) else data if isinstance(data, list) else None
    if not isinstance(items, list):
        return {}, ['the answer needs a "scenes" list']
    entries: dict[int, Entry] = {}
    for index, item in enumerate(items):
        number = item.get("scene") if isinstance(item, dict) else None
        if isinstance(number, str) and number.strip().isdigit():
            number = int(number)
        where = f"scene {number}" if isinstance(number, int) else f"item {index + 1} of the list"
        if not isinstance(number, int) or isinstance(number, bool):
            errors.append(f'{where}: "scene" has to be the scene\'s number')
            continue
        if number not in numbers:
            errors.append(f"there is no scene {number} in this list (it has scenes {numbers[0]} to {numbers[-1]})")
            continue
        if number in entries:
            errors.append(f"scene {number} is in the list twice")
            continue
        texts = check_texts(item, where, errors, guide_runs)
        merge = item.get("mergeWithNext", False)
        if not isinstance(merge, bool):
            errors.append(f'{where}: "mergeWithNext" has to be true or false')
            continue
        split = item.get("split")
        split = [split] if isinstance(split, dict) else split if split is not None else []
        if not isinstance(split, list) or len(split) > 1:
            errors.append(f'{where}: "split" has to be a list with at most one part')
            continue
        before = second = None
        if split:
            part = split[0]
            starts = part.get("startsWith") if isinstance(part, dict) else None
            if not isinstance(starts, str) or not starts.strip():
                errors.append(f'{where}: the split needs "startsWith", the words its second part begins with')
            else:
                before = starts.strip()
            second = check_texts(part, f"{where}'s second part", errors, guide_runs)
            if second is None or before is None:
                continue
        why = item.get("why")
        if texts is not None:
            entries[number] = Entry(number, texts, merge, before, second, why.strip() if isinstance(why, str) else "")
    missing = [n for n in numbers if n not in entries and not any(re.match(rf"scene {n}\b", e) for e in errors)]
    if missing:
        errors.append(f"scene{'s' if len(missing) > 1 else ''} {', '.join(map(str, missing))} {'are' if len(missing) > 1 else 'is'} missing")
    return entries, errors


def check_prompt(data: Any, guide_runs: Runs = frozenset()) -> tuple[str | None, list[str]]:
    prompt = data.get("prompt") if isinstance(data, dict) else None
    if not isinstance(prompt, str) or not prompt.strip():
        return None, ['the answer needs a "prompt" with the text']
    text = clean_text(prompt, LIMITS["prompt"])
    problem = prompt_problem(text, guide_runs)
    return (None, [f'the "prompt" {problem}']) if problem else (text, [])


# What's asked ------------------------------------------------------------------------------------

SOURCE_TEXT = {"type": "string", "enum": list(SOURCES)}
TEXT = {"type": "string"}
TEXT_FIELDS = {"source": SOURCE_TEXT, "description": TEXT, "searchText": TEXT, "prompt": TEXT}


def scenes_schema(count: int) -> dict[str, Any]:
    part = {
        "type": "object",
        "properties": {"startsWith": TEXT, **TEXT_FIELDS},
        "required": ["startsWith", *FIELDS],
        "additionalProperties": False,
    }
    entry = {
        "type": "object",
        "properties": {
            "scene": {"type": "integer"},
            **TEXT_FIELDS,
            "mergeWithNext": {"type": "boolean"},
            "split": {"type": "array", "items": part, "maxItems": 1},
            "why": TEXT,
        },
        "required": ["scene", *FIELDS, "mergeWithNext", "split", "why"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"scenes": {"type": "array", "items": entry, "minItems": count, "maxItems": count}},
        "required": ["scenes"],
        "additionalProperties": False,
    }


PROMPT_SCHEMA = {"type": "object", "properties": {"prompt": TEXT}, "required": ["prompt"], "additionalProperties": False}

SCENES_TASK = """You plan the pictures of a vertical YouTube Short (9:16) from its narration, which is cut into scenes of 2 to 5 seconds. For each scene, choose where its picture comes from and write:
- "source": "ai" for a clip made by LTX-2.5 (text-to-video in ComfyUI), or "stock" for stock footage from Pixabay. Stock suits everyday real subjects that are easy to film and find (cities, nature, people at work, common objects); AI suits specific, unusual or explanatory shots no stock clip will have.
- "description": what is on screen, in one or two plain sentences.
- "searchText": two to four words to search Pixabay with: nouns, no punctuation.
- "prompt": the LTX-2.5 prompt for the shot, following the guide below. Write one for every scene, stock ones too, in case it is switched to AI.

The scenes play one after another in one video: keep the people, places, objects and look consistent from scene to scene. Show what the narration is about; never put text, captions or logos in the picture.

Changing the cuts is optional; most scenes need neither:
- "mergeWithNext": true when this scene and the next one should be a single shot. Then write this scene's fields for the combined scene, and still write the next scene's entry. The combined scene must be 2 to 5 seconds long, and the last scene in the list can't merge.
- "split": to cut this scene in two, give one part: "startsWith" (the exact words the second part begins with, copied from the narration) and the second part's "source", "description", "searchText" and "prompt". This scene's own fields then describe the first part. Both parts must be 2 to 5 seconds long, so only scenes longer than 4 seconds can be split. Otherwise "split" is [].
- "why": one short sentence saying why you merged or split, else "".

Where a field says it was written by the user, keep to it: write the other fields to match it.

Answer with one JSON object and nothing else, in this form:
{"scenes": [{"scene": 1, "source": "ai", "description": "...", "searchText": "...", "prompt": "...", "mergeWithNext": false, "split": [], "why": ""}]}"""

PROMPT_TASK = """You write the text-to-video prompt for one scene of a vertical YouTube Short (9:16), for LTX-2.5 in ComfyUI, following the guide below. Show what the narration is about; never put text, captions or logos in the picture. If the scene has a prompt already, rewrite it to follow the guide, keeping its idea unless it doesn't fit the scene.

Answer with one JSON object and nothing else: {"prompt": "..."}"""

FIELD_NAMES = {"source": "source", "description": "visual description", "searchText": "stock search text", "prompt": "ComfyUI prompt"}


def system_message(task: str, guide: str) -> dict[str, str]:
    return {"role": "system", "content": f"{task}\n\n# How to write the prompt (LTX-2.5)\n\n{guide}"}


def timecode(seconds: float) -> str:
    """0:03.04, as the Scenes tab shows times (lib/time.ts formatTimecode)."""
    hundredths = max(0, math.floor(seconds * 100 + 1e-6))
    return f"{hundredths // 6000}:{hundredths % 6000 // 100:02d}.{hundredths % 100:02d}"


def narration_of(scene: dict[str, Any]) -> str:
    return " ".join(str(w["text"]) for w in scene["words"])


def describe_scene(number: int, scene: dict[str, Any]) -> str:
    length = scene["end"] - scene["start"]
    lines = [f"Scene {number} · {timecode(scene['start'])}–{timecode(scene['end'])} ({length:.1f} s)"]
    lines.append(f"Narration: “{narration_of(scene)}”" if scene["words"] else "Narration: (none: a pause)")
    for name in scene["edited"]:
        value = scene[name]
        if name == "source" and value == "none":
            continue  # "no picture yet" isn't something to keep to
        lines.append(f"{FIELD_NAMES[name].capitalize()}, written by the user: “{value}”")
    return "\n".join(lines)


def scenes_message(script: str, scenes: list[dict[str, Any]], numbers: list[int], earlier: list[tuple[int, str]]) -> dict[str, str]:
    parts = [f"The whole narration:\n“{' '.join(script.split())}”"]
    if earlier:
        parts.append("Scenes already planned before these (keep them consistent):\n" + "\n".join(f"Scene {n}: {d}" for n, d in earlier[-6:]))
    listed = "\n\n".join(describe_scene(n, scenes[n - 1]) for n in numbers)
    parts.append(f"Plan scenes {numbers[0]} to {numbers[-1]} of {len(scenes)}:\n\n{listed}")
    return {"role": "user", "content": "\n\n".join(parts)}


def retry_message(errors: list[str], numbers: list[int] | None = None) -> dict[str, str]:
    listed = "\n".join(f"- {e}" for e in errors[:12])
    whole = f"the whole JSON object for scenes {numbers[0]} to {numbers[-1]}" if numbers else "the whole JSON object"
    return {"role": "user", "content": f"That answer can't be used:\n{listed}\n\nAnswer again with {whole}, fixed. Only the JSON, no other text."}


# Asking, with one retry --------------------------------------------------------------------------


@dataclass
class Asked:
    value: Any
    attempts: int


def ask(
    client: LlmClient,
    messages: list[dict[str, str]],
    schema: dict[str, Any],
    check: Callable[[Any], tuple[Any, list[str]]],
    what: str,
    on_text: Callable[[str, int], None] | None = None,
    retry_numbers: list[int] | None = None,
) -> Asked:
    """Asks, checks the answer, and asks once more with what was wrong if it can't be used. Raises
    with both raw answers (errorData "raw") when the second can't be used either."""
    raw: list[str] = []
    for attempt in (1, 2):
        reply: Reply = client.chat(messages, schema, on_text)
        raw.append(reply.text)
        try:
            value, errors = check(parse_json(reply.text))
        except ValueError as exc:
            value, errors = None, [str(exc)]
        if reply.finish_reason == "length" and errors:
            errors.append("the answer stopped before it was finished")
        if not errors:
            return Asked(value, attempt)
        if attempt == 1:
            messages = [*messages, {"role": "assistant", "content": reply.text}, retry_message(errors, retry_numbers)]
    message = f"The language model's answer for {what} couldn't be used, even after asking again: {'; '.join(errors[:4])}."
    if reply.finish_reason == "length":
        message += (
            " It ran out of room before finishing: give the model a longer context (LM Studio: Context Length when loading "
            "the model; Ollama: OLLAMA_CONTEXT_LENGTH), or use a model that writes less."
        )
    raise AppError(message, 502, extra={"raw": raw})


# Write scenes ------------------------------------------------------------------------------------


def norm_word(text: str) -> str:
    return re.sub(r"[^\w']+", "", text.lower().replace("’", "'"))


def find_cut(scene: dict[str, Any], before: str) -> int | None:
    """Index of the word (not the first) where the words of `before` begin in the scene's narration."""
    wanted = [w for w in (norm_word(t) for t in before.split()) if w][:4]
    words = [norm_word(str(w["text"])) for w in scene["words"]]
    if not wanted:
        return None
    for i in range(1, len(words)):
        if words[i : i + len(wanted)] == wanted:
            return i
    # A model that cut the quote short in the middle of a word ("air mov…"): its first word alone.
    for i in range(1, len(words)):
        if words[i] == wanted[0]:
            return i
    return None


def fits(length: float) -> bool:
    return MIN_SCENE_SECONDS - EPS <= length <= MAX_SCENE_SECONDS + EPS


def seconds(length: float) -> str:
    return f"{length:.1f} s"


@dataclass
class Plan:
    scenes: list[dict[str, Any]] = field(default_factory=list)
    merges: list[dict[str, Any]] = field(default_factory=list)
    splits: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def plan(scenes: list[dict[str, Any]], entries: dict[int, Entry], last_in_request: set[int]) -> Plan:
    """What the answers mean for the scenes: the fields to fill in, the edited ones to ask about,
    and the merges and splits that keep every scene 2 to 5 seconds long."""
    result = Plan()
    merged_away: set[int] = set()
    for number, scene in enumerate(scenes, 1):
        entry = entries[number]
        set_: dict[str, str] = {}
        ask_: dict[str, str] = {}
        for name in FIELDS:
            value = entry.texts[name]
            if name not in scene["edited"]:
                set_[name] = value
            elif value != scene[name]:
                ask_[name] = value
        result.scenes.append({"id": scene["id"], "set": set_, "ask": ask_})

        wants_split = entry.split_before is not None and entry.second is not None
        if number in merged_away or not (entry.merge or wants_split):
            if number in merged_away and (entry.merge or wants_split):
                result.skipped.append(f"Scene {number} was merged into scene {number - 1}, so its own merge or split was left out.")
            continue
        if entry.merge and wants_split:
            result.skipped.append(f"Scene {number}: the model asked to merge it and split it at once, so neither was done.")
            continue
        why = entry.why
        if entry.merge:
            following = scenes[number] if number < len(scenes) else None
            if following is None or number in last_in_request:
                reason = "it's the last scene" if following is None else f"the model didn't see scene {number + 1} at the same time"
                result.skipped.append(f"Scene {number} wasn't merged with the next: {reason}.")
                continue
            length = following["end"] - scene["start"]
            if not fits(length):
                result.skipped.append(
                    f"Scenes {number} and {number + 1} weren't merged: together they'd be {seconds(length)}, and scenes are 2 to 5 seconds long."
                )
                continue
            merged_away.add(number + 1)
            result.merges.append(
                {
                    "id": scene["id"],
                    "next": following["id"],
                    "start": scene["start"],
                    "end": following["end"],
                    "why": why,
                    # Your text in the next scene that the merged scene would replace.
                    "replacesEdits": [n for n in following["edited"] if n != "source" and following[n].strip()],
                }
            )
            continue
        assert entry.split_before is not None and entry.second is not None
        index = find_cut(scene, entry.split_before)
        if index is None:
            result.skipped.append(f"Scene {number} wasn't split: “{entry.split_before}” isn't in its narration after the first word.")
            continue
        at = float(scene["words"][index]["start"])
        first, second = at - scene["start"], scene["end"] - at
        if not (fits(first) and fits(second)):
            result.skipped.append(
                f"Scene {number} wasn't split before “{scene['words'][index]['text']}”: the parts would be {seconds(first)} and "
                f"{seconds(second)}, and scenes are 2 to 5 seconds long."
            )
            continue
        result.splits.append(
            {
                "id": scene["id"],
                "at": at,
                "before": " ".join(str(w["text"]) for w in scene["words"][index : index + 4]),
                "second": entry.second,
                "why": why,
            }
        )
    return result


def write_scenes(client: LlmClient, guide: str, script: str, scenes: list[dict[str, Any]], progress: Progress) -> dict[str, Any]:
    """Asks the model about every scene, a few at a time, and plans what its answers change."""
    total = len(scenes)
    entries: dict[int, Entry] = {}
    attempts = 0
    last_in_request: set[int] = set()
    system = system_message(SCENES_TASK, guide)
    guide_runs = word_runs(guide)
    for first in range(1, total + 1, SCENES_PER_REQUEST):
        numbers = list(range(first, min(total, first + SCENES_PER_REQUEST - 1) + 1))
        last_in_request.add(numbers[-1])
        earlier = [(n, entries[n].texts["description"]) for n in sorted(entries)]
        messages = [system, scenes_message(script, scenes, numbers, earlier)]
        done = first - 1

        def on_text(text: str, reasoning: int, done: int = done, count: int = len(numbers)) -> None:
            started = min(count, len(re.findall(r'"scene"\s*:', text)))
            if started:
                progress(0.04 + 0.92 * (done + started - 0.5) / total, f"Writing scene {done + started} of {total}…")
            elif reasoning:
                progress(0.04 + 0.92 * done / total, f"Thinking about scenes {numbers[0]} to {numbers[-1]}…")

        progress(0.04 + 0.92 * done / total, f"Reading scenes {numbers[0]} to {numbers[-1]} of {total}…")
        asked = ask(
            client,
            messages,
            scenes_schema(len(numbers)),
            lambda data, numbers=numbers: check_scenes(data, numbers, guide_runs),
            f"scenes {numbers[0]} to {numbers[-1]}",
            on_text,
            numbers,
        )
        entries.update(asked.value)
        attempts += asked.attempts
    planned = plan(scenes, entries, last_in_request - {total})
    return {
        "scenes": planned.scenes,
        "merges": planned.merges,
        "splits": planned.splits,
        "skipped": planned.skipped,
        "attempts": attempts,
        "requests": len(last_in_request),
    }


def rewrite_prompt(client: LlmClient, guide: str, script: str, scene: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """A new ComfyUI prompt for one scene."""
    lines = [
        f"The whole narration:\n“{' '.join(script.split())}”",
        f"Scene {scene['number']} · {timecode(scene['start'])}–{timecode(scene['end'])} ({scene['end'] - scene['start']:.1f} s)",
        f"Narration: “{scene['narration']}”" if scene["narration"].strip() else "Narration: (none: a pause)",
    ]
    if scene["description"].strip():
        lines.append(f"Visual description: “{scene['description'].strip()}”")
    if scene["prompt"].strip():
        lines.append(f"Current prompt: “{scene['prompt'].strip()}”")
    for label, key in (("The scene before shows", "before"), ("The scene after shows", "after")):
        if (scene.get(key) or "").strip():
            lines.append(f"{label}: {scene[key].strip()}")
    messages = [system_message(PROMPT_TASK, guide), {"role": "user", "content": "\n".join(lines)}]

    def on_text(text: str, reasoning: int) -> None:
        progress(0.5 if text else 0.2, "Writing the prompt…" if text else "Thinking…")

    progress(0.1, f"Reading scene {scene['number']}…")
    guide_runs = word_runs(guide)
    asked = ask(client, messages, PROMPT_SCHEMA, lambda data: check_prompt(data, guide_runs), f"scene {scene['number']}'s prompt", on_text)
    return {"prompt": asked.value, "attempts": asked.attempts}
