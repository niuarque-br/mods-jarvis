from __future__ import annotations

import argparse
import ctypes
import os
import sys
import threading
from pathlib import Path
from typing import Mapping, TextIO

from conversa.providers import Voice, VoiceConfig
from conversa.server import Emitter, make_server


def web_dir() -> Path:
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) / "web" if base else Path(__file__).resolve().parent.parent / "web"


def watch_parent(pid: int, on_gone) -> None:
    def wait() -> None:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000, False, pid)
        if handle:
            kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
            kernel32.CloseHandle(handle)
        on_gone()

    threading.Thread(target=wait, daemon=True).start()


def run(argv: list[str], environ: Mapping[str, str], out: TextIO) -> int:
    parser = argparse.ArgumentParser(prog="conversa-helper")
    parser.add_argument("--port", type=int, default=47811)
    parser.add_argument("--no-window", action="store_true")
    args = parser.parse_args(argv)
    emit = Emitter(out)
    token = environ.get("CONVERSA_TOKEN", "")
    if not token:
        emit({"type": "error", "message": "CONVERSA_TOKEN ausente"})
        return 2
    voice = Voice(VoiceConfig.from_env(environ))
    stop = threading.Event()
    try:
        server = make_server(args.port, token, voice, out, web_dir(), on_quit=stop.set)
    except OSError:
        emit({"type": "error", "message": f"a porta {args.port} está ocupada por outro programa"})
        return 2
    server.emit = emit
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    watch_parent(os.getppid(), stop.set)
    emit({"type": "ready", "port": port})
    window = None
    if not args.no_window:
        from conversa.window import EdgeWindow

        window = EdgeWindow()
        try:
            window.start(f"http://127.0.0.1:{port}/?t={token}")
        except OSError as exc:
            emit({"type": "error", "message": str(exc)})
            server.shutdown()
            return 2
        threading.Thread(target=lambda: (window.wait_closed(), stop.set()), daemon=True).start()
    stop.wait()
    if window is not None:
        closed_by_user = not window.stopping and window.closed()
        window.stop()
        if closed_by_user:
            emit({"type": "closed"})
    server.shutdown()
    return 0


def main() -> None:
    sys.exit(run(sys.argv[1:], os.environ, sys.stdout))


if __name__ == "__main__":
    main()
