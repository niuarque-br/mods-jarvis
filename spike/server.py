import ctypes
import json
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os

PORT = 47811
HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = (HERE / "page.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        print("REPORT", data.decode("utf-8"), flush=True)
        self.send_response(204)
        self.end_headers()


def find_window(title):
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == title and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    return found[0] if found else None


def make_topmost(title, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = find_window(title)
        if hwnd:
            user32 = ctypes.windll.user32
            user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
            ok = user32.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
            user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
            ex = user32.GetWindowLongW(hwnd, -20)
            print("TOPMOST", bool(ok), bool(ex & 0x8), ctypes.GetLastError(), flush=True)
            return
        time.sleep(0.2)
    print("TOPMOST not found", flush=True)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("READY", PORT, flush=True)
    if "--no-window" not in sys.argv:
        profile = os.path.join(os.environ["LOCALAPPDATA"], "claude-modo-conversa", "spike-edge")
        subprocess.Popen([
            EDGE, f"--app=http://127.0.0.1:{PORT}/", f"--user-data-dir={profile}",
            "--window-size=340,420", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
            "--no-first-run", "--no-default-browser-check",
        ])
        make_topmost("Modo conversa spike")
    seconds = float(sys.argv[sys.argv.index("--seconds") + 1]) if "--seconds" in sys.argv else 40
    time.sleep(seconds)
    server.shutdown()


if __name__ == "__main__":
    main()
