"""Kokoro engine: provider selection and DirectML -> CPU fallback, using a fake ONNX Runtime."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import pytest

from app.voiceover.assets import KOKORO_MODEL, KOKORO_VOICES
from app.voiceover.kokoro import VOCAB, KokoroEngine, tokenize


class FakeInput:
    def __init__(self, name: str, type_: str) -> None:
        self.name, self.type = name, type_


def make_fake_ort(available: list[str], fail_create_on: set[str] = frozenset(), fail_run_on: set[str] = frozenset()):
    calls: list[dict] = []

    class SessionOptions:
        enable_mem_pattern = True
        execution_mode = None

    class InferenceSession:
        def __init__(self, path, sess_options=None, providers=()):
            first = providers[0]
            if first in fail_create_on:
                raise RuntimeError(f"cannot create {first}")
            self.providers = list(providers)

        def get_providers(self):
            return self.providers

        def get_inputs(self):
            return [FakeInput("tokens", "tensor(int64)"), FakeInput("style", "tensor(float)"), FakeInput("speed", "tensor(float)")]

        def run(self, _outputs, inputs):
            if self.providers[0] in fail_run_on:
                raise RuntimeError(f"{self.providers[0]} crashed")
            calls.append(inputs)
            return [np.zeros(2400 * inputs["tokens"].shape[1], dtype=np.float32)]

    module = types.SimpleNamespace(
        get_available_providers=lambda: available,
        InferenceSession=InferenceSession,
        SessionOptions=SessionOptions,
        ExecutionMode=types.SimpleNamespace(ORT_SEQUENTIAL="sequential"),
    )
    return module, calls


@pytest.fixture
def model_dir(tmp_path: Path) -> Path:
    (tmp_path / KOKORO_MODEL.name).write_bytes(b"fake")
    styles = np.arange(510 * 256, dtype=np.float32).reshape(510, 1, 256)
    with (tmp_path / KOKORO_VOICES.name).open("wb") as f:
        np.savez(f, af_heart=styles)
    return tmp_path


def use_ort(monkeypatch: pytest.MonkeyPatch, module) -> None:
    monkeypatch.setitem(sys.modules, "onnxruntime", module)


def test_tokenize_drops_unknown_symbols() -> None:
    assert tokenize("hˈɛlO ❓") == [VOCAB[c] for c in "hˈɛlO "]


def test_cpu_by_default(model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ort, calls = make_fake_ort(["DmlExecutionProvider", "CPUExecutionProvider"])
    use_ort(monkeypatch, ort)
    engine = KokoroEngine(model_dir)
    audio = engine.synthesize("hˈɛlO", "af_heart", 1.1)
    assert engine.provider == "CPUExecutionProvider"
    assert audio.dtype == np.float32 and audio.ndim == 1
    inputs = calls[0]
    tokens = tokenize("hˈɛlO")
    assert inputs["tokens"].tolist() == [[0, *tokens, 0]]
    # The style vector is picked by the number of phoneme tokens.
    assert inputs["style"][0, 0] == len(tokens) * 256
    assert inputs["speed"].tolist() == pytest.approx([1.1])


def test_directml_used_when_available(model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ort, _ = make_fake_ort(["DmlExecutionProvider", "CPUExecutionProvider"])
    use_ort(monkeypatch, ort)
    engine = KokoroEngine(model_dir, device="directml")
    engine.load()
    assert engine.provider == "DmlExecutionProvider"
    assert engine.provider_label == "DirectML (GPU)"


def test_directml_missing_falls_back_to_cpu(model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ort, _ = make_fake_ort(["CPUExecutionProvider"])
    use_ort(monkeypatch, ort)
    engine = KokoroEngine(model_dir, device="directml")
    engine.load()
    assert engine.provider == "CPUExecutionProvider"


def test_directml_load_failure_falls_back_to_cpu(model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ort, _ = make_fake_ort(["DmlExecutionProvider", "CPUExecutionProvider"], fail_create_on={"DmlExecutionProvider"})
    use_ort(monkeypatch, ort)
    engine = KokoroEngine(model_dir, device="directml")
    engine.load()
    assert engine.provider == "CPUExecutionProvider"


def test_directml_inference_failure_retries_on_cpu(model_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ort, calls = make_fake_ort(["DmlExecutionProvider", "CPUExecutionProvider"], fail_run_on={"DmlExecutionProvider"})
    use_ort(monkeypatch, ort)
    engine = KokoroEngine(model_dir, device="directml")
    audio = engine.synthesize("hˈɛlO", "af_heart")
    assert engine.provider == "CPUExecutionProvider"
    assert len(calls) == 1 and audio.size > 0


def test_missing_model_files_have_a_clear_error(tmp_path: Path) -> None:
    with pytest.raises(Exception, match="npm run setup"):
        KokoroEngine(tmp_path).load()


def test_chunks_are_trimmed_and_joined_with_pauses() -> None:
    from app.voiceover.kokoro import SAMPLE_RATE
    from app.voiceover.service import LEAD_IN, SENTENCE_PAUSE, TAIL, join_chunks, trim_silence

    tone = 0.5 * np.sin(np.linspace(0, 200 * np.pi, SAMPLE_RATE // 2)).astype(np.float32)
    padded = np.concatenate([np.zeros(SAMPLE_RATE // 2, np.float32), tone, np.zeros(SAMPLE_RATE // 2, np.float32)])
    trimmed = trim_silence(padded)
    assert len(tone) <= len(trimmed) < len(tone) + 0.1 * SAMPLE_RATE

    joined = join_chunks([("hˈɛlO.", padded), ("wˈɜɹld.", padded)], speed=1.0)
    expected = 2 * len(trimmed) + int((LEAD_IN + SENTENCE_PAUSE + TAIL) * SAMPLE_RATE)
    assert abs(len(joined) - expected) <= 3
