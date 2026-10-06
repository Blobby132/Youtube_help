"""Text-to-phoneme checks. These run without the Kokoro model (misaki + spaCy + espeak-ng only)."""

from __future__ import annotations

from app.voiceover.g2p import MAX_CHUNK, PhonemeToken, get_phonemizer, pack_tokens, split_paragraphs
from app.voiceover.kokoro import VOCAB

TECH_SENTENCE = "The RX 9060 XT has 16GB of VRAM and renders at 1080p."


def test_tech_sentence_american() -> None:
    phonemes = get_phonemizer(british=False).phonemize(TECH_SENTENCE)
    assert "ˌɑɹˈɛks" in phonemes  # "R X", spelled
    assert "nˈIndi sˈɪksti" in phonemes  # 9060 -> "ninety sixty"
    assert "ˌɛkstˈi" in phonemes  # "X T", spelled
    assert "sˌɪkstˈin ɡˈɪɡəbˌIts" in phonemes  # 16GB -> "sixteen gigabytes"
    assert "vˈiɹˌæm" in phonemes  # VRAM -> "vee-ram", not spelled
    assert "tˈɛn ˈATi pˈi" in phonemes  # 1080p -> "ten eighty p"
    assert all(p in VOCAB for p in phonemes), "every phoneme must exist in Kokoro's vocabulary"


def test_tech_sentence_british() -> None:
    phonemes = get_phonemizer(british=True).phonemize(TECH_SENTENCE)
    assert "nˈInti sˈɪksti" in phonemes
    assert "ɡˈɪɡəbIts" in phonemes
    assert "tˈɛn ˈAti pˈiː" in phonemes
    assert all(p in VOCAB for p in phonemes)


def test_heteronyms_follow_grammar() -> None:
    phonemes = get_phonemizer(british=False).phonemize("Read the book you read yesterday.")
    assert phonemes.startswith("ɹˈid")  # present tense "reed"
    assert "ju ɹˈɛd" in phonemes  # past tense "red"


def test_money_does_not_leak_into_next_number() -> None:
    phonemes = get_phonemizer(british=False).phonemize("Earned $5, 10 people came.")
    assert phonemes.count("dˈɑləɹz") == 1


def test_paragraphs_end_with_a_pause() -> None:
    assert split_paragraphs("First line\n\nSecond line!\nThird") == ["First line.", "Second line!", "Third."]


def test_long_text_is_chunked_at_sentence_ends() -> None:
    sentence = "This is a fairly ordinary sentence about airplane windows and tiny holes."
    chunks = get_phonemizer(british=False).chunks(" ".join([sentence] * 30))
    assert len(chunks) > 1
    assert all(len(c) <= MAX_CHUNK for c in chunks)
    assert all(c.endswith(".") for c in chunks)


def test_pack_tokens_hard_splits_without_punctuation() -> None:
    tokens = [PhonemeToken("word", "wˈɜɹd", True) for _ in range(200)]
    chunks = pack_tokens(tokens)
    assert len(chunks) > 1
    assert all(len(c) <= MAX_CHUNK for c in chunks)
    assert sum(c.count("wˈɜɹd") for c in chunks) == 200
