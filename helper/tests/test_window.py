import os

from conversa import window
from conversa.window import WIDTH, HEIGHT, corner_position, edge_args, profile_dir


def test_profile_lives_in_localappdata(monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\x\AppData\Local")
    assert profile_dir() == os.path.join(r"C:\Users\x\AppData\Local", "claude-modo-conversa", "edge")


def test_edge_args():
    args = edge_args("http://127.0.0.1:47811/?t=abc", r"C:\p", 10, 20)
    assert "--app=http://127.0.0.1:47811/?t=abc" in args
    assert r"--user-data-dir=C:\p" in args
    assert f"--window-size={WIDTH},{HEIGHT}" in args
    assert "--window-position=10,20" in args
    for flag in (
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--no-first-run",
        "--no-default-browser-check",
    ):
        assert flag in args


def test_corner_position(monkeypatch):
    monkeypatch.setattr(window, "work_area", lambda: (0, 0, 1920, 1040))
    assert corner_position() == (1920 - WIDTH - 16, 1040 - HEIGHT - 16)


def test_edge_path_prefers_existing(monkeypatch, tmp_path):
    exe = tmp_path / "msedge.exe"
    exe.write_text("")
    monkeypatch.setattr(window, "EDGE_CANDIDATES", [str(tmp_path / "nada.exe"), str(exe)])
    assert window.edge_path() == str(exe)
    monkeypatch.setattr(window, "EDGE_CANDIDATES", [])
    assert window.edge_path() is None


def test_autoplay_without_gesture():
    assert "--autoplay-policy=no-user-gesture-required" in edge_args("u", "p", 0, 0)
