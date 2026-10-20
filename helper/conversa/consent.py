from __future__ import annotations

import re
import unicodedata

YES_PHRASES = (
    "sim",
    "pode",
    "pode atualizar",
    "pode executar",
    "pode seguir",
    "pode rodar",
    "pode editar",
    "autorizo",
    "confirmo",
    "manda ver",
    "sim pode",
    "sim autorizo",
    "sim confirmo",
)
NO_PHRASES = ("nao", "cancela", "cancelar", "pare", "negado", "nao pode")
QUESTION_PHRASES = ("o que", "como", "quando", "qual", "quem", "onde", "por que")
FILLERS = ("claude", "por favor", "ok", "beleza")


def _words(text: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", text or "")
    plain = "".join(char for char in plain if not unicodedata.combining(char)).lower()
    return re.findall(r"[a-z0-9]+", plain)


def _has(words: list[str], phrases: tuple[str, ...]) -> bool:
    for phrase in phrases:
        target = phrase.split()
        size = len(target)
        if any(words[index : index + size] == target for index in range(len(words) - size + 1)):
            return True
    return False


def _strip_fillers(words: list[str]) -> list[str]:
    text = " ".join(words)
    for filler in FILLERS:
        text = re.sub(r"(?<![a-z0-9])" + re.escape(filler) + r"(?![a-z0-9])", " ", text)
    return text.split()


def _clauses(text: str) -> list[list[str]]:
    clauses = []
    for part in re.split(r"[,.;:!]", text):
        words = _strip_fillers(_words(part))
        if words:
            clauses.append(words)
    return clauses


def classify_consent(text: str) -> bool | None:
    text = unicodedata.normalize("NFC", text or "")
    words = _words(text)
    if _has(words, NO_PHRASES):
        return False
    if "?" in text or _has(words, QUESTION_PHRASES):
        return None
    yes = [phrase.split() for phrase in YES_PHRASES]
    clauses = _clauses(text)
    if clauses and all(clause in yes for clause in clauses):
        return True
    return None
