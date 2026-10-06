"""Kokoro-82M inference with ONNX Runtime.

CPU is the default. With TTS_DEVICE=directml and the onnxruntime-directml package, the
DirectML provider (any DirectX 12 GPU on Windows, including AMD Radeon) is tried first;
if it is missing, fails to load, or fails during inference, synthesis falls back to CPU.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

from app.core.errors import AppError
from app.voiceover.assets import KOKORO_MODEL, KOKORO_VOICES

log = logging.getLogger("shorts.tts")

SAMPLE_RATE = 24_000
MAX_TOKENS = 510

# Phoneme -> token id, from Kokoro-82M's config.json.
VOCAB: dict[str, int] = {
    ";": 1, ":": 2, ",": 3, ".": 4, "!": 5, "?": 6, "—": 9, "…": 10, '"': 11, "(": 12, ")": 13,
    "“": 14, "”": 15, " ": 16, "̃": 17, "ʣ": 18, "ʥ": 19, "ʦ": 20, "ʨ": 21, "ᵝ": 22,
    "ꭧ": 23, "A": 24, "I": 25, "O": 31, "Q": 33, "S": 35, "T": 36, "W": 39, "Y": 41, "ᵊ": 42,
    "a": 43, "b": 44, "c": 45, "d": 46, "e": 47, "f": 48, "h": 50, "i": 51, "j": 52, "k": 53,
    "l": 54, "m": 55, "n": 56, "o": 57, "p": 58, "q": 59, "r": 60, "s": 61, "t": 62, "u": 63,
    "v": 64, "w": 65, "x": 66, "y": 67, "z": 68, "ɑ": 69, "ɐ": 70, "ɒ": 71, "æ": 72, "β": 75,
    "ɔ": 76, "ɕ": 77, "ç": 78, "ɖ": 80, "ð": 81, "ʤ": 82, "ə": 83, "ɚ": 85, "ɛ": 86, "ɜ": 87,
    "ɟ": 90, "ɡ": 92, "ɥ": 99, "ɨ": 101, "ɪ": 102, "ʝ": 103, "ɯ": 110, "ɰ": 111, "ŋ": 112,
    "ɳ": 113, "ɲ": 114, "ɴ": 115, "ø": 116, "ɸ": 118, "θ": 119, "œ": 120, "ɹ": 123, "ɾ": 125,
    "ɻ": 126, "ʁ": 128, "ɽ": 129, "ʂ": 130, "ʃ": 131, "ʈ": 132, "ʧ": 133, "ʊ": 135, "ʋ": 136,
    "ʌ": 138, "ɣ": 139, "ɤ": 140, "χ": 142, "ʎ": 143, "ʒ": 147, "ʔ": 148, "ˈ": 156, "ˌ": 157,
    "ː": 158, "ʰ": 162, "ʲ": 164, "↓": 169, "→": 171, "↗": 172, "↘": 173, "ᵻ": 177,
}

PROVIDER_LABELS = {
    "CPUExecutionProvider": "CPU",
    "DmlExecutionProvider": "DirectML (GPU)",
}


def tokenize(phonemes: str) -> list[int]:
    return [VOCAB[p] for p in phonemes if p in VOCAB]


class KokoroEngine:
    def __init__(self, model_dir: Path, device: str = "cpu") -> None:
        self.model_path = model_dir / KOKORO_MODEL.name
        self.voices_path = model_dir / KOKORO_VOICES.name
        self.device = device
        self.provider: str | None = None
        self._session = None
        self._voices: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()

    @property
    def provider_label(self) -> str:
        return PROVIDER_LABELS.get(self.provider or "", self.provider or "not loaded")

    def load(self) -> None:
        with self._lock:
            if self._session is not None:
                return
            if not self.model_path.is_file() or not self.voices_path.is_file():
                raise AppError("The Kokoro model files are missing. Run `npm run setup` to download them.", 503)
            with np.load(self.voices_path) as voices:
                self._voices = {name: voices[name] for name in voices.files}
            self._session = self._create_session(prefer_gpu=self.device == "directml")

    def _create_session(self, prefer_gpu: bool):
        import onnxruntime as ort

        available = ort.get_available_providers()
        if prefer_gpu:
            if "DmlExecutionProvider" not in available:
                log.warning(
                    "TTS_DEVICE=directml, but ONNX Runtime has no DirectML provider (found: %s). "
                    "Run `npm run setup` after setting TTS_DEVICE=directml in .env. Using CPU.",
                    ", ".join(available),
                )
            else:
                options = ort.SessionOptions()
                # Required by DirectML: no memory pattern optimisation, sequential execution.
                options.enable_mem_pattern = False
                options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                try:
                    session = ort.InferenceSession(
                        str(self.model_path),
                        sess_options=options,
                        providers=["DmlExecutionProvider", "CPUExecutionProvider"],
                    )
                    self.provider = session.get_providers()[0]
                    log.info("Kokoro loaded on %s", self.provider_label)
                    return session
                except Exception:
                    log.exception("Could not load Kokoro with DirectML; falling back to CPU")

        session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
        self.provider = "CPUExecutionProvider"
        log.info("Kokoro loaded on CPU")
        return session

    def _inputs(self, tokens: list[int], style: np.ndarray, speed: float) -> dict[str, np.ndarray]:
        names = {i.name: i.type for i in self._session.get_inputs()}
        ids_name = "input_ids" if "input_ids" in names else "tokens"
        speed_dtype = np.int32 if names.get("speed") == "tensor(int32)" else np.float32
        return {
            ids_name: np.array([[0, *tokens, 0]], dtype=np.int64),
            "style": style.astype(np.float32),
            "speed": np.array([speed], dtype=speed_dtype),
        }

    def synthesize(self, phonemes: str, voice_id: str, speed: float = 1.0) -> np.ndarray:
        """One chunk of at most MAX_TOKENS phonemes -> mono float32 audio at SAMPLE_RATE."""
        self.load()
        voice = self._voices.get(voice_id)
        if voice is None:
            raise AppError(f"Unknown Kokoro voice: {voice_id}", 400)
        tokens = tokenize(phonemes)
        if not tokens:
            return np.zeros(0, dtype=np.float32)
        if len(tokens) > MAX_TOKENS:
            raise AppError(f"Text chunk too long for Kokoro ({len(tokens)} > {MAX_TOKENS} tokens)", 500)
        inputs = self._inputs(tokens, voice[len(tokens)], speed)
        try:
            audio = self._session.run(None, inputs)[0]
        except Exception:
            if self.provider == "CPUExecutionProvider":
                raise
            log.exception("Kokoro failed on %s; switching to CPU and retrying", self.provider_label)
            with self._lock:
                self._session = self._create_session(prefer_gpu=False)
            audio = self._session.run(None, self._inputs(tokens, voice[len(tokens)], speed))[0]
        return np.asarray(audio, dtype=np.float32).reshape(-1)
