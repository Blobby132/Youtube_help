"""English voices shipped with Kokoro v1.0, best-sounding first.

Ids are Kokoro's own voice names: the first letter is the language/accent
(a = American, b = British), the second the gender (f/m).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Voice:
    id: str
    name: str
    accent: str
    gender: str
    description: str


VOICES: tuple[Voice, ...] = (
    Voice("af_heart", "Heart", "US", "F", "Warm, natural storyteller with lots of expression"),
    Voice("am_michael", "Michael", "US", "M", "Steady, documentary-style narration"),
    Voice("af_bella", "Bella", "US", "F", "Bright and energetic, great for facts and listicles"),
    Voice("am_fenrir", "Fenrir", "US", "M", "Deep and punchy, built for hype"),
    Voice("bf_emma", "Emma", "UK", "F", "Polished British narration"),
    Voice("bm_george", "George", "UK", "M", "Classic British documentary voice"),
    Voice("af_nicole", "Nicole", "US", "F", "Soft, close-mic delivery for calm or eerie topics"),
    Voice("am_puck", "Puck", "US", "M", "Lively and playful"),
    Voice("af_aoede", "Aoede", "US", "F", "Smooth and even, easy to listen to"),
    Voice("af_kore", "Kore", "US", "F", "Clear, confident explainer"),
    Voice("af_sarah", "Sarah", "US", "F", "Friendly, conversational read"),
    Voice("bm_fable", "Fable", "UK", "M", "Expressive British narrator"),
    Voice("bf_isabella", "Isabella", "UK", "F", "Warm British storyteller"),
    Voice("af_nova", "Nova", "US", "F", "Crisp, modern narration"),
    Voice("am_onyx", "Onyx", "US", "M", "Low, cinematic tone"),
    Voice("am_eric", "Eric", "US", "M", "Matter-of-fact newsreader"),
    Voice("am_liam", "Liam", "US", "M", "Casual, youthful delivery"),
    Voice("bm_lewis", "Lewis", "UK", "M", "Deep, measured British read"),
    Voice("bm_daniel", "Daniel", "UK", "M", "Calm British presenter"),
    Voice("af_sky", "Sky", "US", "F", "Light and airy, upbeat"),
)

DEFAULT_VOICE_ID = VOICES[0].id

_BY_ID = {voice.id: voice for voice in VOICES}


def get_voice(voice_id: str) -> Voice | None:
    return _BY_ID.get(voice_id)


def voices_payload() -> list[dict[str, str]]:
    return [asdict(voice) for voice in VOICES]
