"""Stage 6: rendering with real FFmpeg. Renders small projects and checks the MP4: length, size,
frame rate, codecs, audio, and the picture at chosen frames (crop, Fit inside, gaps, trims,
speed, overlays)."""

from __future__ import annotations

import json
import subprocess
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.core.config import Settings
from app.library.store import ClipMetadata, Library
from app.render import encoders
from app.render.plan import checks, make_plan, output_fps, output_path, safe_name, timecode
from app.render.service import Overlay, RenderTask, overlay_script, render, transparent_png
from tests.media_files import needs_ffmpeg

W, H = 1080, 1920


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def lavfi_video(path: Path, graph: str, audio: str | None = None) -> Path:
    args = ["-f", "lavfi", "-i", graph]
    if audio:
        args += ["-f", "lavfi", "-i", audio, "-c:a", "aac", "-shortest"]
    ffmpeg(*args, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
    return path


def add(library: Library, path: Path, name: str, ai: bool = False) -> dict[str, Any]:
    return library.add_clip(path, "upload", ClipMetadata(name=name, ai_generated=ai))


def clip(item: dict[str, Any], start: float, duration: float, **extra: Any) -> dict[str, Any]:
    base = {"id": f"c-{item['id']}-{start}", "mediaId": item["id"], "start": start, "duration": duration,
            "inPoint": 0, "speed": 1, "cropX": 0.5, "cropY": 0.5, "fit": "fill", "keepAudio": False, "volume": 0.5}
    return {**base, **extra}


def voiceover(project_dir: Path, seconds: float, frequency: int = 440) -> dict[str, Any]:
    media = project_dir / "media"
    media.mkdir(parents=True, exist_ok=True)
    name = f"voiceover-{frequency}-{seconds}.wav"
    ffmpeg("-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}:sample_rate=48000",
           "-ac", "1", "-c:a", "pcm_s16le", str(media / name))
    return {"source": "upload", "file": name, "duration": seconds}


def project(project_id: str, **fields: Any) -> dict[str, Any]:
    return {
        "id": project_id,
        "name": "Test: render?",
        "voiceover": None,
        "mix": {"voiceVolume": 1, "musicVolume": 0.15, "music": None},
        "clips": [],
        "captions": {"enabled": True, "words": [], "voiceoverFile": None},
        "canvas": {"background": {"mode": "blur", "color": "#000000", "blur": 40}},
        **fields,
    }


def probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def frame_at(path: Path, seconds: float) -> np.ndarray:
    """The output picture at `seconds`, as a 1920x1080x3 RGB array."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{seconds:.4f}", "-i", str(path), "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(int)


def colour(pixel: np.ndarray) -> str:
    r, g, b = (int(v) for v in pixel)
    if r > 180 and g < 70 and b > 180:
        return "magenta"
    if r > 180 and g < 70 and b < 70:
        return "red"
    if g > 100 and r < 70 and b < 70:
        return "green"
    if b > 180 and r < 70 and g < 70:
        return "blue"
    if r > 200 and g > 200 and b > 200:
        return "white"
    if r < 25 and g < 25 and b < 25:
        return "black"
    return f"other{(r, g, b)}"


def rms_db(path: Path, start: float, seconds: float) -> float:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(seconds), "-i", str(path), "-vn",
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    line = next(line for line in result.stderr.splitlines() if "mean_volume" in line)
    return float(line.split("mean_volume:")[1].split("dB")[0])


def box_overlay(path: Path, x: int, y: int, size: int, color: str = "white") -> Path:
    ffmpeg("-f", "lavfi", "-i", f"color=c=black@0.0:s={W}x{H},format=rgba",
           "-vf", f"drawbox=x={x}:y={y}:w={size}:h={size}:color={color}@1.0:t=fill:replace=1", "-frames:v", "1", str(path))
    return path


@pytest.fixture
def library(settings: Settings) -> Library:
    return Library(settings.library_dir)


@pytest.fixture
def clips(tmp_path: Path, library: Library) -> dict[str, dict[str, Any]]:
    src = tmp_path / "src"
    src.mkdir()
    return {
        # Landscape, 24 fps: red left half, blue right half.
        "split": add(library, lavfi_video(
            src / "split.mp4", "color=red:s=320x360:r=24:d=3[l];color=blue:s=320x360:r=24:d=3[r];[l][r]hstack"), "Split"),
        # Portrait 9:16, 25 fps: red for 2 s, then green.
        "timed": add(library, lavfi_video(
            src / "timed.mp4", "color=red:s=360x640:r=25:d=2[a];color=0x00c000:s=360x640:r=25:d=2[b];[a][b]concat"), "Timed"),
        # Full HD portrait, 30 fps, blue, with a 1 kHz tone.
        "blue": add(library, lavfi_video(
            src / "blue.mp4", "color=blue:s=1080x1920:r=30:d=3", "sine=frequency=1000:duration=3:sample_rate=48000"),
            "Blue", ai=True),
    }


def run_render(settings: Settings, data: dict[str, Any], library: Library, overlays: list[Overlay],
               tmp_path: Path, task: RenderTask | None = None) -> Path:
    plan = make_plan(data, library.list(), library.root)
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    output = output_path(settings.exports_dir, data["name"])
    media = settings.projects_dir / data["id"] / "media"
    return render(data, plan, media, overlays, work, encoders.BEST, output, task or RenderTask(), lambda p: None)


@needs_ffmpeg
def test_render_matches_the_timeline(settings: Settings, library: Library, clips, tmp_path: Path) -> None:
    split, timed, blue = clips["split"], clips["timed"], clips["blue"]
    vo = voiceover(settings.projects_dir / "p-render", 6.0)
    data = project(
        "p-render",
        voiceover=vo,
        clips=[
            clip(split, 0, 1.5, cropX=0),                    # Fill, crop at the left: all red
            # 1.5-2.0: a gap (black)
            clip(timed, 2.0, 1.0, inPoint=1, speed=2),       # source 1-3 s: red, green from 2.5 s
            clip(split, 3.0, 2.0, fit="inside"),             # Fit inside over a solid background
            clip(blue, 5.0, 2.0, keepAudio=True, volume=1),  # runs past the voiceover's end
        ],
    )
    data["canvas"]["background"] = {"mode": "color", "color": "#ff00ff", "blur": 40}
    box = box_overlay(tmp_path / "box.png", 100, 200, 200)
    out = run_render(settings, data, library, [Overlay(30, 60, box)], tmp_path)

    assert out == settings.exports_dir / "Test render" / "Test render.mp4"
    info = probe(out)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"], video["pix_fmt"]) == ("h264", W, H, "yuv420p")
    assert video["r_frame_rate"] == "30/1"  # 24, 25 and 30 fps clips: 30 fps out
    assert int(video["nb_frames"]) == 180
    assert (audio["codec_name"], audio["sample_rate"], audio["channels"]) == ("aac", "48000", 2)
    assert abs(float(info["format"]["duration"]) - 6.0) < 0.05
    head = out.read_bytes()[:200_000]
    assert 0 <= head.find(b"moov") < head.find(b"mdat")  # faststart

    first = frame_at(out, 0.5)
    assert colour(first[960, 540]) == "red" and colour(first[300, 200]) == "red"
    boxed = frame_at(out, 1.2)
    assert colour(boxed[300, 200]) == "white"  # the overlay, at its frames only
    assert colour(boxed[960, 540]) == "red"
    assert colour(frame_at(out, 1.75)[960, 540]) == "black"  # the gap
    assert colour(frame_at(out, 2.2)[960, 540]) == "red"  # trimmed 1 s in, double speed
    assert colour(frame_at(out, 2.7)[960, 540]) == "green"  # source 2.4 s
    inside = frame_at(out, 3.5)
    assert colour(inside[100, 540]) == "magenta" and colour(inside[1800, 540]) == "magenta"
    assert colour(inside[960, 200]) == "red" and colour(inside[960, 900]) == "blue"
    assert colour(frame_at(out, 5.5)[960, 540]) == "blue"
    # The clip's own audio plays under the voiceover from 5 s on.
    assert rms_db(out, 5.2, 0.6) > rms_db(out, 0.2, 0.6) + 2


@needs_ffmpeg
def test_blurred_background_and_shared_frame_rate(settings: Settings, library: Library, tmp_path: Path) -> None:
    src = tmp_path / "src25"
    src.mkdir()
    wide = add(library, lavfi_video(src / "wide.mp4", "color=red:s=640x360:r=25:d=2"), "Wide 25")
    tall = add(library, lavfi_video(src / "tall.mp4", "color=blue:s=360x640:r=25:d=2"), "Tall 25")
    data = project("p-blur", voiceover=voiceover(settings.projects_dir / "p-blur", 3.0),
                   clips=[clip(wide, 0, 1.5, fit="inside"), clip(tall, 1.5, 1.5)])
    out = run_render(settings, data, library, [], tmp_path)
    video = next(s for s in probe(out)["streams"] if s["codec_type"] == "video")
    assert video["r_frame_rate"] == "25/1"  # every clip is 25 fps, so the video is too
    frame = frame_at(out, 0.5)
    # Above the picture: the clip itself, blurred (red), not black.
    assert colour(frame[100, 540]) == "red"
    assert colour(frame[960, 540]) == "red"
    assert colour(frame_at(out, 2.0)[960, 540]) == "blue"


@needs_ffmpeg
def test_cancel_deletes_the_partial_file(settings: Settings, library: Library, clips, tmp_path: Path) -> None:
    data = project("p-cancel", voiceover=voiceover(settings.projects_dir / "p-cancel", 30.0),
                   clips=[clip(clips["blue"], 0, 30)])
    task = RenderTask()
    timer = __import__("threading").Timer(0.5, task.cancel)
    timer.start()
    with pytest.raises(Exception) as caught:
        run_render(settings, data, library, [], tmp_path, task)
    assert type(caught.value).__name__ == "Cancelled"
    assert not list(settings.exports_dir.rglob("*.mp4"))


def wait(client, job: dict[str, Any]) -> dict[str, Any]:
    for _ in range(600):
        job = client.get(f"/api/jobs/{job['id']}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    return job


@needs_ffmpeg
def test_render_api_checks_renders_and_reports(client, settings: Settings, library: Library, clips, tmp_path: Path) -> None:
    vo = voiceover(settings.projects_dir / "p-api", 2.0)
    data = project("p-api", name="API short", voiceover=vo,
                   clips=[clip(clips["blue"], 0, 1.0), clip(clips["split"], 1.2, 1.2)],
                   captions={"enabled": True, "words": [{"id": "w", "text": "Hi", "start": 0, "end": 0.5}],
                             "voiceoverFile": "voiceover-old.wav"})
    report = client.post("/api/render/check", json={"project": data}).json()
    assert report["fps"] == {"num": 30, "den": 1, "label": "30"}
    assert report["frames"] == 60
    assert report["blockers"] == []
    assert report["containsAi"] is True
    assert [q["id"] for q in report["qualities"]][0] == "best"
    kinds = {w["kind"] for w in report["warnings"]}
    assert kinds == {"gaps", "past-voiceover", "captions-stale", "low-res"}

    box = box_overlay(tmp_path / "o.png", 0, 0, 50).read_bytes()
    manifest = [{"first": 0, "end": 10, "size": len(box)}, {"first": 20, "end": 30, "size": len(box)}]
    request = {"project": data, "quality": "best", "fps": {"num": 30, "den": 1}, "frames": 60}
    started = client.post("/api/render", data={"request": json.dumps(request), "manifest": json.dumps(manifest)},
                          files={"overlays": ("overlays.bin", box + box, "application/octet-stream")})
    assert started.status_code == 200, started.text
    job = started.json()
    job = wait(client, job)
    assert job["status"] == "done", job
    result = job["result"]
    assert result["name"] == "API short.mp4" and result["containsAi"] is True
    assert Path(result["file"]).is_file()
    assert abs(result["duration"] - 2.0) < 0.05
    frame = frame_at(Path(result["file"]), 0.1)
    assert colour(frame[25, 25]) == "white"

    # A second render keeps the first one.
    again = client.post("/api/render", data={"request": json.dumps(request), "manifest": "[]"})
    assert again.status_code == 200
    assert wait(client, again.json())["result"]["name"] == "API short (2).mp4"
    # A stale frame count is refused.
    stale = client.post("/api/render", data={"request": json.dumps({**request, "frames": 61}), "manifest": "[]"})
    assert stale.status_code == 409


# Plan and checks, without FFmpeg ----------------------------------------------------------------


def _items(*rates: float | None) -> list[dict[str, Any]]:
    return [{"id": f"m{i}", "kind": "video" if rate else "image", "fps": rate, "file": f"m{i}.mp4",
             "width": 1080, "height": 1920, "name": f"Clip {i}"} for i, rate in enumerate(rates)]


def test_output_frame_rate() -> None:
    def fps(*rates: float | None) -> Fraction:
        items = _items(*rates)
        return output_fps([{"mediaId": item["id"]} for item in items], {item["id"]: item for item in items})

    assert fps(24, 25, 30) == 30
    assert fps(25, 25.0, None) == 25  # images don't count
    assert fps(29.97, 29.97) == Fraction(30000, 1001)
    assert fps(24, 24) == 24
    assert fps(60, 60) == 60
    assert fps(12, 12) == 30  # not a standard rate
    assert fps(None) == 30


def test_checks_warn_but_do_not_block(tmp_path: Path) -> None:
    items = _items(30, 30)
    items[1].update(width=640, height=360, name="Small")
    (tmp_path / "clips").mkdir()
    for item in items:
        (tmp_path / "clips" / item["file"]).write_bytes(b"x")
    media = tmp_path / "media"
    media.mkdir()
    (media / "voiceover-a.wav").write_bytes(b"x")
    data = project(
        "p", voiceover={"file": "voiceover-a.wav", "duration": 200.0},
        clips=[clip(items[0], 0, 2), clip(items[1], 3, 2), clip({"id": "gone"}, 6, 1), clip(items[0], 199, 3)],
        captions={"enabled": True, "words": [{"text": "a", "start": 0, "end": 1}], "voiceoverFile": "voiceover-b.wav"},
    )
    plan = make_plan(data, items, tmp_path)
    warnings, blockers = checks(data, plan, items, media)
    assert blockers == []
    by_kind = {w["kind"]: w["message"] for w in warnings}
    assert set(by_kind) == {"gaps", "past-voiceover", "captions-stale", "missing-media", "low-res", "too-long"}
    assert "0:02.00–0:03.00" in by_kind["gaps"] and "0:07.00–3:19.00" in by_kind["gaps"]
    assert "3:20.00" in by_kind["past-voiceover"]
    assert "“Small” (640×360, scaled up 5.3×)" in by_kind["low-res"]
    assert "deleted from the library" in by_kind["missing-media"]
    assert "3:20 long" in by_kind["too-long"]


def test_checks_block_without_a_voiceover(tmp_path: Path) -> None:
    data = project("p")
    _, blockers = checks(data, make_plan(data, [], tmp_path), [], tmp_path)
    assert len(blockers) == 2


def test_output_names(tmp_path: Path) -> None:
    assert safe_name('My: "best" short?') == "My best short"
    assert safe_name("  ") == "Untitled short"
    assert safe_name("con") == "con video"
    first = output_path(tmp_path, "Top 5")
    assert first == tmp_path / "Top 5" / "Top 5.mp4"
    first.parent.mkdir()
    first.write_bytes(b"")
    assert output_path(tmp_path, "Top 5").name == "Top 5 (2).mp4"
    assert timecode(75.456) == "1:15.45"


def test_overlay_script_places_frames_exactly(tmp_path: Path) -> None:
    blank = transparent_png(tmp_path / "blank.png", 4, 4)
    a, b = tmp_path / "a.png", tmp_path / "b.png"
    script = overlay_script([Overlay(3, 10, a), Overlay(10, 12, b)], 30, Fraction(30), blank)
    durations = [line for line in script.splitlines() if line.startswith("duration")]
    assert durations == ["duration 0.100000000", "duration 0.233333333", "duration 0.066666667", "duration 0.600000000"]
