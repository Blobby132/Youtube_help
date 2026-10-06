"""Gives the script's own words the timings Whisper heard.

Whisper writes what it hears ("RX9060XD", "16 GB", "35 ,000"), while captions should show
what you wrote ("RX 9060 XT", "16GB", "35,000"). The script and the transcript are lined up
character by character (letters and digits only), so differences in spacing, punctuation
and casing don't matter. Each script word takes its time from the characters that matched;
words with no match ("two" read as "2") are spread over the gap between their neighbours.
"""

from __future__ import annotations

import re
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


def align_to_script(script: str, transcript: list[TimedWord]) -> tuple[list[TimedWord], float]:
    """Returns the script's words with timings, and the share of script characters matched."""
    tokens = script_words(script)
    if not tokens or not transcript:
        return [], 0.0

    # Characters of the transcript with the time span each one covers.
    t_chars: list[str] = []
    t_spans: list[tuple[float, float]] = []
    for word in transcript:
        letters = _chars(word.text)
        step = (word.end - word.start) / max(1, len(letters))
        for k, c in enumerate(letters):
            t_chars.append(c)
            t_spans.append((word.start + k * step, word.start + (k + 1) * step))

    s_chars: list[str] = []
    s_owner: list[int] = []
    for index, token in enumerate(tokens):
        for c in _chars(token):
            s_chars.append(c)
            s_owner.append(index)
    if not s_chars:
        return [], 0.0

    matcher = SequenceMatcher(None, "".join(s_chars), "".join(t_chars), autojunk=False)
    spans: list[tuple[float, float] | None] = [None] * len(tokens)
    matched = 0
    for a, b, size in matcher.get_matching_blocks():
        matched += size
        for k in range(size):
            owner = s_owner[a + k]
            start, end = t_spans[b + k]
            current = spans[owner]
            spans[owner] = (start, end) if current is None else (min(current[0], start), max(current[1], end))

    # A word whose letters matched far apart (alignment noise) is treated as unmatched.
    for index, span in enumerate(spans):
        if span and span[1] - span[0] > max(2.0, 0.25 * len(tokens[index])):
            spans[index] = None

    timed = _fill_gaps(tokens, spans, transcript[0].start, transcript[-1].end)
    return tidy(timed), matched / len(s_chars)


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
