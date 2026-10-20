from __future__ import annotations

import asyncio
import hmac
import json
import mimetypes
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, TextIO
from urllib.parse import parse_qs, urlparse

from conversa.bus import Bus
from conversa.consent import classify_consent
from conversa.providers import ProviderError, VoiceConfig

COMMANDS = {"state", "speak", "flush", "approval", "approval-done", "caption", "quit"}
PAGE_EVENTS = {"utterance", "stop", "closed", "spoken"}
AUDIO_TYPES = {"audio/wav", "audio/webm", "audio/ogg", "audio/mpeg"}
MAX_BODY = 10 * 1024 * 1024
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html"}


class AsyncRunner:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def run(self, coro: Any, timeout: float = 60.0) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


class Emitter:
    def __init__(self, out: TextIO) -> None:
        self.out = out
        self.lock = threading.Lock()

    def __call__(self, event: dict) -> None:
        with self.lock:
            self.out.write(json.dumps(event) + "\n")
            self.out.flush()


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, port: int, handler: type, bus: Bus, emit: Emitter, on_quit: Callable[[], None]) -> None:
        super().__init__(("127.0.0.1", port), handler)
        self.bus = bus
        self.emit = emit
        self.on_quit = on_quit


def make_server(
    port: int,
    token: str,
    voice: Any,
    out: TextIO,
    web_dir: Path,
    approval_timeout: float = 20.0,
    on_quit: Callable[[], None] | None = None,
    config: VoiceConfig | None = None,
) -> HelperServer:
    public = config or getattr(voice, "cfg", None) or VoiceConfig()
    runner = AsyncRunner()
    web_root = Path(web_dir).resolve()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:
            pass

        @property
        def bus(self) -> Bus:
            return self.server.bus

        def _authorized(self) -> bool:
            query = parse_qs(urlparse(self.path).query)
            given = self.headers.get("X-Conversa-Token") or (query.get("t") or [""])[0]
            return hmac.compare_digest(given.encode(), token.encode())

        def _send(self, status: int, body: bytes = b"", ctype: str = "application/json", headers: dict | None = None) -> None:
            self.send_response(status)
            if body or status != 204:
                self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, status: int, payload: Any) -> None:
            self._send(status, json.dumps(payload, ensure_ascii=False).encode())

        def _body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ValueError("corpo grande demais")
            return self.rfile.read(length) if length else b""

        def _payload(self) -> dict:
            data = json.loads(self._body() or b"{}")
            if not isinstance(data, dict):
                raise ValueError("objeto esperado")
            return data

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/ping":
                return self._json(200, {"app": "modo-conversa", "busy": True})
            if path == "/favicon.ico":
                return self._send(204)
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if not self._authorized():
                return self._json(401, {"error": "token"})
            if path == "/":
                return self._static("index.html")
            if path == "/events":
                return self._events()
            if path == "/config":
                return self._json(200, {
                    "stt": public.stt,
                    "tts": public.tts,
                    "lang": public.lang,
                    "silenceMs": public.silence_ms,
                    "proximity": public.proximity,
                })
            self._json(404, {"error": "rota"})

        def _static(self, name: str) -> None:
            target = (web_root / name).resolve()
            if web_root not in target.parents or not target.is_file():
                return self._json(404, {"error": "arquivo"})
            ctype = TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self._send(200, target.read_bytes(), ctype)

        def _events(self) -> None:
            q = self.bus.subscribe()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(b": ok\n\n")
                self.wfile.flush()
                while True:
                    try:
                        message = q.get(timeout=15)
                        chunk = f"data: {json.dumps(message, ensure_ascii=False)}\n\n".encode()
                    except queue.Empty:
                        chunk = b": keepalive\n\n"
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (ConnectionError, OSError):
                pass
            finally:
                self.bus.unsubscribe(q)

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            if not self._authorized():
                return self._json(401, {"error": "token"})
            try:
                route = {
                    "/cmd": self._cmd,
                    "/event": self._event,
                    "/approval/wait": self._approval_wait,
                    "/approval/answer": self._approval_answer,
                    "/tts": self._tts,
                    "/stt": self._stt,
                }.get(path)
                if route is None:
                    return self._json(404, {"error": "rota"})
                route()
            except (ValueError, json.JSONDecodeError) as exc:
                self._json(400, {"error": str(exc)})
            except ProviderError as exc:
                self._json(502, {"error": str(exc)})

        def _cmd(self) -> None:
            data = self._payload()
            if data.get("type") not in COMMANDS:
                raise ValueError("comando desconhecido")
            self.bus.publish(data)
            self._send(204)
            if data["type"] == "quit" and self.server.on_quit:
                threading.Thread(target=self.server.on_quit, daemon=True).start()

        def _event(self) -> None:
            data = self._payload()
            kind = data.get("type")
            if kind not in PAGE_EVENTS:
                raise ValueError("evento desconhecido")
            event = {"type": kind}
            if kind == "utterance":
                text = str(data.get("text") or "").strip()
                if not text:
                    raise ValueError("fala vazia")
                event["text"] = text
            elif kind == "spoken":
                spoken_id = str(data.get("id") or "")
                outcome = data.get("outcome")
                if not spoken_id or outcome not in ("done", "stopped"):
                    raise ValueError("spoken inválido")
                event["id"] = spoken_id
                event["outcome"] = outcome
            self.server.emit(event)
            self._send(204)

        def _approval_wait(self) -> None:
            data = self._payload()
            approval_id = str(data.get("id") or "")
            if not approval_id:
                raise ValueError("id ausente")
            question = str(data.get("question") or "")
            approval = self.bus.open_approval(approval_id, question)
            self.bus.publish({"type": "approval", "id": approval_id, "question": question})
            approval.done.wait(approval_timeout)
            self.bus.close_approval(approval_id)
            self.bus.publish({"type": "approval-done", "id": approval_id})
            self._json(200, {"decision": approval.decision if approval.done.is_set() else "timeout"})

        def _approval_answer(self) -> None:
            data = self._payload()
            approval_id = str(data.get("id") or "")
            approval = self.bus.approval(approval_id)
            if approval is None:
                return self._json(404, {"error": "aprovação"})
            click = data.get("click")
            if click in ("allow", "deny"):
                self.bus.decide(approval_id, click)
                return self._json(200, {"result": "done"})
            verdict = classify_consent(str(data.get("utterance") or ""))
            if verdict is None:
                approval.fails += 1
                if approval.fails < 2:
                    return self._json(200, {"result": "retry"})
                self.bus.decide(approval_id, "timeout")
                return self._json(200, {"result": "done"})
            self.bus.decide(approval_id, "allow" if verdict else "deny")
            self._json(200, {"result": "done"})

        def _tts(self) -> None:
            text = str(self._payload().get("text") or "").strip()[:2000]
            if not text:
                return self._send(204)
            audio, fell_back = runner.run(voice.speak(text))
            self._send(200, audio, "audio/mpeg", {"X-Voice-Fallback": "1"} if fell_back else None)

        def _stt(self) -> None:
            mime = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            if mime not in AUDIO_TYPES:
                raise ValueError("formato de áudio")
            audio = self._body()
            text = runner.run(voice.transcribe(audio, mime))
            self._json(200, {"text": text})

    return HelperServer(port, Handler, Bus(), Emitter(out), on_quit)
