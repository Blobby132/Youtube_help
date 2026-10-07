"""Which projects use which library items, and which timelines contain AI-generated clips.

`ai_clips` is the single answer to "does this video contain AI-generated footage?": the top
bar indicator, the project list and (in Stage 6) the export warning all ask it.
"""

from __future__ import annotations

from typing import Any

from app.projects.store import ProjectStore


def timeline_clips(project: dict[str, Any]) -> list[dict[str, Any]]:
    clips = project.get("clips")
    if not isinstance(clips, list):
        return []
    return [c for c in clips if isinstance(c, dict) and isinstance(c.get("mediaId"), str)]


def ai_clips(project: dict[str, Any], library_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The project's timeline clips whose library item is flagged AI-generated."""
    by_id = {item["id"]: item for item in library_items}
    found = []
    for clip in timeline_clips(project):
        item = by_id.get(clip["mediaId"])
        if item and item.get("aiGenerated"):
            found.append(
                {
                    "clipId": clip.get("id"),
                    "mediaId": item["id"],
                    "name": item.get("name"),
                    "source": item.get("source"),
                    "start": clip.get("start"),
                    "duration": clip.get("duration"),
                }
            )
    return found


def disclosure(project: dict[str, Any], library_items: list[dict[str, Any]]) -> dict[str, Any]:
    clips = ai_clips(project, library_items)
    return {"containsAi": bool(clips), "aiClips": clips}


def projects_using(store: ProjectStore, item_id: str) -> list[dict[str, Any]]:
    """Saved projects whose timeline uses the item."""
    return [
        summary
        for summary, data in store.list_with_data()
        if any(clip["mediaId"] == item_id for clip in timeline_clips(data))
    ]
