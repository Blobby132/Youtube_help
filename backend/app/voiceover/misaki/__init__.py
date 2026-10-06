"""Vendored copy of misaki 0.9.4 (English only), Kokoro's own grapheme-to-phoneme library.

Source: https://github.com/hexgrad/misaki (Apache License 2.0, see LICENSE in this folder).
It is vendored because the published package declares Requires-Python <3.13 even though
the English code and all of its dependencies run on Python 3.14.

Changes from upstream are marked with "Shorts Creator:" comments:
- G2P no longer downloads the spaCy model at runtime; it is installed from requirements.txt.
- A currency symbol no longer carries past punctuation ("$5, 10 people").
"""

__version__ = "0.9.4"
