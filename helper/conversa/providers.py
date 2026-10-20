from __future__ import annotations

import json
import re
from dataclasses import dataclass, fields
from typing import Any, Mapping
from urllib.parse import quote

import httpx
from edge_tts import Communicate as edge_communicate

from conversa.transcript import clean_transcript

OPENAI_BASE = "https://api.openai.com/v1"
ELEVENLABS_BASE = "https://api.elevenlabs.io"
EDGE_VOICE = "pt-BR-AntonioNeural"
OPENAI_VOICE = "onyx"
ELEVENLABS_VOICE = "pNInz6obpgDQGcFmaJgB"
OPENAI_VOICES = ("alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse")
AUDIO_EXT = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/mpeg": ".mp3"}
EDGE_NAME = re.compile(r"^[a-z]{2}-[A-Z]{2}-\w+Neural$")


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class VoiceConfig:
    stt: str = "browser"
    tts: str = "edge"
    voice: str = EDGE_VOICE
    rate: str = "+0%"
    lang: str = "pt-BR"
    stt_prompt: str = ""
    silence_ms: int = 1200
    proximity: int = 45
    openai_key: str = ""
    elevenlabs_key: str = ""

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> "VoiceConfig":
        try:
            raw = json.loads(environ.get("CONVERSA_CONFIG") or "{}")
        except ValueError:
            raw = {}
        values: dict[str, Any] = {}
        for f in fields(cls):
            value = raw.get(f.name) if f.name not in ("openai_key", "elevenlabs_key") else None
            if value in (None, ""):
                continue
            if f.type in ("int", int):
                try:
                    values[f.name] = int(value)
                except (TypeError, ValueError):
                    continue
            else:
                values[f.name] = str(value)
        values["openai_key"] = environ.get("OPENAI_API_KEY", "")
        values["elevenlabs_key"] = environ.get("ELEVENLABS_API_KEY", "")
        return cls(**values)


def rate_factor(rate: str) -> float:
    try:
        value = 1 + int(rate.strip().rstrip("%")) / 100
    except ValueError:
        value = 1.0
    return round(min(4.0, max(0.25, value)), 4)


def voice_for(provider: str, voice: str) -> str:
    if provider == "openai":
        return voice if voice in OPENAI_VOICES else OPENAI_VOICE
    if provider == "elevenlabs":
        return voice if voice and voice not in OPENAI_VOICES and not EDGE_NAME.match(voice) else ELEVENLABS_VOICE
    return voice if EDGE_NAME.match(voice or "") else EDGE_VOICE


def is_noise_segment(segment: dict) -> bool:
    no_speech = float(segment.get("no_speech_prob") or 0)
    logprob = float(segment.get("avg_logprob") or 0)
    ratio = float(segment.get("compression_ratio") or 0)
    return (no_speech > 0.5 and logprob < -0.8) or no_speech > 0.85 or logprob < -1.5 or ratio > 2.4


class Voice:
    def __init__(self, cfg: VoiceConfig, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 30.0) -> None:
        self.cfg = cfg
        self.transport = transport
        self.timeout = timeout

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
                response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise ProviderError(f"falha de rede: {exc.__class__.__name__}") from exc
        if response.status_code >= 400:
            raise ProviderError(f"HTTP {response.status_code}")
        return response

    async def _edge(self, text: str) -> bytes:
        audio = bytearray()
        try:
            async for chunk in edge_communicate(text, voice_for("edge", self.cfg.voice), rate=self.cfg.rate).stream():
                if chunk.get("type") == "audio":
                    audio.extend(chunk["data"])
        except Exception as exc:
            raise ProviderError(f"edge-tts: {exc.__class__.__name__}") from exc
        if not audio:
            raise ProviderError("edge-tts não devolveu áudio")
        return bytes(audio)

    async def _openai_tts(self, text: str) -> bytes:
        if not self.cfg.openai_key:
            raise ProviderError("chave da OpenAI ausente")
        body = {
            "model": "gpt-4o-mini-tts",
            "input": text,
            "voice": voice_for("openai", self.cfg.voice),
            "response_format": "mp3",
            "speed": rate_factor(self.cfg.rate),
        }
        headers = {"Authorization": f"Bearer {self.cfg.openai_key}"}
        return (await self._send("POST", f"{OPENAI_BASE}/audio/speech", json=body, headers=headers)).content

    async def _elevenlabs_tts(self, text: str) -> bytes:
        if not self.cfg.elevenlabs_key:
            raise ProviderError("chave da ElevenLabs ausente")
        body = {
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"speed": min(1.2, max(0.7, rate_factor(self.cfg.rate)))},
        }
        voice = quote(voice_for("elevenlabs", self.cfg.voice), safe="")
        response = await self._send(
            "POST",
            f"{ELEVENLABS_BASE}/v1/text-to-speech/{voice}",
            params={"output_format": "mp3_44100_128"},
            json=body,
            headers={"xi-api-key": self.cfg.elevenlabs_key},
        )
        return response.content

    async def speak(self, text: str) -> tuple[bytes, bool]:
        paid = {"openai": self._openai_tts, "elevenlabs": self._elevenlabs_tts}.get(self.cfg.tts)
        if paid is None:
            return await self._edge(text), False
        try:
            return await paid(text), False
        except ProviderError:
            return await self._edge(text), True

    async def transcribe(self, audio: bytes, mime: str) -> str:
        files = {"file": ("fala" + AUDIO_EXT.get(mime, ".webm"), audio, mime)}
        lang = self.cfg.lang.split("-")[0]
        if self.cfg.stt == "openai":
            if not self.cfg.openai_key:
                raise ValueError("chave da OpenAI ausente")
            data = {"model": "whisper-1", "language": lang, "response_format": "verbose_json"}
            if self.cfg.stt_prompt:
                data["prompt"] = self.cfg.stt_prompt
            response = await self._send(
                "POST",
                f"{OPENAI_BASE}/audio/transcriptions",
                files=files,
                data=data,
                headers={"Authorization": f"Bearer {self.cfg.openai_key}"},
            )
            body = response.json()
            segments = body.get("segments")
            if isinstance(segments, list) and segments:
                text = " ".join(str(s.get("text") or "").strip() for s in segments if isinstance(s, dict) and not is_noise_segment(s))
            else:
                text = str(body.get("text") or "")
        elif self.cfg.stt == "elevenlabs":
            if not self.cfg.elevenlabs_key:
                raise ValueError("chave da ElevenLabs ausente")
            response = await self._send(
                "POST",
                f"{ELEVENLABS_BASE}/v1/speech-to-text",
                files=files,
                data={"model_id": "scribe_v1", "language_code": lang},
                headers={"xi-api-key": self.cfg.elevenlabs_key},
            )
            text = str(response.json().get("text") or "")
        else:
            raise ValueError("o reconhecimento de voz deste modo roda no navegador")
        return clean_transcript(text.strip(), self.cfg.stt_prompt)
