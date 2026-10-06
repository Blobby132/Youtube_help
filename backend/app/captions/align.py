"""Gives the script's own words the timings Whisper heard.

Whisper writes what it hears ("RX9060XD", "16 GB", "35 ,000"), while captions should show
what you wrote ("RX 9060 XT", "16GB", "35,000"). The script and the transcript are lined up
character by character (letters and digits only), so differences in spacing, punctuation
and casing don't matter. Each script word takes its time from the characters that matched;
words with no match ("two" read as "2") are spread over the gap between their neighbours.
Words the pronunciation list changed are also matched by how they were said.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from difflib import SequenceMatcher

from app.captions.whisper import MIN_WORD_SECONDS, TimedWord, tidy

# misaki's pronunciation override: [Kokoro](/kˈOkəɹO/) is shown as "Kokoro".
_MARKUP = re.compile(r"\[([^\]]+)\]\([^)]*\)")
# Tokens that are only a dash or ellipsis stick to the previous word instead of becoming one.
_JOINERS = frozenset({"-", "–", "—", "…", "...", "--"})


def script_words(script: str) -> list[str]:
    words: list[str] = []
    for token in _MARKUP.sub(r"\1", script).split():
        if token in _JOINERS and words:
            words[-1] = f"{words[-1]} {token}"
        else:
            words.append(token)
    return words


def _chars(text: str) -> str:
    return "".join(c for c in text.lower() if c.isalnum())


def align_to_script(
    script: str,
    transcript: list[TimedWord],
    spoken: Callable[[str], str] | None = None,
) -> tuple[list[TimedWord], float]:
    """Returns the script's words with timings, and the share of their letters that matched.

    `spoken` tells how a script word was actually said, e.g. "5.0" -> "five point oh" from the
    pronunciation list. Each word is matched both as written and as spoken and keeps whichever
    matched more of its letters, so a substituted term is timed right whether Whisper writes
    "5.0" or "five point oh". The caption always shows the word as written.
    """
    tokens = script_words(script)
    if not tokens or not transcript:
        return [], 0.0
    t_text, t_spans = _transcript_chars(transcript)
    written = [_chars(token) for token in tokens]
    total = sum(len(w) for w in written)
    if not total:
        return [], 0.0

    spans, coverage = _match(written, t_text, t_spans)
    if spoken is not None:
        said = [_chars(_MARKUP.sub(r"\1", spoken(token))) for token in tokens]
        if said != written:
            said_spans, said_coverage = _match(said, t_text, t_spans)
            for i in range(len(tokens)):
                if said_coverage[i] > coverage[i]:
                    spans[i], coverage[i] = said_spans[i], said_coverage[i]

    # A word whose letters matched far apart (alignment noise) is treated as unmatched.
    for index, span in enumerate(spans):
        if span and span[1] - span[0] > max(2.0, 0.25 * len(tokens[index])):
            spans[index] = None

    timed = _fill_gaps(tokens, spans, transcript[0].start, transcript[-1].end)
    ratio = sum(coverage[i] * len(written[i]) for i in range(len(tokens))) / total
    return tidy(timed), ratio


def _transcript_chars(transcript: list[TimedWord]) -> tuple[str, list[tuple[float, float]]]:
    """Letters and digits of the transcript, with the time span each one covers."""
    chars: list[str] = []
    spans: list[tuple[float, float]] = []
    for word in transcript:
        letters = _chars(word.text)
        step = (word.end - word.start) / max(1, len(letters))
        for k, c in enumerate(letters):
            chars.append(c)
            spans.append((word.start + k * step, word.start + (k + 1) * step))
    return "".join(chars), spans


def _match(
    pieces: list[str],
    t_text: str,
    t_spans: list[tuple[float, float]],
) -> tuple[list[tuple[float, float] | None], list[float]]:
    """Lines up the pieces (one per script word) with the transcript letters. Returns each
    piece's time span and the share of its letters that found a partner."""
    owner = [index for index, piece in enumerate(pieces) for _ in piece]
    matcher = SequenceMatcher(None, "".join(pieces), t_text, autojunk=False)
    spans: list[tuple[float, float] | None] = [None] * len(pieces)
    matched = [0] * len(pieces)
    for a, b, size in matcher.get_matching_blocks():
        for k in range(size):
            index = owner[a + k]
            matched[index] += 1
            start, end = t_spans[b + k]
            current = spans[index]
            spans[index] = (start, end) if current is None else (min(current[0], start), max(current[1], end))
    coverage = [matched[i] / len(piece) if piece else 0.0 for i, piece in enumerate(pieces)]
    return spans, coverage


def _fill_gaps(
    tokens: list[str],
    spans: list[tuple[float, float] | None],
    first_start: float,
    last_end: float,
) -> list[TimedWord]:
    """Spreads unmatched words over the time between the matched words around them."""
    result: list[TimedWord] = []
    index = 0
    while index < len(tokens):
        span = spans[index]
        if span is not None:
            result.append(TimedWord(tokens[index], span[0], span[1]))
            index += 1
            continue
        run_end = index
        while run_end < len(tokens) and spans[run_end] is None:
            run_end += 1
        gap_start = result[-1].end if result else first_start
        next_span = spans[run_end] if run_end < len(tokens) else None
        gap_end = next_span[0] if next_span else last_end
        if gap_end - gap_start < MIN_WORD_SECONDS * (run_end - index):
            gap_end = gap_start + MIN_WORD_SECONDS * (run_end - index)
        weights = [max(1, len(_chars(t))) for t in tokens[index:run_end]]
        total = sum(weights)
        cursor = gap_start
        for token, weight in zip(tokens[index:run_end], weights, strict=True):
            length = (gap_end - gap_start) * weight / total
            result.append(TimedWord(token, cursor, cursor + length))
            cursor += length
        index = run_end
    return result
