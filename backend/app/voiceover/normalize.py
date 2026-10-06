"""Text normalization that runs before misaki's grapheme-to-phoneme step.

misaki already reads most numbers, years, ordinals, currency, acronyms and brand names
well ("RX 9060 XT" -> "R X ninety sixty X T", "1080p" -> "ten eighty p"). This module only
rewrites the patterns it reads badly, mostly units glued to numbers ("16GB", "450W",
"2.5GHz"), ranges, clock times, aspect ratios and a few words it mispronounces.
"""

from __future__ import annotations

import re

from num2words import num2words

# symbol -> (singular, plural)
UNITS: dict[str, tuple[str, str]] = {
    "PB": ("petabyte", "petabytes"),
    "TB": ("terabyte", "terabytes"),
    "GB": ("gigabyte", "gigabytes"),
    "MB": ("megabyte", "megabytes"),
    "KB": ("kilobyte", "kilobytes"),
    "kB": ("kilobyte", "kilobytes"),
    "TB/s": ("terabyte per second", "terabytes per second"),
    "GB/s": ("gigabyte per second", "gigabytes per second"),
    "MB/s": ("megabyte per second", "megabytes per second"),
    "Gbps": ("gigabit per second", "gigabits per second"),
    "Mbps": ("megabit per second", "megabits per second"),
    "Kbps": ("kilobit per second", "kilobits per second"),
    "THz": ("terahertz", "terahertz"),
    "GHz": ("gigahertz", "gigahertz"),
    "MHz": ("megahertz", "megahertz"),
    "kHz": ("kilohertz", "kilohertz"),
    "Hz": ("hertz", "hertz"),
    "TFLOPS": ("teraflop", "teraflops"),
    "kWh": ("kilowatt hour", "kilowatt hours"),
    "Wh": ("watt hour", "watt hours"),
    "mAh": ("milliamp hour", "milliamp hours"),
    "kW": ("kilowatt", "kilowatts"),
    "W": ("watt", "watts"),
    "V": ("volt", "volts"),
    "MP": ("megapixel", "megapixels"),
    "nm": ("nanometer", "nanometers"),
    "mm": ("millimeter", "millimeters"),
    "cm": ("centimeter", "centimeters"),
    "km": ("kilometer", "kilometers"),
    "km/h": ("kilometer per hour", "kilometers per hour"),
    "kph": ("kilometer per hour", "kilometers per hour"),
    "mph": ("mile per hour", "miles per hour"),
    "ms": ("millisecond", "milliseconds"),
    "ns": ("nanosecond", "nanoseconds"),
    "kg": ("kilogram", "kilograms"),
    "mg": ("milligram", "milligrams"),
    "lbs": ("pound", "pounds"),
    "lb": ("pound", "pounds"),
    "oz": ("ounce", "ounces"),
    "ft": ("foot", "feet"),
    "ml": ("milliliter", "milliliters"),
    "mL": ("milliliter", "milliliters"),
}

# Single-letter units must touch the number ("450W"), so "5 V" stays as written.
_UNIT_PATTERN = "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True))
_NUMBER = r"\d+(?:,\d{3})*(?:\.\d+)?"
_UNIT_RE = re.compile(rf"(?<![\w.,])({_NUMBER})(\s?)({_UNIT_PATTERN})(?![\w/])( +[a-z]+)?")

# Words that can follow a unit without making it an adjective: "16GB of RAM" stays plural,
# "a 5000mAh battery" or "3nm chips" use the singular like spoken English does.
_NOT_A_NOUN = frozenset(
    "a an the of and or but nor in on at to for with from by into onto per is are was were be "
    "been being it its that this these those than then so if as vs each every more less most "
    "least faster slower bigger smaller higher lower heavier lighter longer shorter wider "
    "away long wide tall high deep thick ago apart total only just left remaining free max "
    "maximum minimum min usable available".split()
)

# Words misaki gets wrong, as Kokoro phonemes (symbols shared by US and UK voices).
# Written in misaki's own override syntax: [word](/phonemes/).
PRONUNCIATIONS: dict[str, str] = {
    "EPYC": "ˈɛpɪk",
    "Huawei": "wˈɑwˌA",
    "Xiaomi": "ʃˈWmi",
    "framerate": "fɹˈAm ɹˌAt",
    "framerates": "fɹˈAm ɹˌAts",
}
_PRONUNCIATION_RE = re.compile(
    r"(?<![\w\[])(" + "|".join(re.escape(w) for w in PRONUNCIATIONS) + r")(?![\w\]])"
)

CURRENCY_NAMES = {"$": "dollars", "€": "euros", "£": "pounds"}
MAGNITUDES = {
    "k": "thousand", "K": "thousand", "thousand": "thousand",
    "m": "million", "M": "million", "mn": "million", "million": "million",
    "b": "billion", "B": "billion", "bn": "billion", "billion": "billion",
    "t": "trillion", "T": "trillion", "trillion": "trillion",
}
# "$1.5M" -> "1.5 million dollars"
_MONEY_MAGNITUDE_RE = re.compile(
    rf"([$€£])\s?({_NUMBER})\s?(thousand|million|billion|trillion|bn|mn|[kKmMbBtT])\b"
)
# "1M subscribers" -> "1 million subscribers". K needs a count word after it, since "4K" is a resolution.
_COUNT_WORDS = (
    "views|subscribers|subs|followers|likes|people|users|downloads|players|members|"
    "comments|shares|plays|streams|copies|units|sales|stars|votes|miles|steps|years|times"
)
_MB_RE = re.compile(rf"(?<![\w.$€£])({_NUMBER})(M|B|bn)\b(?!\.\d)")
_K_RE = re.compile(rf"(?<![\w.$€£])({_NUMBER})[kK]\b(?=\s+(?:{_COUNT_WORDS})\b)")

_RESOLUTION_RE = re.compile(r"(?<![\w.])(\d)(\d\d)p\b")
_PRODUCT_NUMBER_RE = re.compile(r"(?<![\w.])(\d{2})(\d00)(?=[A-Za-z])")
_CODE_HYPHEN_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9]*)-(?=\d)")
_RANGE_RE = re.compile(r"(?<![\w.,:/$€£-])(\d{1,4}(?:\.\d+)?)\s?[-–]\s?(\d{1,4}(?:\.\d+)?)(?![\d.,:/-])")
_RATIOS = {"16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "32:9", "1:1", "4:5", "5:4"}
_RATIO_RE = re.compile(r"(?<![\w:])(\d{1,2}):(\d{1,2})(?![\w:])")
_TIME_RE = re.compile(
    r"(?<![\w:])(\d{1,2}):(\d{2})(?![\d:])(\s?(?:[AaPp]\.?[Mm]\.?)(?![\w]))?"
)
_HASH_NUMBER_RE = re.compile(r"#(\d+)\b")
_TIMES_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)x\b")
_WITH_RE = re.compile(r"(?<!\w)w/o(?!\w)|(?<!\w)w/(?=\s)")
_EMOJI_RE = re.compile(
    "[\U0001f000-\U0001faff\U0001fc00-\U0001ffff☀-➿⬀-⯿️‍⃣]"
)


def _is_one(number: str) -> bool:
    return float(number.replace(",", "")) == 1


def _say_two_digits(value: int) -> str:
    """5 -> 'oh five', 20 -> 'twenty'."""
    return f"oh {num2words(value)}" if value < 10 else num2words(value)


def _units(match: re.Match[str]) -> str:
    number, space, unit, next_word = match.groups()
    if len(unit) == 1 and space:
        return match.group(0)
    singular, plural = UNITS[unit]
    as_adjective = next_word is not None and next_word.strip() not in _NOT_A_NOUN
    word = singular if _is_one(number) or as_adjective else plural
    return f"{number} {word}{next_word or ''}"


def _resolution(match: re.Match[str]) -> str:
    # 720p -> "seven twenty p" (misaki would say "seven hundred twenty p").
    hundreds, rest = int(match.group(1)), int(match.group(2))
    if rest == 0:
        return f"{num2words(hundreds * 100)} p"
    return f"{num2words(hundreds)} {_say_two_digits(rest)} p"


def _ratio(match: re.Match[str]) -> str:
    text = f"{match.group(1)}:{match.group(2)}"
    if text not in _RATIOS:
        return match.group(0)
    return f"{match.group(1)} by {match.group(2)}"


def _time(match: re.Match[str]) -> str:
    hour, minute, suffix = int(match.group(1)), int(match.group(2)), match.group(3)
    if hour > 24 or minute > 59:
        return match.group(0)
    ampm = ""
    if suffix:
        ampm = " " + ("A M" if suffix.strip()[0].lower() == "a" else "P M")
    if minute == 0:
        return f"{num2words(hour)}{ampm}" if ampm else f"{num2words(hour)} o'clock"
    return f"{num2words(hour)} {_say_two_digits(minute)}{ampm}"


def _money_magnitude(match: re.Match[str]) -> str:
    currency, number, magnitude = match.groups()
    return f"{number} {MAGNITUDES[magnitude]} {CURRENCY_NAMES[currency]}"


def normalize_text(text: str) -> str:
    text = _EMOJI_RE.sub("", text)
    text = _WITH_RE.sub(lambda m: "without" if m.group(0) == "w/o" else "with", text)
    text = _MONEY_MAGNITUDE_RE.sub(_money_magnitude, text)
    text = _UNIT_RE.sub(_units, text)
    text = _MB_RE.sub(lambda m: f"{m.group(1)} {MAGNITUDES[m.group(2)]}", text)
    text = _K_RE.sub(lambda m: f"{m.group(1)} thousand", text)
    text = _RESOLUTION_RE.sub(_resolution, text)
    text = _CODE_HYPHEN_RE.sub(r"\1 ", text)
    text = _PRODUCT_NUMBER_RE.sub(r"\1 \2", text)
    text = _RATIO_RE.sub(_ratio, text)
    text = _TIME_RE.sub(_time, text)
    text = _RANGE_RE.sub(r"\1 to \2", text)
    text = _HASH_NUMBER_RE.sub(r"number \1", text)
    text = _TIMES_RE.sub(r"\1 times", text)
    text = _PRONUNCIATION_RE.sub(lambda m: f"[{m.group(1)}](/{PRONUNCIATIONS[m.group(1)]}/)", text)
    return re.sub(r"[ \t]{2,}", " ", text)
