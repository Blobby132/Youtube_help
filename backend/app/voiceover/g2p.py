"""Script text -> Kokoro phoneme chunks.

Pipeline: your pronunciation entries + normalize_text (units, decimals, ranges, times, ...)
-> misaki G2P (lexicon with
part-of-speech aware heteronyms, espeak-ng for unknown words) -> chunks that fit the
model's 510-token context, split at sentence ends where possible.
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass

from collections.abc import Iterable

from app.voiceover.normalize import Pronunciation, normalize_for_speech

log = logging.getLogger("shorts.tts")

# Kokoro's context is 512 tokens including the two padding tokens. Chunks aim for a couple
# of sentences: long enough for natural intonation, short enough for steady progress updates,
# and long sentences still split at a comma rather than mid-phrase.
MAX_CHUNK = 510
SOFT_CHUNK = 300

_SENTENCE_END = frozenset(".!?…")
_CLAUSE_END = frozenset(",;:—")


@dataclass(frozen=True)
class PhonemeToken:
    text: str
    phonemes: str
    whitespace: bool


class Phonemizer:
    """Wraps misaki's English G2P. Loading spaCy takes a second, so it happens once, lazily."""

    def __init__(self, british: bool) -> None:
        self.british = british
        self._g2p = None
        self._lock = threading.Lock()

    def _load(self):
        if self._g2p is None:
            from app.voiceover.misaki import en, espeak

            log.info("Loading %s English G2P (misaki + spaCy)", "British" if self.british else "American")
            self._g2p = en.G2P(
                trf=False,
                british=self.british,
                fallback=espeak.EspeakFallback(british=self.british),
                unk="",
            )
        return self._g2p

    def tokens(self, text: str) -> list[PhonemeToken]:
        with self._lock:
            g2p = self._load()
            _, tokens = g2p(text)
        return [
            PhonemeToken(tk.text, tk.phonemes or "", bool(tk.whitespace))
            for tk in tokens
        ]

    def phonemize(self, text: str, pronunciations: Iterable[Pronunciation] = ()) -> str:
        """Whole text as one phoneme string (no chunking); handy for tests and debugging."""
        tokens = self.tokens(normalize_for_speech(text, pronunciations))
        return "".join(t.phonemes + (" " if t.whitespace else "") for t in tokens).strip()

    def chunks(self, text: str, pronunciations: Iterable[Pronunciation] = ()) -> list[str]:
        """Normalized, phonemized chunks of at most MAX_CHUNK phonemes each."""
        chunks: list[str] = []
        for paragraph in split_paragraphs(normalize_for_speech(text, pronunciations)):
            chunks.extend(pack_tokens(self.tokens(paragraph)))
        return chunks


def split_paragraphs(text: str) -> list[str]:
    """Paragraphs are read separately; each one gets a closing period so it ends with a pause."""
    paragraphs = []
    for part in re.split(r"\n\s*\n|\n", text):
        part = part.strip()
        if not part:
            continue
        if part[-1] not in _SENTENCE_END and part[-1] not in "\"”')":
            part += "."
        paragraphs.append(part)
    return paragraphs


def _boundary(phonemes: str) -> int:
    """2 after a sentence end, 1 after a clause end, else 0."""
    last = phonemes.strip()[-1:] if phonemes.strip() else ""
    return 2 if last in _SENTENCE_END else 1 if last in _CLAUSE_END else 0


def pack_tokens(tokens: list[PhonemeToken]) -> list[str]:
    """Groups tokens into chunks, preferring to cut after a sentence, then after a clause."""
    chunks: list[str] = []
    current: list[tuple[str, int]] = []  # (phonemes + trailing space, boundary)
    length = 0

    def cut_point() -> int:
        for level in (2, 1):
            for i in range(len(current) - 1, -1, -1):
                if current[i][1] == level:
                    return i + 1
        return 0

    for token in tokens:
        piece = token.phonemes + (" " if token.whitespace else "")
        if len(piece) > MAX_CHUNK:  # one enormous "word": hard-split it
            piece = piece[:MAX_CHUNK]
        if current and length + len(piece) > SOFT_CHUNK:
            cut = cut_point()
            if cut == 0 and length + len(piece) > MAX_CHUNK:
                cut = len(current)
            if cut:
                chunks.append("".join(p for p, _ in current[:cut]))
                current = current[cut:]
                length = sum(len(p) for p, _ in current)
        current.append((piece, _boundary(token.phonemes)))
        length += len(piece)

    if current:
        chunks.append("".join(p for p, _ in current))
    return [chunk.strip() for chunk in chunks if chunk.strip()]


_phonemizers: dict[bool, Phonemizer] = {}
_phonemizers_lock = threading.Lock()


def get_phonemizer(british: bool) -> Phonemizer:
    with _phonemizers_lock:
        if british not in _phonemizers:
            _phonemizers[british] = Phonemizer(british)
        return _phonemizers[british]
