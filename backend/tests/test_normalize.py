from __future__ import annotations

import pytest

from app.voiceover.normalize import normalize_text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # units glued to numbers
        ("16GB of VRAM", "16 gigabytes of VRAM"),
        ("draws 450W, runs at 2.5GHz", "draws 450 watts, runs at two point five gigahertz"),
        ("1 GB", "1 gigabyte"),
        ("a 5000mAh battery", "a 5000 milliamp hour battery"),
        ("3nm chips", "3 nanometer chips"),
        ("200 km away", "200 kilometers away"),
        ("a 144Hz screen", "a 144 hertz screen"),
        # single-letter units only when attached
        ("12V rail", "12 volt rail"),
        ("Plan 5 V", "Plan 5 V"),
        # resolutions misaki reads as plain numbers
        ("720p and 480p", "seven twenty p and four eighty p"),
        ("1080p", "1080p"),
        # product codes
        ("i9-14900K", "i9 14 900K"),
        ("GPT-4", "GPT 4"),
        # ranges, times, ratios, list numbers, multipliers
        ("5-10 minutes", "5 to 10 minutes"),
        ("at 3:30 PM", "at three thirty P M"),
        ("at 10:05", "at ten oh five"),
        ("at 7:00", "at seven o'clock"),
        ("9:16 video", "9 by 16 video"),
        ("#1 on the list", "number 1 on the list"),
        ("2x faster", "2 times faster"),
        # money and big counts
        ("$1.5B", "one point five billion dollars"),
        ("€5 million", "5 million euros"),
        ("1M subscribers", "1 million subscribers"),
        ("10K views", "10 thousand views"),
        ("a 4K TV", "a 4K TV"),
        # misc
        ("w/ friends, w/o fees", "with friends, without fees"),
        ("I love it 😂🔥 so much", "I love it so much"),
        ("EPYC chips", "[EPYC](/ˈɛpɪk/) chips"),
    ],
)
def test_normalize(text: str, expected: str) -> None:
    assert normalize_text(text) == expected


def test_dates_are_not_ranges() -> None:
    assert normalize_text("on 2024-05-01") == "on 2024-05-01"


# --- decimals ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("PCIe 5.0", "PCIe five point zero"),
        ("It costs 2.50 now", "It costs two point five zero now"),
        ("It is 5.0.", "It is five point zero."),
        ("only 0.75 left", "only zero point seven five left"),
        ("1,234.5 views", "one thousand two hundred thirty-four point five views"),
        ("v2.0", "v two point zero"),
        ("2.5GHz", "two point five gigahertz"),
        ("1.5x faster", "one point five times faster"),
        ("2.5-3.5 hours", "two point five to three point five hours"),
        # left alone: money (misaki says dollars and cents), dotted versions, plain integers
        ("$2.50", "$2.50"),
        ("version 3.14.6", "version 3.14.6"),
        ("1.2.3", "1.2.3"),
        ("5 apples", "5 apples"),
    ],
)
def test_decimals_are_read_in_full(text: str, expected: str) -> None:
    assert normalize_text(text) == expected


# --- pronunciation overrides --------------------------------------------------------------

from app.voiceover.normalize import Pronunciation, normalize_for_speech  # noqa: E402

ENTRIES = [
    Pronunciation("5.0", "five point oh"),
    Pronunciation("GHz", "gigahertz"),
    Pronunciation("Kokoro", "koh koh roh"),
]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # an entry beats the default reading ("five point zero")
        ("PCIe 5.0 is here.", "PCIe five point oh is here."),
        ("It is 5.0.", "It is five point oh."),
        ("v5.0", "v five point oh"),
        # glued to a number, and the number around it still gets the default rules
        ("Runs at 2.5GHz", "Runs at two point five gigahertz"),
        ("Runs at 5.0 GHz", "Runs at five point oh gigahertz"),
        # whole terms only
        ("15.0 and 5.01", "fifteen point zero and five point zero one"),
        ("Kokoros", "Kokoros"),
        # case-sensitive
        ("ghz", "ghz"),
    ],
)
def test_pronunciations_override_the_defaults(text: str, expected: str) -> None:
    assert normalize_for_speech(text, ENTRIES) == expected


def test_spoken_text_is_not_normalized_again() -> None:
    # Your spoken text goes to Kokoro as written, even if it has digits in it.
    assert normalize_for_speech("max x set", [Pronunciation("x", "3.0")]) == "max 3.0 set"


def test_longest_term_wins_and_last_duplicate_wins() -> None:
    entries = [
        Pronunciation("RTX", "R T X"),
        Pronunciation("RTX 4090", "the big one"),
        Pronunciation("GPU", "first"),
        Pronunciation("GPU", "G P U"),
    ]
    assert normalize_for_speech("An RTX 4090 GPU", entries) == "An the big one G P U"


def test_incomplete_entries_are_ignored() -> None:
    entries = [Pronunciation("", "nothing"), Pronunciation("5.0", "  "), Pronunciation("  ", "")]
    assert normalize_for_speech("PCIe 5.0", entries) == "PCIe five point zero"


def test_a_huge_hand_edited_list_does_not_break_reading() -> None:
    entries = [Pronunciation(f"term{i}", f"spoken {i}") for i in range(7000)] + [Pronunciation("5.0", "five point oh")]
    assert "five point" in normalize_for_speech("PCIe 5.0", entries)
