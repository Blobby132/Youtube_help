"""Search words for a sentence: its nouns (with compounds kept together, "airplane window"),
then its verbs, picked with spaCy's English model, which the voiceover already installs."""

from __future__ import annotations

import threading
from collections import Counter
from functools import lru_cache

import spacy
from spacy.language import Language
from spacy.tokens import Token

# Nouns that say nothing about what to show.
GENERIC_NOUNS = frozenset(
    """
    thing way lot kind type part time people person something everything anything nothing number top
    bit fact reason day year hour minute second mile world video today one place end point case idea
    question answer example percent amount rest side area half couple ton version list stuff matter
    """.split()
)
# Verbs too common to search for.
GENERIC_VERBS = frozenset(
    """
    be have do make get keep call say go know think see come take want look use find give tell
    become seem let put mean need show try feel leave turn start happen let begin include help
    """.split()
)
NOUNS = ("NOUN", "PROPN")

_lock = threading.Lock()


@lru_cache(maxsize=1)
def _load() -> Language:
    # The parser is needed for compounds; named entities aren't.
    return spacy.load("en_core_web_sm", disable=["ner"])


def nlp() -> Language:
    with _lock:
        return _load()


def _usable(token: Token) -> bool:
    return token.is_alpha and len(token.text) >= 3 and not token.is_stop


def _word(token: Token) -> str:
    return token.text if token.pos_ == "PROPN" else token.lemma_.lower()


def keywords(sentence: str) -> list[str]:
    """Nouns first (in order, compounds joined), then verbs. "Every airplane window has a tiny
    hole in it." -> ["airplane window", "hole"]."""
    doc = nlp()(sentence)
    joined: set[int] = set()
    nouns: list[str] = []
    for token in doc:
        if token.pos_ not in NOUNS or token.i in joined or not _usable(token):
            continue
        if token.dep_ in ("compound", "amod") and token.head.pos_ in NOUNS and token.head.i > token.i:
            continue  # it's part of the phrase its head noun starts
        parts = [
            child
            for child in token.lefts
            if child.pos_ in NOUNS and child.dep_ in ("compound", "amod") and _usable(child)
        ]
        joined.update(child.i for child in parts)
        if _word(token) in GENERIC_NOUNS and not parts:
            continue
        phrase = " ".join([*(_word(c) for c in parts), _word(token)])
        if phrase not in nouns:
            nouns.append(phrase)
    verbs = []
    for token in doc:
        if token.pos_ == "VERB" and _usable(token) and token.lemma_.lower() not in GENERIC_VERBS:
            word = token.lemma_.lower()
            if word not in verbs and all(word not in n.split() for n in nouns):
                verbs.append(word)
    return nouns + verbs


def queries(words: list[str]) -> list[str]:
    """Searches to try, most specific first: two keywords together, then each on its own."""
    chain: list[str] = []
    if len(words) >= 2 and len(f"{words[0]} {words[1]}".split()) <= 3:
        chain.append(f"{words[0]} {words[1]}")
    chain.extend(words[:3])
    return list(dict.fromkeys(chain))


def topic(text: str) -> list[str]:
    """The script's most frequent nouns, a fallback for sentences that name nothing."""
    counts = Counter(
        _word(t) for t in nlp()(text) if t.pos_ in NOUNS and _usable(t) and _word(t) not in GENERIC_NOUNS
    )
    return [word for word, count in counts.most_common(3) if count >= 2] or [w for w, _ in counts.most_common(1)]
