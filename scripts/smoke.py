import asyncio
import json
import socket
import time
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "smoke-token-0123456789"
PORT = 47811
DBG = 9333
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def post(path: str, body: dict) -> tuple[int, bytes]:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(body).encode(),
        headers={"X-Conversa-Token": TOKEN, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.read()


def port_free() -> bool:
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", PORT)) != 0


def wait_until(predicate, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def page_open() -> bool:
    try:
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{DBG}/json", timeout=2).read())
    except Exception:
        return False
    return any(t["type"] == "page" and str(PORT) in t["url"] for t in targets)


def helper_command() -> list[str]:
    exe = ROOT / "bin" / "conversa-helper.exe"
    if "--python" in sys.argv or not exe.exists():
        return [sys.executable, "-m", "conversa", "--no-window"]
    return [str(exe), "--no-window"]


async def main() -> int:
    env = dict(os.environ, CONVERSA_TOKEN=TOKEN, CONVERSA_CONFIG=json.dumps({"stt": "browser", "tts": "edge"}))
    helper = subprocess.Popen(helper_command(), cwd=ROOT / "helper", env=env, stdout=subprocess.PIPE, text=True, encoding="utf-8")
    lines: list[dict] = []
    first = json.loads(helper.stdout.readline())
    check("auxiliar pronto", first == {"type": "ready", "port": PORT}, str(first))
    threading.Thread(target=lambda: [lines.append(json.loads(l)) for l in helper.stdout if l.strip()], daemon=True).start()

    status, body = post("/tts", {"text": "Teste do modo conversa."})
    check("TTS do Edge no auxiliar", status == 200 and len(body) > 1000, f"{len(body)} bytes")

    profile = Path(tempfile.mkdtemp(prefix="conversa-smoke-"))
    edge = subprocess.Popen([
        EDGE, f"--remote-debugging-port={DBG}", f"--user-data-dir={profile}",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required", "--no-first-run",
        f"--app=http://127.0.0.1:{PORT}/?t={TOKEN}",
    ])
    try:
        page = None
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{DBG}/json", timeout=2).read())
                page = next(t for t in targets if t["type"] == "page" and str(PORT) in t["url"])
                break
            except Exception:
                await asyncio.sleep(0.3)
        check("janela abriu", page is not None)
        if page is None:
            return 1
        async with aiohttp.ClientSession() as session, session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=0) as ws:
            counter = 0
            errors: list[str] = []

            async def evaluate(expr: str):
                nonlocal counter
                counter += 1
                mine = counter
                await ws.send_json({"id": mine, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}})
                while True:
                    msg = await asyncio.wait_for(ws.receive_json(), 15)
                    if msg.get("method") == "Runtime.exceptionThrown":
                        errors.append(str(msg["params"]["exceptionDetails"].get("text")))
                    if msg.get("method") == "Log.entryAdded" and msg["params"]["entry"]["level"] == "error":
                        errors.append(msg["params"]["entry"]["text"])
                    if msg.get("id") == mine:
                        return msg.get("result", {}).get("result", {}).get("value") or "{}"

            await ws.send_json({"id": 9000, "method": "Log.enable"})
            await ws.send_json({"id": 9001, "method": "Runtime.enable"})
            probe = "(() => { try { return JSON.stringify({s: stage.dataset.state, e: stage.dataset.echo, c: caption.textContent, canvas: !document.getElementById('orb').hidden, q: question.hidden ? null : question.textContent, allow: !allow.hidden}) } catch (_) { return '{}' } })()"
            state = {}
            for _ in range(40):
                await asyncio.sleep(0.25)
                state = json.loads(await evaluate(probe))
                if state.get("s") == "listening":
                    break
            check("página ouvindo", state.get("s") == "listening", str(state))
            check("orbe 3D visível", state.get("canvas") is True)
            check("canal de eco em chamada", state.get("e") == "chamada", str(state.get("e")))

            post("/cmd", {"type": "speak", "turn": "t1", "chunks": ["Olá.", "Estou testando."]})
            seen = set()
            for _ in range(40):
                await asyncio.sleep(0.25)
                seen.add(json.loads(await evaluate(probe)).get("s"))
            check("fala tocou", "speaking" in seen, str(seen))

            decided: dict = {}

            def wait() -> None:
                decided.update(json.loads(post("/approval/wait", {"id": "a1", "question": "Posso rodar um comando: git status?"})[1]))

            waiter = threading.Thread(target=wait)
            waiter.start()
            await asyncio.sleep(1.0)
            state = json.loads(await evaluate(probe))
            check("pergunta de aprovação na janela", state.get("q") == "Posso rodar um comando: git status?" and state.get("allow"), str(state))
            await evaluate("document.getElementById('allow').click()")
            waiter.join(10)
            check("clique em Permitir decide", decided == {"decision": "allow"}, str(decided))
            await asyncio.sleep(0.5)
            check("botões somem depois", json.loads(await evaluate(probe)).get("allow") is False)

            await evaluate("document.getElementById('stop').click()")
            await asyncio.sleep(0.8)
            check("botão Parar avisa o mod", {"type": "stop"} in lines, str(lines))
            post("/event", {"type": "utterance", "text": "não está"})
            await asyncio.sleep(0.5)
            check("fala com acento chega inteira ao mod", {"type": "utterance", "text": "não está"} in lines, str(lines[-1:]))
            check("sem erros no console", not errors, "; ".join(errors))

        subprocess.run(["taskkill", "/F", "/PID", str(helper.pid)], capture_output=True)
        check("matar o processo principal libera a porta", wait_until(port_free, 8))
        check("a janela fecha quando o auxiliar some", wait_until(lambda: not page_open(), 20))

        helper = subprocess.Popen(helper_command(), cwd=ROOT / "helper", env=env, stdout=subprocess.PIPE, text=True, encoding="utf-8")
        check("auxiliar sobe de novo", json.loads(helper.stdout.readline()).get("type") == "ready")
        post("/cmd", {"type": "quit"})
        try:
            helper.wait(10)
            check("auxiliar encerra no quit", True)
        except subprocess.TimeoutExpired:
            check("auxiliar encerra no quit", False)
    finally:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(edge.pid)], capture_output=True)
        if helper.poll() is None:
            helper.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} verificações passaram")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
