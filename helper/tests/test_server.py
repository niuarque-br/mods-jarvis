import http.client
import io
import json
import threading
import time

import pytest

from conversa.server import make_server

TOKEN = "tok-123"


class FakeVoice:
    def __init__(self):
        self.fell_back = False

    async def speak(self, text):
        return b"MP3:" + text.encode(), self.fell_back

    async def transcribe(self, audio, mime):
        if mime != "audio/wav":
            raise ValueError("formato")
        return "roda os testes"


class Out(io.StringIO):
    def events(self):
        return [json.loads(line) for line in self.getvalue().splitlines() if line.strip()]


@pytest.fixture
def helper(tmp_path):
    (tmp_path / "index.html").write_text("<title>Modo Jarvis</title>", encoding="utf-8")
    (tmp_path / "app.js").write_text("export {}", encoding="utf-8")
    out = Out()
    voice = FakeVoice()
    server = make_server(0, TOKEN, voice, out, web_dir=tmp_path, approval_timeout=0.5)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], out, voice
    server.shutdown()
    server.server_close()


def call(port, method, path, body=None, token=TOKEN, ctype="application/json"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": ctype}
    if token:
        headers["X-Conversa-Token"] = token
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    return resp.status, dict(resp.getheaders()), resp.read()


def open_events(port):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", f"/events?t={TOKEN}")
    resp = conn.getresponse()
    assert resp.status == 200

    def next_message():
        while True:
            line = resp.fp.readline().decode().strip()
            if line.startswith("data: "):
                return json.loads(line[6:])

    return next_message


def test_ping_needs_no_token(helper):
    port, _, _ = helper
    status, _, body = call(port, "GET", "/ping", token=None)
    assert status == 200
    assert json.loads(body) == {"app": "modo-conversa", "busy": True}


def test_cmd_without_token_is_refused(helper):
    port, _, _ = helper
    assert call(port, "POST", "/cmd", {"type": "state", "state": "listening"}, token=None)[0] == 401
    assert call(port, "POST", "/cmd", {"type": "state", "state": "listening"}, token="errado")[0] == 401


def test_page_needs_token_and_static_does_not(helper):
    port, _, _ = helper
    assert call(port, "GET", "/", token=None)[0] == 401
    status, _, body = call(port, "GET", f"/?t={TOKEN}", token=None)
    assert status == 200 and b"Modo Jarvis" in body
    status, headers, _ = call(port, "GET", "/static/app.js", token=None)
    assert status == 200 and headers["Content-Type"].startswith("text/javascript")
    assert call(port, "GET", "/static/../index.html", token=None)[0] == 404


def test_cmd_reaches_page_over_sse(helper):
    port, _, _ = helper
    next_message = open_events(port)
    assert call(port, "POST", "/cmd", {"type": "speak", "turn": "t1", "chunks": ["Oi."]})[0] == 204
    assert next_message() == {"type": "speak", "turn": "t1", "chunks": ["Oi."]}


def test_page_event_is_written_to_stdout(helper):
    port, out, _ = helper
    assert call(port, "POST", "/event", {"type": "utterance", "text": "roda os testes"})[0] == 204
    assert call(port, "POST", "/event", {"type": "bogus"})[0] == 400
    assert out.events() == [{"type": "utterance", "text": "roda os testes"}]


def wait_with(port, answer_fn):
    result = {}

    def waiter():
        result["value"] = json.loads(call(port, "POST", "/approval/wait", {"id": "a1", "question": "Posso?"})[2])

    thread = threading.Thread(target=waiter)
    thread.start()
    time.sleep(0.1)
    answer_fn()
    thread.join(5)
    return result["value"]


def test_approval_click_allow(helper):
    port, _, _ = helper
    next_message = open_events(port)
    decided = wait_with(port, lambda: call(port, "POST", "/approval/answer", {"id": "a1", "click": "allow"}))
    assert decided == {"decision": "allow"}
    assert next_message() == {"type": "approval", "id": "a1", "question": "Posso?"}
    assert next_message() == {"type": "approval-done", "id": "a1"}


def test_approval_spoken_no(helper):
    port, _, _ = helper
    answers = []
    decided = wait_with(port, lambda: answers.append(call(port, "POST", "/approval/answer", {"id": "a1", "utterance": "não"})))
    assert decided == {"decision": "deny"}
    assert json.loads(answers[0][2]) == {"result": "done"}


def test_approval_unclear_twice_times_out(helper):
    port, _, _ = helper
    answers = []

    def twice():
        answers.append(json.loads(call(port, "POST", "/approval/answer", {"id": "a1", "utterance": "hã?"})[2]))
        answers.append(json.loads(call(port, "POST", "/approval/answer", {"id": "a1", "utterance": "hã?"})[2]))

    assert wait_with(port, twice) == {"decision": "timeout"}
    assert answers == [{"result": "retry"}, {"result": "done"}]


def test_approval_without_answer_times_out(helper):
    port, _, _ = helper
    started = time.time()
    assert wait_with(port, lambda: None) == {"decision": "timeout"}
    assert time.time() - started < 3


def test_answer_for_unknown_approval(helper):
    port, _, _ = helper
    assert call(port, "POST", "/approval/answer", {"id": "nada", "click": "allow"})[0] == 404


def test_tts_returns_audio_and_fallback_header(helper):
    port, _, voice = helper
    status, headers, body = call(port, "POST", "/tts", {"text": "Oi."})
    assert status == 200 and headers["Content-Type"] == "audio/mpeg" and body == b"MP3:Oi."
    assert "X-Voice-Fallback" not in headers
    voice.fell_back = True
    assert call(port, "POST", "/tts", {"text": "Oi."})[1]["X-Voice-Fallback"] == "1"
    assert call(port, "POST", "/tts", {"text": "  "})[0] == 204


def test_stt_takes_raw_audio(helper):
    port, _, _ = helper
    status, _, body = call(port, "POST", "/stt", b"RIFF", ctype="audio/wav")
    assert status == 200 and json.loads(body) == {"text": "roda os testes"}
    assert call(port, "POST", "/stt", b"x", ctype="audio/ogg")[0] == 400


def test_config_is_public_and_has_no_keys(tmp_path):
    from conversa.providers import VoiceConfig

    (tmp_path / "index.html").write_text("x", encoding="utf-8")
    cfg = VoiceConfig(stt="openai", tts="browser", silence_ms=900, proximity=30, openai_key="sk-secreta")
    server = make_server(0, TOKEN, FakeVoice(), Out(), web_dir=tmp_path, config=cfg)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        status, _, body = call(server.server_address[1], "GET", "/config")
        assert status == 200
        assert json.loads(body) == {"stt": "openai", "tts": "browser", "lang": "pt-BR", "silenceMs": 900, "proximity": 30}
        assert b"sk-secreta" not in body
        assert call(server.server_address[1], "GET", "/config", token=None)[0] == 401
    finally:
        server.shutdown()
        server.server_close()


def test_favicon_is_quiet(helper):
    port, _, _ = helper
    assert call(port, "GET", "/favicon.ico", token=None)[0] == 204


def test_stdout_lines_are_ascii(helper):
    port, out, _ = helper
    assert call(port, "POST", "/event", {"type": "utterance", "text": "não está"})[0] == 204
    raw = out.getvalue()
    assert raw.isascii()
    assert json.loads(raw) == {"type": "utterance", "text": "não está"}
