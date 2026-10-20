import io
import json
import socket

from conversa.__main__ import run


def test_busy_port_reports_error():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    out = io.StringIO()
    try:
        code = run(["--port", str(port), "--no-window"], {"CONVERSA_TOKEN": "t"}, out)
    finally:
        sock.close()
    assert code == 2
    event = json.loads(out.getvalue().splitlines()[-1])
    assert event["type"] == "error" and str(port) in event["message"]


def test_missing_token_reports_error():
    out = io.StringIO()
    assert run(["--port", "0", "--no-window"], {}, out) == 2
    assert json.loads(out.getvalue())["type"] == "error"


def test_ready_comes_before_the_window(monkeypatch):
    from conversa import window

    out = io.StringIO()
    seen = []

    class FakeWindow:
        stopping = False

        def start(self, url):
            seen.append(out.getvalue())

        def wait_closed(self):
            return None

        def closed(self):
            return True

        def stop(self):
            self.stopping = True

    monkeypatch.setattr(window, "EdgeWindow", FakeWindow)
    assert run(["--port", "0"], {"CONVERSA_TOKEN": "t"}, out) == 0
    assert json.loads(seen[0].splitlines()[0])["type"] == "ready"


def test_watch_parent_fires_when_parent_exits():
    import subprocess
    import sys
    import threading

    from conversa.__main__ import watch_parent

    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.5)"])
    gone = threading.Event()
    watch_parent(child.pid, gone.set)
    assert gone.wait(5)
    child.wait()
