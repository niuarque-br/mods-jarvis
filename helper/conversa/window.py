from __future__ import annotations

import ctypes
import os
import subprocess
import threading
import time
from ctypes import wintypes

TITLE = "Modo Jarvis"
WIDTH = 340
HEIGHT = 420
MARGIN = 16
CREATE_NO_WINDOW = 0x08000000
EDGE_CANDIDATES = [
    os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Microsoft", "Edge", "Application", "msedge.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
]


def edge_path() -> str | None:
    return next((path for path in EDGE_CANDIDATES if path and os.path.isfile(path)), None)


def profile_dir() -> str:
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "claude-modo-conversa", "edge")


def edge_args(url: str, profile: str, x: int, y: int) -> list[str]:
    return [
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={WIDTH},{HEIGHT}",
        f"--window-position={x},{y}",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-background-mode",
        "--autoplay-policy=no-user-gesture-required",
        "--no-first-run",
        "--no-default-browser-check",
    ]


def work_area() -> tuple[int, int, int, int]:
    rect = wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0)
    return rect.left, rect.top, rect.right, rect.bottom


def corner_position() -> tuple[int, int]:
    _, _, right, bottom = work_area()
    return right - WIDTH - MARGIN, bottom - HEIGHT - MARGIN


def find_window(title: str = TITLE) -> int | None:
    user32 = ctypes.windll.user32
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == title and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    return found[0] if found else None


def make_topmost(title: str = TITLE, timeout: float = 10) -> bool:
    user32 = ctypes.windll.user32
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = find_window(title)
        if hwnd:
            return bool(user32.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010))
        time.sleep(0.2)
    return False


def kill_profile_instances(profile: str) -> None:
    script = (
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*{profile}*' }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        timeout=20,
        creationflags=CREATE_NO_WINDOW,
    )


class EdgeWindow:
    def __init__(self) -> None:
        self.process: subprocess.Popen | None = None
        self.profile = profile_dir()
        self.stopping = False
        self._closed = threading.Event()

    def start(self, url: str) -> None:
        exe = edge_path()
        if exe is None:
            raise OSError("Microsoft Edge não encontrado")
        os.makedirs(self.profile, exist_ok=True)
        kill_profile_instances(self.profile)
        x, y = corner_position()
        self.process = subprocess.Popen([exe, *edge_args(url, self.profile, x, y)], creationflags=CREATE_NO_WINDOW)
        threading.Thread(target=self._watch, daemon=True).start()

    def _watch(self) -> None:
        seen = make_topmost()
        missing = 0
        while not self._closed.is_set():
            time.sleep(0.5)
            exited = self.process is not None and self.process.poll() is not None
            if seen:
                missing = missing + 1 if find_window() is None else 0
            if (exited and not seen) or missing >= 3:
                self._closed.set()

    def closed(self) -> bool:
        return self._closed.is_set()

    def wait_closed(self) -> None:
        self._closed.wait()

    def stop(self) -> None:
        self.stopping = True
        if self.process is not None and self.process.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.process.pid)], capture_output=True, creationflags=CREATE_NO_WINDOW)
        kill_profile_instances(self.profile)
        self._closed.set()
