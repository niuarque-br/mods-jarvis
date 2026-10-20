from __future__ import annotations

import re
import unicodedata

NOISE_TAG = re.compile(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*")
FILLERS = frozenset(
    {"a", "ah", "aha", "ahn", "ahem", "an", "cof", "eh", "hm", "hmm", "hmmm", "hum", "huum", "mm", "mhm", "uh", "uhm", "um", "tosse", "pigarro"}
)
PHANTOMS = frozenset(
    {
        "obrigado",
        "obrigada",
        "obrigado obrigado",
        "muito obrigado",
        "obrigado por assistir",
        "tchau",
        "tchau tchau",
        "valeu",
        "ate a proxima",
        "legendas pela comunidade amara org",
        "inscreva se no canal",
        "e ai",
    }
)


def words(text: str) -> list[str]:
    plain = unicodedata.normalize("NFD", (text or "").lower())
    plain = "".join(c for c in plain if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", plain).split()


def clean_transcript(text: str, prompt: str = "") -> str:
    cleaned = re.sub(r"\s+", " ", NOISE_TAG.sub(" ", text or "")).strip().lstrip(",.;:- ")
    tokens = words(cleaned)
    if not tokens or all(w in FILLERS for w in tokens) or " ".join(tokens) in PHANTOMS:
        return ""
    if len(tokens) >= 2 and f" {' '.join(tokens)} " in f" {' '.join(words(prompt))} ":
        return ""
    return cleaned
