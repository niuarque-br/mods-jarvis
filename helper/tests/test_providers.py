import asyncio
import json

import httpx
import pytest

from conversa import providers
from conversa.providers import Voice, VoiceConfig, rate_factor


def run(coro):
    return asyncio.run(coro)


class FakeCommunicate:
    calls = []

    def __init__(self, text, voice, *, rate):
        FakeCommunicate.calls.append((text, voice, rate))

    async def stream(self):
        yield {"type": "WordBoundary"}
        yield {"type": "audio", "data": b"EDGE"}


@pytest.fixture(autouse=True)
def fake_edge(monkeypatch):
    FakeCommunicate.calls = []
    monkeypatch.setattr(providers, "edge_communicate", FakeCommunicate)


def test_rate_factor():
    assert rate_factor("+10%") == 1.1
    assert rate_factor("+0%") == 1.0
    assert rate_factor("-90%") == 0.25


def test_edge_is_default_and_needs_no_key():
    audio, fell_back = run(Voice(VoiceConfig()).speak("Olá."))
    assert audio == b"EDGE"
    assert fell_back is False
    assert FakeCommunicate.calls == [("Olá.", "pt-BR-AntonioNeural", "+0%")]


def test_openai_tts_request():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"MP3")

    cfg = VoiceConfig(tts="openai", voice="pt-BR-AntonioNeural", rate="+10%", openai_key="sk-x")
    audio, fell_back = run(Voice(cfg, httpx.MockTransport(handler)).speak("Oi."))
    assert audio == b"MP3" and fell_back is False
    assert seen["url"] == "https://api.openai.com/v1/audio/speech"
    assert seen["auth"] == "Bearer sk-x"
    assert seen["body"] == {"model": "gpt-4o-mini-tts", "input": "Oi.", "voice": "onyx", "response_format": "mp3", "speed": 1.1}


def test_elevenlabs_tts_request():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key"] = request.headers["xi-api-key"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"MP3")

    cfg = VoiceConfig(tts="elevenlabs", rate="+50%", elevenlabs_key="el")
    run(Voice(cfg, httpx.MockTransport(handler)).speak("Oi."))
    assert seen["url"] == "https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=mp3_44100_128"
    assert seen["key"] == "el"
    assert seen["body"] == {"text": "Oi.", "model_id": "eleven_multilingual_v2", "voice_settings": {"speed": 1.2}}


def test_paid_tts_failure_falls_back_to_edge():
    cfg = VoiceConfig(tts="openai", openai_key="sk-x")
    audio, fell_back = run(Voice(cfg, httpx.MockTransport(lambda r: httpx.Response(500))).speak("Oi."))
    assert audio == b"EDGE" and fell_back is True
    assert FakeCommunicate.calls[0][1] == "pt-BR-AntonioNeural"


def test_missing_key_falls_back_to_edge():
    audio, fell_back = run(Voice(VoiceConfig(tts="openai")).speak("Oi."))
    assert audio == b"EDGE" and fell_back is True


def test_openai_stt_request_and_noise_segments():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = request.content
        return httpx.Response(200, json={"segments": [
            {"text": " roda os testes ", "no_speech_prob": 0.1, "avg_logprob": -0.2, "compression_ratio": 1.1},
            {"text": "obrigado", "no_speech_prob": 0.9, "avg_logprob": -0.2, "compression_ratio": 1.0},
        ]})

    cfg = VoiceConfig(stt="openai", openai_key="sk-x", stt_prompt="pytest")
    text = run(Voice(cfg, httpx.MockTransport(handler)).transcribe(b"WAV", "audio/wav"))
    assert text == "roda os testes"
    assert seen["url"] == "https://api.openai.com/v1/audio/transcriptions"
    for part in (b'name="model"', b"whisper-1", b'name="language"', b"pt", b'name="prompt"', b"verbose_json"):
        assert part in seen["body"]


def test_elevenlabs_stt_request_and_cleanup():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = request.content
        return httpx.Response(200, json={"text": "[música] hm"})

    cfg = VoiceConfig(stt="elevenlabs", elevenlabs_key="el")
    assert run(Voice(cfg, httpx.MockTransport(handler)).transcribe(b"WAV", "audio/wav")) == ""
    assert seen["url"] == "https://api.elevenlabs.io/v1/speech-to-text"
    assert b"scribe_v1" in seen["body"] and b'name="language_code"' in seen["body"]


def test_browser_stt_has_no_server_transcription():
    with pytest.raises(ValueError):
        run(Voice(VoiceConfig()).transcribe(b"WAV", "audio/wav"))


def test_missing_stt_key():
    with pytest.raises(ValueError, match="chave da OpenAI ausente"):
        run(Voice(VoiceConfig(stt="openai")).transcribe(b"WAV", "audio/wav"))


def test_config_from_env():
    env = {
        "CONVERSA_CONFIG": json.dumps({"stt": "openai", "tts": "elevenlabs", "voice": "abc", "rate": "+5%", "stt_prompt": "x"}),
        "OPENAI_API_KEY": "sk-1",
        "ELEVENLABS_API_KEY": "el-1",
    }
    cfg = VoiceConfig.from_env(env)
    assert (cfg.stt, cfg.tts, cfg.voice, cfg.rate, cfg.stt_prompt) == ("openai", "elevenlabs", "abc", "+5%", "x")
    assert (cfg.openai_key, cfg.elevenlabs_key) == ("sk-1", "el-1")
    assert VoiceConfig.from_env({}) == VoiceConfig()


def test_config_numbers_from_env():
    cfg = VoiceConfig.from_env({"CONVERSA_CONFIG": json.dumps({"silence_ms": "900", "proximity": 30})})
    assert (cfg.silence_ms, cfg.proximity) == (900, 30)
    assert VoiceConfig.from_env({"CONVERSA_CONFIG": json.dumps({"silence_ms": "abc"})}).silence_ms == 1200
