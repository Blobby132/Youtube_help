from __future__ import annotations

import pytest

from app.voiceover.normalize import normalize_text


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # units glued to numbers
        ("16GB of VRAM", "16 gigabytes of VRAM"),
        ("draws 450W, runs at 2.5GHz", "draws 450 watts, runs at 2.5 gigahertz"),
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
        ("$1.5B", "1.5 billion dollars"),
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
