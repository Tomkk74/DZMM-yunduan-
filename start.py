#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键启动：清理旧进程 → 控制台 →（可选）游戏预览 → 打开浏览器。

用法：
  python start.py
  python start.py --no-preview
  python start.py --no-open
双击 start.bat 等同于本脚本。
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_CONSOLE_PORT = 8788
DEFAULT_PREVIEW_PORT = 8791
CONSOLE_SCRIPT = ROOT / "console.py"


def _load_ports() -> tuple[int, int]:
    console_port = DEFAULT_CONSOLE_PORT
    preview_port = DEFAULT_PREVIEW_PORT
    cfg_path = ROOT / "config.json"
    if cfg_path.is_file():
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("preview_port") is not None:
                preview_port = int(data["preview_port"] or DEFAULT_PREVIEW_PORT)
        except Exception:
            pass
    return console_port, preview_port


def _pids_listening(port: int) -> list[int]:
    pids: set[int] = set()
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["netstat", "-ano", "-p", "tcp"],
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
        except Exception:
            return []
        want = int(port)
        for line in out.splitlines():
            if "LISTENING" not in line.upper():
                continue
            # 匹配本机绑定 …:port（避免 ":88" 误杀 ":8788"）
            parts = line.split()
            if len(parts) < 5:
                continue
            local = parts[1] if parts[0].upper().startswith("TCP") else parts[0]
            hostport = local.rsplit(":", 1)
            if len(hostport) != 2:
                continue
            try:
                if int(hostport[1]) != want:
                    continue
                pid = int(parts[-1])
            except ValueError:
                continue
            if pid > 0:
                pids.add(pid)
        return sorted(pids)

    try:
        out = subprocess.check_output(
            ["lsof", f"-iTCP:{int(port)}", "-sTCP:LISTEN", "-t"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                pids.add(int(line))
    except Exception:
        pass
    return sorted(pids)


def _kill_pid(pid: int) -> None:
    if pid <= 0 or pid == os.getpid():
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass


def free_port(port: int, label: str) -> None:
    pids = _pids_listening(port)
    if not pids:
        print(f"[start] {label} :{port} 空闲")
        return
    print(f"[start] 释放 {label} :{port} → PID {', '.join(map(str, pids))}")
    for pid in pids:
        _kill_pid(pid)
    deadline = time.time() + 5
    while time.time() < deadline:
        if not _pids_listening(port):
            break
        time.sleep(0.2)
    left = _pids_listening(port)
    if left:
        print(f"[start] 警告：:{port} 仍被占用 PID {left}", file=sys.stderr)


def wait_http(url: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if 200 <= int(resp.status) < 500:
                    return True
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            pass
        time.sleep(0.25)
    return False


def main() -> int:
    console_port, preview_port = _load_ports()
    ap = argparse.ArgumentParser(description="DZMM 本地开发一键启动")
    ap.add_argument("--port", type=int, default=console_port, help="控制台端口")
    ap.add_argument("--preview-port", type=int, default=preview_port, help="预览端口（仅用于清理）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--no-preview", action="store_true", help="不自动启动游戏预览")
    ap.add_argument("--no-kill", action="store_true", help="不清理占用端口的旧进程")
    args = ap.parse_args()

    if not CONSOLE_SCRIPT.is_file():
        print(f"[start] 找不到 {CONSOLE_SCRIPT}", file=sys.stderr)
        return 1

    print()
    print("========================================")
    print("  DZMM 本地开发 · 一键启动")
    print("========================================")
    print(f"  控制台  http://127.0.0.1:{args.port}/")
    print(f"  预览口  {args.preview_port}（登录且项目就绪时自动拉起）")
    print("========================================")
    print()

    if not args.no_kill:
        free_port(args.port, "控制台")
        free_port(args.preview_port, "预览")

    cmd = [
        sys.executable,
        "-u",
        str(CONSOLE_SCRIPT),
        "--port",
        str(args.port),
        "--no-open",
    ]
    if not args.no_preview:
        cmd.append("--auto-preview")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    print(f"[start] 启动控制台…")
    try:
        proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env)
    except OSError as e:
        print(f"[start] 无法启动：{e}", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{args.port}/"
    if not wait_http(url, timeout=25):
        print("[start] 控制台未在时限内就绪，请查看上方报错", file=sys.stderr)
        if proc.poll() is None:
            _kill_pid(proc.pid)
        return 1

    print(f"[start] 已就绪 {url}")
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    print("[start] 保持本窗口开着；关闭或 Ctrl+C 将停止全部服务")
    print()

    def _shutdown(*_args) -> None:
        if proc.poll() is None:
            print("\n[start] 正在停止…")
            _kill_pid(proc.pid)
        if not args.no_kill:
            free_port(args.port, "控制台")
            free_port(args.preview_port, "预览")

    if sys.platform != "win32":
        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

    try:
        code = proc.wait()
    except KeyboardInterrupt:
        _shutdown()
        code = 0
    finally:
        if proc.poll() is None:
            _kill_pid(proc.pid)
        if not args.no_kill:
            # 控制台退出后顺带清掉其拉起的预览
            free_port(args.preview_port, "预览")

    return int(code or 0)


if __name__ == "__main__":
    raise SystemExit(main())
