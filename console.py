#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DZMM 本地开发控制台：Web 填写账号并登录。"""
from __future__ import annotations

import argparse
import json
import mimetypes
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KIT = Path(__file__).resolve().parent
sys.path.insert(0, str(KIT / "lib"))
import dzmm_studio as studio  # noqa: E402
import dzmm_character as character  # noqa: E402
import pull_container as puller  # noqa: E402

WEB_DIR = KIT / "web"
DEFAULT_PORT = 8788

_PULL_LOCK = threading.Lock()
_PULL_JOB: dict = {
    "running": False,
    "phase": "",
    "message": "",
    "current": 0,
    "total": 0,
    "ok": 0,
    "fail": 0,
    "out": "",
    "error": "",
    "done": False,
    "result": None,
    "logs": [],
}

_PREVIEW_LOCK = threading.Lock()
_PREVIEW_PROC: subprocess.Popen | None = None
_PREVIEW_META: dict = {
    "running": False,
    "port": 8791,
    "url": "",
    "characterId": 0,
    "projectPath": "",
    "pid": 0,
    "error": "",
    "message": "",
}

_SYNC_LOCK = threading.Lock()
_SYNC_JOB: dict = {
    "running": False,
    "phase": "",
    "message": "",
    "current": 0,
    "total": 0,
    "ok": 0,
    "fail": 0,
    "error": "",
    "done": False,
    "fails": [],
    "gameId": "",
}


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(raw)


def _read_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _mask_email(email: str) -> str:
    email = (email or "").strip()
    if "@" not in email:
        return email
    name, domain = email.split("@", 1)
    if len(name) <= 2:
        return name[:1] + "***@" + domain
    return name[:2] + "***@" + domain


def build_status() -> dict:
    studio.refresh_root()
    cfg = studio.load_config()
    env = studio._read_env_map()
    email = (env.get("email") or "").strip()
    has_password = bool(env.get("password"))
    logged_in = False
    remain = 0
    auth_email = ""
    error = ""
    try:
        if env.get("cookie") or (email and has_password):
            _cookie, _token, remain, auth_email = studio.load_auth(min_remain=0)
            logged_in = remain > 0
    except SystemExit as e:
        error = str(e)
    except Exception as e:
        error = str(e)

    project = str(studio.project_root())
    cid = int(cfg.get("character_id") or 0)
    project_path = project if project != str(studio.KIT_ROOT) else (cfg.get("project_path") or "")
    if project_path:
        project_path = str(studio.normalize_project_root(project_path))
    return {
        "ok": True,
        "loggedIn": logged_in,
        "remainSec": max(0, int(remain)),
        "email": auth_email or email,
        "emailMasked": _mask_email(auth_email or email),
        "hasPassword": has_password,
        "characterId": cid,
        "projectPath": project_path,
        "previewPort": int(cfg.get("preview_port") or 8791),
        "workbenchUrl": (
            f"{studio.ORIGIN}/studio/game-creation/workbench?character_id={cid}" if cid else ""
        ),
        "kitRoot": str(studio.KIT_ROOT),
        "publishIndexExists": (Path(project_path) / "publish" / "index.html").is_file() if project_path else False,
        "error": error,
        "preview": preview_snapshot(),
    }


def do_login(body: dict) -> dict:
    email = str(body.get("email") or "").strip()
    password = str(body.get("password") or "")
    save_password = bool(body.get("savePassword", True))
    character_id = body.get("characterId")
    project_path = body.get("projectPath")
    preview_port = body.get("previewPort")

    updates = {}
    if character_id is not None and str(character_id).strip() != "":
        updates["character_id"] = int(character_id)
    if project_path is not None:
        updates["project_path"] = str(project_path).strip()
    if preview_port is not None and str(preview_port).strip() != "":
        updates["preview_port"] = int(preview_port)
    if updates:
        studio.save_config(updates)

    env = studio._read_env_map()
    if not email:
        email = (env.get("email") or "").strip()
    if not password:
        password = env.get("password") or ""
    if not email or not password:
        return {"ok": False, "error": "请填写邮箱和密码"}

    try:
        fresh = studio.login_with_password(email, password)
        studio._save_env(
            cookie=fresh,
            email=email,
            password=password if save_password else "",
        )
        studio.refresh_root()
        _c, _t, remain, mail = studio.load_auth(min_remain=0)
        return {
            "ok": True,
            "email": mail,
            "remainSec": remain,
            "status": build_status(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_save_config(body: dict) -> dict:
    updates = {}
    if "characterId" in body:
        updates["character_id"] = int(body.get("characterId") or 0)
    if "projectPath" in body:
        updates["project_path"] = str(body.get("projectPath") or "").strip()
    if "previewPort" in body:
        updates["preview_port"] = int(body.get("previewPort") or 8791)
    studio.save_config(updates)
    env_email = (studio._read_env_map().get("email") or "").strip()
    if body.get("email"):
        studio._save_env(email=str(body["email"]).strip())
    elif env_email:
        studio._save_env(email=env_email)
    studio.refresh_root()
    return {"ok": True, "status": build_status()}


def do_logout() -> dict:
    studio._save_env(clear_cookie=True, cookie=None)
    return {"ok": True, "status": build_status()}


def do_ping_editor() -> dict:
    status = build_status()
    if not status["loggedIn"]:
        return {"ok": False, "error": "尚未登录", "status": status}
    cid = int(status["characterId"] or 0)
    if not cid:
        return {"ok": False, "error": "请先填写 character_id（卡 ID）", "status": status}
    try:
        cookie, token, remain, email = studio.load_auth()
        info, game_id = studio.ensure_editor(cookie, token, cid)
        return {
            "ok": True,
            "email": email,
            "remainSec": remain,
            "gameId": game_id,
            "editorStatus": info.get("status"),
            "containerId": info.get("containerId"),
            "workbenchUrl": f"{studio.ORIGIN}/studio/game-creation/workbench?character_id={cid}",
            "status": build_status(),
        }
    except SystemExit as e:
        return {"ok": False, "error": str(e), "status": status}
    except Exception as e:
        return {"ok": False, "error": str(e), "status": status}


def pull_job_snapshot() -> dict:
    with _PULL_LOCK:
        logs = list(_PULL_JOB.get("logs") or [])[-40:]
        failed = list(_PULL_JOB.get("failedPaths") or [])
        result = _PULL_JOB.get("result")
        out = _PULL_JOB.get("out") or ""
        if result and isinstance(result, dict) and result.get("failedPaths"):
            failed = list(result.get("failedPaths") or failed)
        if (not failed) and out and (not _PULL_JOB.get("running")):
            try:
                meta = puller.read_pull_meta(Path(out))
                failed = list(meta.get("failed_paths") or [])
                if failed and not _PULL_JOB.get("fail"):
                    _PULL_JOB["fail"] = len(failed)
            except Exception:
                pass
        return {
            "running": bool(_PULL_JOB.get("running")),
            "phase": _PULL_JOB.get("phase") or "",
            "message": _PULL_JOB.get("message") or "",
            "current": int(_PULL_JOB.get("current") or 0),
            "total": int(_PULL_JOB.get("total") or 0),
            "okCount": int(_PULL_JOB.get("ok") or 0),
            "failCount": int(_PULL_JOB.get("fail") or len(failed) or 0),
            "failedPaths": failed,
            "canRetryFailed": (not _PULL_JOB.get("running")) and len(failed) > 0,
            "out": out,
            "error": _PULL_JOB.get("error") or "",
            "done": bool(_PULL_JOB.get("done")),
            "result": _PULL_JOB.get("result"),
            "mode": _PULL_JOB.get("mode") or "",
            "logs": logs,
        }


def _pull_progress(payload: dict) -> None:
    with _PULL_LOCK:
        for key in ("phase", "message", "current", "total", "ok", "fail", "out"):
            if key in payload and payload[key] is not None:
                _PULL_JOB[key] = payload[key]
        msg = payload.get("message")
        if msg:
            logs = _PULL_JOB.setdefault("logs", [])
            logs.append(str(msg))
            if len(logs) > 200:
                del logs[:-120]


def _finish_pull_summary(summary: dict) -> None:
    failed = list(summary.get("failedPaths") or [])
    with _PULL_LOCK:
        _PULL_JOB["running"] = False
        _PULL_JOB["done"] = True
        _PULL_JOB["result"] = summary
        _PULL_JOB["out"] = summary.get("out") or ""
        _PULL_JOB["message"] = summary.get("message") or "拉取完成"
        _PULL_JOB["fail"] = int(summary.get("failed") or 0)
        _PULL_JOB["ok"] = int(summary.get("pulled") or 0)
        _PULL_JOB["failedPaths"] = failed
        _PULL_JOB["mode"] = summary.get("mode") or _PULL_JOB.get("mode") or ""
        if failed:
            _PULL_JOB["error"] = f"有 {len(failed)} 个文件失败"
        else:
            _PULL_JOB["error"] = ""


def _run_pull_job(character_id: int, out: str | None) -> None:
    try:
        out_path = Path(out).expanduser() if out else None
        summary = puller.pull_project(
            character_id,
            out_path,
            on_progress=_pull_progress,
        )
        _finish_pull_summary(summary)
    except Exception as e:
        with _PULL_LOCK:
            _PULL_JOB["running"] = False
            _PULL_JOB["done"] = True
            _PULL_JOB["error"] = str(e)
            _PULL_JOB["message"] = f"拉取失败：{e}"


def _run_retry_failed_job(character_id: int, out: str | None, failed_paths: list[str] | None) -> None:
    try:
        out_path = Path(out).expanduser() if out else None
        summary = puller.retry_failed(
            character_id,
            out_path,
            on_progress=_pull_progress,
            failed_paths=failed_paths,
        )
        _finish_pull_summary(summary)
    except Exception as e:
        with _PULL_LOCK:
            _PULL_JOB["running"] = False
            _PULL_JOB["done"] = True
            _PULL_JOB["error"] = str(e)
            _PULL_JOB["message"] = f"重试失败：{e}"


def _resolve_pull_target(body: dict, status: dict) -> tuple[int, str]:
    cid = body.get("characterId")
    if cid is None or str(cid).strip() == "":
        cid = status["characterId"]
    try:
        cid = int(cid or 0)
    except Exception:
        cid = 0
    out = str(body.get("projectPath") or body.get("out") or "").strip()
    if not out:
        out = str(status.get("projectPath") or "").strip()
    if not out and cid:
        out = str(puller.default_out_dir(cid))
    return cid, out


def do_start_pull(body: dict) -> dict:
    status = build_status()
    if not status["loggedIn"]:
        return {"ok": False, "error": "尚未登录", "status": status}

    cid, out = _resolve_pull_target(body, status)
    if not cid:
        return {"ok": False, "error": "请先填写 character_id", "status": status}

    studio.save_config({
        "character_id": cid,
        "project_path": out or str(puller.default_out_dir(cid)),
    })

    with _PULL_LOCK:
        if _PULL_JOB.get("running"):
            pull_busy = True
        else:
            pull_busy = False
            _PULL_JOB.update({
                "running": True,
                "phase": "start",
                "message": "开始拉取容器…",
                "current": 0,
                "total": 0,
                "ok": 0,
                "fail": 0,
                "failedPaths": [],
                "mode": "full",
                "out": out or str(puller.default_out_dir(cid)),
                "error": "",
                "done": False,
                "result": None,
                "logs": ["开始拉取容器完整项目…"],
            })
    if pull_busy:
        return {"ok": False, "error": "已有拉取任务进行中", "job": pull_job_snapshot(), "status": status}

    thread = threading.Thread(
        target=_run_pull_job,
        args=(cid, out or None),
        daemon=True,
    )
    thread.start()
    return {
        "ok": True,
        "message": "拉取已开始",
        "job": pull_job_snapshot(),
        "status": build_status(),
    }


def do_retry_failed_pull(body: dict) -> dict:
    status = build_status()
    if not status["loggedIn"]:
        return {"ok": False, "error": "尚未登录", "status": status}

    cid, out = _resolve_pull_target(body, status)
    if not cid:
        return {"ok": False, "error": "请先填写 character_id", "status": status}

    failed_paths = body.get("failedPaths")
    if not isinstance(failed_paths, list):
        failed_paths = None
    if not failed_paths:
        with _PULL_LOCK:
            result = _PULL_JOB.get("result") or {}
            failed_paths = list(_PULL_JOB.get("failedPaths") or [])
            if not failed_paths and isinstance(result, dict):
                failed_paths = list(result.get("failedPaths") or [])
    if not failed_paths:
        # 再读磁盘 meta
        out_dir = Path(out) if out else puller.default_out_dir(cid)
        meta = puller.read_pull_meta(out_dir)
        failed_paths = list(meta.get("failed_paths") or [])
    if not failed_paths:
        return {"ok": False, "error": "没有失败文件可重试", "job": pull_job_snapshot(), "status": status}

    studio.save_config({"character_id": cid, "project_path": out})

    with _PULL_LOCK:
        if _PULL_JOB.get("running"):
            pull_busy = True
        else:
            pull_busy = False
            _PULL_JOB.update({
                "running": True,
                "phase": "start",
                "message": f"重试失败文件 {len(failed_paths)} 个…",
                "current": 0,
                "total": len(failed_paths),
                "ok": 0,
                "fail": 0,
                "failedPaths": list(failed_paths),
                "mode": "retry",
                "out": out,
                "error": "",
                "done": False,
                "result": None,
                "logs": [f"只重拉失败文件（{len(failed_paths)}）…"],
            })
    if pull_busy:
        return {"ok": False, "error": "已有拉取任务进行中", "job": pull_job_snapshot(), "status": status}

    thread = threading.Thread(
        target=_run_retry_failed_job,
        args=(cid, out or None, list(failed_paths)),
        daemon=True,
    )
    thread.start()
    return {
        "ok": True,
        "message": "已开始重试失败文件",
        "job": pull_job_snapshot(),
        "status": build_status(),
    }


def _port_in_use(port: int) -> bool:
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.3)
    try:
        return sock.connect_ex(("127.0.0.1", int(port))) == 0
    finally:
        try:
            sock.close()
        except Exception:
            pass


def preview_snapshot() -> dict:
    global _PREVIEW_PROC
    with _PREVIEW_LOCK:
        running = False
        if _PREVIEW_PROC is not None:
            code = _PREVIEW_PROC.poll()
            if code is None:
                running = True
            else:
                if not _PREVIEW_META.get("error"):
                    _PREVIEW_META["error"] = f"预览进程已退出 code={code}"
                    _PREVIEW_META["message"] = _PREVIEW_META["error"]
                _PREVIEW_PROC = None
                _PREVIEW_META["pid"] = 0
        port = int(_PREVIEW_META.get("port") or 8791)
        url = _PREVIEW_META.get("url") or f"http://127.0.0.1:{port}/"
        # 进程句柄丢失时，用端口探测兜底（避免 UI 显示未启动但服务已在听）
        if not running and _port_in_use(port):
            running = True
            if not _PREVIEW_META.get("message"):
                _PREVIEW_META["message"] = f"预览运行中 {url}"
        _PREVIEW_META["running"] = running
        _PREVIEW_META["url"] = url if running or _PREVIEW_META.get("url") else ""
        return dict(_PREVIEW_META)


def _kill_port_listeners(port: int) -> None:
    """Best-effort: stop whatever is listening on preview port (Windows)."""
    try:
        import subprocess as sp

        out = sp.check_output(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue)."
             "OwningProcess | Select-Object -Unique"],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
        )
        for line in out.splitlines():
            line = line.strip()
            if not line.isdigit():
                continue
            pid = int(line)
            if pid <= 0:
                continue
            try:
                sp.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=8)
            except Exception:
                pass
    except Exception:
        pass


def _stop_preview_locked() -> None:
    global _PREVIEW_PROC
    proc = _PREVIEW_PROC
    _PREVIEW_PROC = None
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        except Exception:
            pass
    port = int(_PREVIEW_META.get("port") or 8791)
    if _port_in_use(port):
        _kill_port_listeners(port)
    _PREVIEW_META.update({
        "running": False,
        "pid": 0,
        "url": "",
        "message": "预览已停止",
        "error": "",
    })


def do_stop_preview() -> dict:
    with _PREVIEW_LOCK:
        _stop_preview_locked()
    return {"ok": True, "preview": preview_snapshot(), "status": build_status()}


def _preview_http_json(path: str, method: str = "GET", body: dict | None = None, timeout: float = 20):
    snap = preview_snapshot()
    if not snap.get("running") or not snap.get("url"):
        raise RuntimeError("预览未启动")
    base = str(snap["url"]).rstrip("/")
    url = base + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8", "replace") or "{}")


def do_bridge_status() -> dict:
    preview = preview_snapshot()
    if not preview.get("running"):
        return {
            "ok": False,
            "error": "预览未启动",
            "preview": preview,
            "bridge": None,
        }
    try:
        health = _preview_http_json("/health")
        return {"ok": True, "preview": preview, "bridge": health}
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "preview": preview,
            "bridge": None,
        }


def do_bridge_publish(body: dict) -> dict:
    preview = preview_snapshot()
    if not preview.get("running"):
        # 预览未开时，直接走 studio publish
        status = build_status()
        if not status["loggedIn"]:
            return {"ok": False, "error": "尚未登录"}
        cid = int(status.get("characterId") or 0)
        if not cid:
            return {"ok": False, "error": "缺少 character_id"}
        try:
            cookie, token, remain, email = studio.load_auth()
            studio.ensure_editor(cookie, token, cid)
            studio.publish(cookie, token, cid)
            return {
                "ok": True,
                "message": "已发布到线上玩家版",
                "via": "studio",
                "remainSec": remain,
                "email": email,
            }
        except SystemExit as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    try:
        job = _preview_http_json(
            "/_dzmm/studio/publish",
            method="POST",
            body={"message": str((body or {}).get("message") or "publish from local console")},
            timeout=30,
        )
        return {"ok": True, "job": job, "via": "preview"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_bridge_publish_status() -> dict:
    preview = preview_snapshot()
    if not preview.get("running"):
        return {"ok": True, "job": {"status": "idle"}, "preview": preview}
    try:
        job = _preview_http_json("/_dzmm/studio/publish", method="GET", timeout=15)
        return {"ok": True, "job": job, "preview": preview}
    except Exception as e:
        return {"ok": False, "error": str(e), "preview": preview}


def sync_job_snapshot() -> dict:
    with _SYNC_LOCK:
        return {
            "running": bool(_SYNC_JOB.get("running")),
            "phase": _SYNC_JOB.get("phase") or "",
            "message": _SYNC_JOB.get("message") or "",
            "current": int(_SYNC_JOB.get("current") or 0),
            "total": int(_SYNC_JOB.get("total") or 0),
            "okCount": int(_SYNC_JOB.get("ok") or 0),
            "failCount": int(_SYNC_JOB.get("fail") or 0),
            "error": _SYNC_JOB.get("error") or "",
            "done": bool(_SYNC_JOB.get("done")),
            "fails": list(_SYNC_JOB.get("fails") or []),
            "gameId": _SYNC_JOB.get("gameId") or "",
        }


def _sync_set(**kwargs) -> None:
    with _SYNC_LOCK:
        _SYNC_JOB.update(kwargs)


def _run_sync_job(cid: int, message: str, only, full: bool = False) -> None:
    try:
        _sync_set(phase="scan", message="扫描变更…", current=0, total=0, ok=0, fail=0, error="", fails=[])
        studio.refresh_root()
        cookie, token, remain, email = studio.load_auth()
        _, game_id = studio.ensure_editor(cookie, token, cid)
        _sync_set(gameId=str(game_id or ""), phase="auth", message="连接编辑器…")

        files = studio.list_local_files()
        if isinstance(only, list) and only:
            only_set = {str(p).replace("\\", "/") for p in only}
            files = [f for f in files if f.relative_to(studio.ROOT).as_posix() in only_set]
        if not files:
            _sync_set(
                running=False,
                done=True,
                phase="error",
                error="没有可同步的文件（检查本地项目路径是否含 publish/）",
                message="同步失败",
            )
            return

        to_upload, meta, mode = studio.select_files_to_sync(files, full=bool(full))
        if mode == "baseline":
            _sync_set(
                running=False,
                done=True,
                phase="done",
                message=f"已建立增量基线（{len(meta.get('files') or {})} 个），无文件需上传",
                ok=0,
                fail=0,
                error="",
                current=0,
                total=0,
            )
            return
        if not to_upload:
            _sync_set(
                running=False,
                done=True,
                phase="done",
                message="无变更文件，已跳过",
                ok=0,
                fail=0,
                error="",
                current=0,
                total=0,
            )
            return

        total = len(to_upload)
        _sync_set(
            phase="upload",
            message=f"增量上传 0/{total}（共扫描 {len(files)}）",
            current=0,
            total=total,
        )
        ok = fail = 0
        fails: list[str] = []
        entries = dict(meta.get("files") or {})
        for i, path in enumerate(to_upload, start=1):
            rel = path.relative_to(studio.ROOT).as_posix()
            try:
                studio.upload_file(cookie, token, game_id, path)
                entries[rel] = studio._file_sig(path)
                ok += 1
            except Exception as e:
                fail += 1
                if len(fails) < 8:
                    fails.append(f"{rel}: {e}")
            _sync_set(
                current=i,
                ok=ok,
                fail=fail,
                fails=list(fails),
                message=f"增量上传 {i}/{total}" + (f"（失败 {fail}）" if fail else ""),
            )

        meta["files"] = entries
        meta["character_id"] = cid
        studio.save_sync_meta(meta)

        if fail:
            _sync_set(
                running=False,
                done=True,
                phase="error",
                error=f"部分失败：成功 {ok}，失败 {fail}",
                message=f"同步结束：成功 {ok}，失败 {fail}",
                ok=ok,
                fail=fail,
                fails=fails,
            )
            return

        _sync_set(phase="git", message="保存容器 git…")
        studio.git_save(cookie, token, game_id, message)
        _sync_set(
            running=False,
            done=True,
            phase="done",
            message=f"已增量同步 {ok} 个文件并保存",
            ok=ok,
            fail=0,
            error="",
        )
    except SystemExit as e:
        _sync_set(running=False, done=True, phase="error", error=str(e), message=f"同步失败：{e}")
    except Exception as e:
        _sync_set(running=False, done=True, phase="error", error=str(e), message=f"同步失败：{e}")


def do_start_sync(body: dict) -> dict:
    """Start background incremental sync to Workbench + git save."""
    status = build_status()
    if not status.get("loggedIn"):
        return {"ok": False, "error": "尚未登录", "job": sync_job_snapshot()}

    cid = body.get("characterId")
    if cid is None or str(cid).strip() == "":
        cid = status.get("characterId")
    try:
        cid = int(cid or 0)
    except Exception:
        cid = 0
    if not cid:
        return {"ok": False, "error": "缺少 character_id", "job": sync_job_snapshot()}

    project = str(body.get("projectPath") or status.get("projectPath") or "").strip()
    if project:
        studio.save_config({"character_id": cid, "project_path": project})
    else:
        studio.save_config({"character_id": cid})

    message = str((body or {}).get("message") or "sync from local console").strip() or "sync from local console"
    only = (body or {}).get("only")
    full = bool((body or {}).get("full"))

    with _SYNC_LOCK:
        if _SYNC_JOB.get("running"):
            busy = True
        else:
            busy = False
            _SYNC_JOB.update({
                "running": True,
                "phase": "start",
                "message": "正在启动同步…",
                "current": 0,
                "total": 0,
                "ok": 0,
                "fail": 0,
                "error": "",
                "done": False,
                "fails": [],
                "gameId": "",
            })
    if busy:
        return {"ok": False, "error": "已有同步任务进行中", "job": sync_job_snapshot()}

    thread = threading.Thread(
        target=_run_sync_job,
        args=(cid, message, only, full),
        name="dzmm-sync",
        daemon=True,
    )
    thread.start()
    return {"ok": True, "message": "同步已开始", "job": sync_job_snapshot()}


def do_card_list() -> dict:
    try:
        return {
            "ok": True,
            "cardsDir": str(character.cards_root()),
            "items": character.list_local_cards(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}


def do_card_chat_prompt(name: str = "", brief: str = "") -> dict:
    try:
        data = character.build_chat_prompt(name=name, brief=brief)
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_meta(card_id: int) -> dict:
    try:
        data = character.play_meta(int(card_id))
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_start(body: dict) -> dict:
    try:
        card_id = int(body.get("cardId") or 0)
        idx = body.get("chatHistoryIndex")
        if idx is not None and idx != "":
            try:
                idx = int(idx)
            except (TypeError, ValueError):
                idx = None
        else:
            idx = None
        data = character.play_start(card_id, chat_history_index=idx)
        # 拉首轮消息（开场）+ 会话设置
        msgs = {}
        try:
            msgs = character.play_messages(data["chatId"])
        except Exception as e:
            msgs = {"error": str(e)}
        settings = {}
        try:
            settings = character.play_get_settings(data["chatId"])
        except Exception as e:
            settings = {"error": str(e)}
        flat = character._flatten_play_messages(msgs if isinstance(msgs, dict) else {})
        return {
            "ok": True,
            **data,
            "messages": flat,
            "rawMessages": msgs,
            "settings": settings if isinstance(settings, dict) else {},
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_models() -> dict:
    try:
        data = character.play_models()
        return {"ok": True, "models": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_presets() -> dict:
    try:
        data = character.play_presets()
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_messages(chat_id: str) -> dict:
    try:
        data = character.play_messages(chat_id)
        flat = character._flatten_play_messages(data if isinstance(data, dict) else {})
        return {"ok": True, "messages": flat, "raw": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_settings_get(chat_id: str) -> dict:
    try:
        data = character.play_get_settings(chat_id)
        return {"ok": True, "settings": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_play_settings_update(body: dict) -> dict:
    try:
        chat_id = str(body.get("chatId") or "").strip()
        settings = body.get("settings")
        if not isinstance(settings, dict):
            settings = {k: v for k, v in body.items() if k != "chatId"}
        data = character.play_update_settings(chat_id, settings)
        # 再拉一遍最新设置
        fresh = {}
        try:
            fresh = character.play_get_settings(chat_id)
        except Exception:
            fresh = data if isinstance(data, dict) else {}
        return {"ok": True, "settings": fresh, "raw": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _proxy_card_play_generate(handler, body: dict) -> None:
    """把 POST /api/chat 的 SSE 流式结果转给前端。"""
    try:
        chat_id = str(body.get("chatId") or "").strip()
        card_id = body.get("cardId")
        content = str(body.get("content") or "")
        if not chat_id:
            _json(handler, 400, {"ok": False, "error": "缺少 chatId"})
            return
        if card_id is None or card_id == "":
            _json(handler, 400, {"ok": False, "error": "缺少 cardId"})
            return
        if not content.strip():
            _json(handler, 400, {"ok": False, "error": "消息不能为空"})
            return
        preset_ids = body.get("presetIds")
        if not isinstance(preset_ids, list):
            preset_ids = []
        prompts = body.get("prompts")
        if not isinstance(prompts, list):
            prompts = []
        gen_body = character.build_generate_body(
            chat_id=chat_id,
            card_id=card_id,
            content=content,
            model=body.get("model") or None,
            max_tokens=body.get("maxTokens"),
            deep_thinking=bool(body.get("deepThinking")),
            enable_memory_enhance=bool(body.get("enableMemoryEnhance")),
            style=body.get("style") or None,
            image_generation_model=body.get("imageGenerationModel") or None,
            preset_ids=[str(x) for x in preset_ids],
            player_info=body.get("playerInfo") or None,
            prompts=prompts,
        )
        st, resp, hdr = character.play_generate_request(gen_body)
        if st != 200:
            err_raw = b""
            try:
                err_raw = resp.read() if hasattr(resp, "read") else b""
            except Exception:
                pass
            try:
                err_obj = json.loads(err_raw.decode("utf-8", "replace"))
            except Exception:
                err_obj = {"error": err_raw.decode("utf-8", "replace")[:800]}
            _json(handler, st if st >= 400 else 400, {"ok": False, "status": st, **(err_obj if isinstance(err_obj, dict) else {"error": err_obj})})
            return

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache, no-transform")
        handler.send_header("Connection", "close")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()

        # 透传上游 SSE；同时规范化方便前端
        try:
            if hasattr(resp, "fp") and hasattr(resp.fp, "read"):
                # HTTPResponse: iter lines
                buf = b""
                while True:
                    chunk = resp.read(1024)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        handler.wfile.write(line + b"\n")
                        handler.wfile.flush()
                if buf:
                    handler.wfile.write(buf)
                    handler.wfile.flush()
            else:
                data = resp.read() if hasattr(resp, "read") else b""
                handler.wfile.write(data)
                handler.wfile.flush()
        finally:
            try:
                resp.close()
            except Exception:
                pass
    except Exception as e:
        if not handler.wfile.closed:
            try:
                _json(handler, 500, {"ok": False, "error": str(e)})
            except Exception:
                pass


def do_card_get(local_id: str) -> dict:
    try:
        card = character.load_local(local_id)
        lid = (card.get("_meta") or {}).get("localId") or local_id
        return {
            "ok": True,
            "localId": lid,
            "folder": (card.get("_meta") or {}).get("folder") or "",
            "mtime": float((card.get("_meta") or {}).get("mtime") or 0),
            "sig": character.folder_fingerprint(str(lid)),
            "card": card,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_new(body: dict) -> dict:
    try:
        # 空白新建：必须带卡名；不沿用上一张卡的简述
        blank = body.get("blank")
        if blank is None:
            blank = True
        blank = bool(blank)
        name = str(body.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "必须填写卡名才能新建"}
        brief = "" if blank else str(body.get("brief") or "").strip()
        saved = character.create_local(name, brief=brief, blank=blank)
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_save(body: dict) -> dict:
    try:
        card = body.get("card")
        local_id = body.get("localId")
        if not isinstance(card, dict):
            return {"ok": False, "error": "缺少 card 对象"}
        # 允许前端只提交 data 字段
        if "data" not in card and any(k in card for k in ("name", "description", "personality")):
            base = character.empty_card(str(card.get("name") or "未命名角色"))
            for k in (
                "name",
                "description",
                "personality",
                "scenario",
                "first_mes",
                "tags",
                "creator_notes",
            ):
                if k in card:
                    base["data"][k] = card[k]
            if isinstance(body.get("meta"), dict):
                base["_meta"].update(body["meta"])
            card = base
        brief = str(body.get("brief") or (card.get("_meta") or {}).get("brief") or "")
        saved = character.save_local(card, local_id=str(local_id or "").strip() or None)
        # 再写一遍 brief（save_local 已带 meta.brief；这里保证 body.brief 优先生效）
        if brief:
            saved = character.write_folder(saved["card"], local_id=saved["localId"], brief=brief)
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_ai(body: dict) -> dict:
    """不再调平台 AI：按卡名创建/打开「卡/<名>/」，供本地编辑 txt。"""
    try:
        brief = str(body.get("brief") or "").strip()
        name = str(body.get("name") or "").strip()
        if not name:
            # 从简述第一行猜卡名
            first = (brief.splitlines()[0] if brief else "").strip()
            name = first[:40] if first else "未命名角色"
        saved = character.prepare_workspace(name, brief=brief)
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
            "created": bool(saved.get("created")),
            "hint": f"请编辑本地文件：{saved['path']}\\*.txt（网页会实时同步）",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_poll(local_id: str, since_mtime: float = 0.0, since_sig: str = "") -> dict:
    try:
        data = character.poll_local(local_id, since_mtime=since_mtime, since_sig=since_sig)
        data["ok"] = True
        return data
    except Exception as e:
        return {"ok": False, "error": str(e), "changed": False}


def do_card_avatar(body: dict) -> dict:
    try:
        local_id = str(body.get("localId") or body.get("name") or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId（卡名）"}
        data_b64 = str(body.get("dataBase64") or body.get("data") or "")
        if not data_b64:
            return {"ok": False, "error": "缺少图片 dataBase64"}
        saved = character.save_local_avatar_b64(
            local_id,
            data_b64,
            filename=str(body.get("filename") or ""),
            mime=str(body.get("mime") or ""),
        )
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved.get("folder") or saved["path"],
            "mtime": saved.get("mtime") or 0,
            "rel": saved.get("rel"),
            "avatarUrl": saved.get("avatarUrl"),
            "serveUrl": saved.get("serveUrl"),
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_image(body: dict) -> dict:
    try:
        local_id = str(body.get("localId") or body.get("name") or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId（卡名）"}
        action = str(body.get("action") or "add").strip().lower()
        if action == "remove":
            saved = character.remove_local_image(local_id, int(body.get("index")))
            return {
                "ok": True,
                "localId": saved["localId"],
                "path": saved["path"],
                "folder": saved.get("folder") or saved["path"],
                "mtime": saved.get("mtime") or 0,
                "card": saved["card"],
            }
        data_b64 = str(body.get("dataBase64") or body.get("data") or "")
        if not data_b64:
            return {"ok": False, "error": "缺少图片 dataBase64"}
        saved = character.save_local_image(
            local_id,
            data_b64=data_b64,
            filename=str(body.get("filename") or ""),
            mime=str(body.get("mime") or ""),
            name=str(body.get("name") or ""),
            set_avatar=bool(body.get("setAvatar")),
        )
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved.get("folder") or saved["path"],
            "mtime": saved.get("mtime") or 0,
            "rel": saved.get("rel"),
            "serveUrl": saved.get("serveUrl"),
            "index": saved.get("index"),
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_voices() -> dict:
    try:
        data = character.list_platform_voices()
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e), "public": [], "mine": []}


def do_card_voice(body: dict) -> dict:
    try:
        local_id = str(body.get("localId") or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId"}
        if body.get("clear"):
            saved = character.set_voice_settings(local_id, None)
        else:
            voice = body.get("voice")
            if not isinstance(voice, dict) or not voice.get("id"):
                return {"ok": False, "error": "需要 voice 对象（含 id/name）"}
            saved = character.set_voice_settings(
                local_id,
                voice,
                settings=body.get("settings") if isinstance(body.get("settings"), dict) else None,
            )
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved.get("folder") or saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_export_png(local_id: str) -> dict:
    try:
        local_id = str(local_id or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId"}
        result = character.export_card_png(local_id, save_copy=True)
        return {"ok": True, **{k: v for k, v in result.items() if k != "bytes"}, "bytes": result["bytes"]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_delete_local(body: dict) -> dict:
    try:
        local_id = str(body.get("localId") or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId"}
        result = character.delete_local_card(local_id)
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_delete_cloud(body: dict) -> dict:
    """删云端草稿 / 下线已发布卡（可级联清同卡草稿）。"""
    try:
        cloud_id = int(body.get("cloudId") or body.get("id") or 0)
        if cloud_id <= 0:
            return {"ok": False, "error": "需要有效 cloudId"}
        is_draft = body.get("isDraft")
        if is_draft is not None:
            is_draft = bool(is_draft)
        character_id = body.get("characterId") or body.get("dbId")
        if character_id is not None:
            try:
                character_id = int(character_id)
            except (TypeError, ValueError):
                character_id = None
        also_hide = body.get("alsoHidePublished")
        if also_hide is None:
            also_hide = True
        cascade = body.get("cascadeDrafts")
        if cascade is None:
            cascade = True
        result = character.remove_cloud_card(
            cloud_id=cloud_id,
            is_draft=is_draft,
            also_hide_published=bool(also_hide),
            cascade_drafts=bool(cascade),
            character_id=character_id,
        )
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_publish(body: dict) -> dict:
    try:
        local_id = str(body.get("localId") or "").strip()
        if not local_id:
            return {"ok": False, "error": "需要 localId"}
        # 若前端带了最新表单，先落盘再发
        card = body.get("card")
        if isinstance(card, dict):
            brief = str(body.get("brief") or (card.get("_meta") or {}).get("brief") or "")
            character.save_local(card, local_id=local_id)
            if brief:
                character.write_folder(
                    character.load_local(local_id),
                    local_id=local_id,
                    brief=brief,
                )
        as_draft = bool(body.get("draft") or body.get("asDraft"))
        saved = character.publish_to_cloud(local_id, as_draft=as_draft)
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved.get("folder") or saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
            "mode": saved.get("mode"),
            "cloudId": saved.get("cloudId"),
            "characterUrl": saved.get("characterUrl") or "",
            "result": saved.get("result"),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_card_shelf(body: dict) -> dict:
    """广场上架：card.publish。下架请到官网。"""
    try:
        card_id = int(
            body.get("cardId")
            or body.get("cloudId")
            or body.get("id")
            or 0
        )
        if card_id <= 0:
            return {"ok": False, "error": "需要有效 cardId（先「保存到云端」拿到正式卡）"}
        listed = body.get("listed")
        if listed is None:
            action = str(body.get("action") or "publish").strip().lower()
            listed = action in ("publish", "shelf", "list", "上架")
        if listed is False or (isinstance(listed, str) and listed.lower() in ("false", "0", "unpublish", "unshelf")):
            return {"ok": False, "error": "控制台不支持下架，请到官网自行操作"}
        local_id = str(body.get("localId") or "").strip() or None
        result = character.shelf_cloud_card(
            card_id,
            listed=True,
            local_id=local_id,
        )
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _serve_card_asset(handler: BaseHTTPRequestHandler, local_id: str, rel: str) -> None:
    try:
        file_path = character.resolve_card_asset(local_id, rel)
    except Exception as e:
        _json(handler, 404, {"ok": False, "error": str(e)})
        return
    ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    raw = file_path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(raw)


def do_card_cloud_list(quick: bool = False) -> dict:
    try:
        items = character.list_cloud_cards(enrich_listing=not quick)
        return {"ok": True, "items": items, "quick": bool(quick)}
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}


def do_card_pull_cloud(body: dict) -> dict:
    try:
        cloud_id = int(body.get("cloudId") or 0)
        if cloud_id <= 0:
            return {"ok": False, "error": "需要有效 cloudId"}
        folder_name = str(body.get("name") or body.get("folderName") or "").strip() or None
        is_draft = body.get("isDraft")
        if is_draft is not None:
            is_draft = bool(is_draft)
        saved = character.pull_cloud_card(cloud_id, folder_name=folder_name, is_draft=is_draft)
        return {
            "ok": True,
            "localId": saved["localId"],
            "path": saved["path"],
            "folder": saved.get("folder") or saved["path"],
            "mtime": saved.get("mtime") or 0,
            "card": saved["card"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def do_start_preview(body: dict) -> dict:
    global _PREVIEW_PROC
    status = build_status()
    if not status["loggedIn"]:
        return {"ok": False, "error": "尚未登录", "status": status}

    cid = body.get("characterId")
    if cid is None or str(cid).strip() == "":
        cid = status["characterId"]
    try:
        cid = int(cid or 0)
    except Exception:
        cid = 0
    if not cid:
        return {"ok": False, "error": "请先填写 character_id", "status": status}

    project = str(body.get("projectPath") or status.get("projectPath") or "").strip()
    port = body.get("previewPort")
    if port is None or str(port).strip() == "":
        port = status.get("previewPort") or 8791
    try:
        port = int(port)
    except Exception:
        port = 8791

    if not project:
        project = str(puller.default_out_dir(cid))
    project_path = studio.normalize_project_root(project)
    index = project_path / "publish" / "index.html"
    if not index.is_file():
        return {
            "ok": False,
            "error": (
                f"本地没有 publish/index.html。请填「游戏项目根目录」"
                f"（内含 publish/），不要只填到 publish 子目录：{project_path}"
            ),
            "status": status,
        }

    studio.save_config({
        "character_id": cid,
        "project_path": str(project_path),
        "preview_port": port,
    })

    script = KIT / "lib" / "dzmm_preview_server.py"
    cmd = [
        sys.executable,
        str(script),
        "--character-id",
        str(cid),
        "--port",
        str(port),
        "--project-root",
        str(project_path),
        "--no-open",
    ]

    log_path = KIT / ".preview-server.log"
    try:
        log_fp = open(log_path, "w", encoding="utf-8", errors="replace")
    except OSError:
        log_fp = subprocess.DEVNULL

    with _PREVIEW_LOCK:
        _stop_preview_locked()
        try:
            # 日志写文件，避免 PIPE 塞满导致预览线程卡死 → 浏览器 ERR_EMPTY_RESPONSE
            proc = subprocess.Popen(
                cmd,
                cwd=str(KIT),
                stdout=log_fp,
                stderr=subprocess.STDOUT,
            )
        except Exception as e:
            if log_fp is not subprocess.DEVNULL:
                try:
                    log_fp.close()
                except Exception:
                    pass
            return {"ok": False, "error": f"无法启动预览：{e}", "status": build_status()}

        _PREVIEW_PROC = proc
        url = f"http://127.0.0.1:{port}/"
        _PREVIEW_META.update({
            "running": True,
            "port": port,
            "url": url,
            "characterId": cid,
            "projectPath": str(project_path),
            "pid": proc.pid,
            "error": "",
            "message": "正在启动预览…",
            "logPath": str(log_path),
        })

    # 用 /health 探测就绪，不再依赖 stdout 管道
    ready = False
    deadline = time.time() + 20
    last_err = ""
    while time.time() < deadline:
        if proc.poll() is not None:
            err = f"预览启动失败 exit={proc.returncode}"
            try:
                if log_path.is_file():
                    tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
                    if tail:
                        err = tail
            except Exception:
                pass
            with _PREVIEW_LOCK:
                _PREVIEW_PROC = None
                _PREVIEW_META.update({"running": False, "pid": 0, "error": err, "message": err})
            return {"ok": False, "error": err, "preview": preview_snapshot(), "status": build_status()}
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as resp:
                if resp.status == 200:
                    ready = True
                    break
        except Exception as e:
            last_err = str(e)
        time.sleep(0.15)

    with _PREVIEW_LOCK:
        if ready:
            _PREVIEW_META["message"] = f"预览已就绪 {url}"
        else:
            _PREVIEW_META["message"] = f"预览进程已启动（等待端口就绪）{(' · ' + last_err) if last_err else ''}"

    return {
        "ok": True,
        "url": url,
        "preview": preview_snapshot(),
        "status": build_status(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "DZMM-LocalDev/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[console] " + (fmt % args) + "\n")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        if path == "/api/status":
            payload = build_status()
            payload["pull"] = pull_job_snapshot()
            payload["sync"] = sync_job_snapshot()
            payload["preview"] = preview_snapshot()
            _json(self, 200, payload)
            return
        if path == "/api/ping":
            _json(self, 200, do_ping_editor())
            return
        if path == "/api/pull":
            _json(self, 200, {"ok": True, "job": pull_job_snapshot()})
            return
        if path == "/api/sync":
            _json(self, 200, {"ok": True, "job": sync_job_snapshot()})
            return
        if path == "/api/preview":
            _json(self, 200, {"ok": True, "preview": preview_snapshot()})
            return
        if path == "/api/bridge":
            _json(self, 200, do_bridge_status())
            return
        if path == "/api/bridge/publish":
            _json(self, 200, do_bridge_publish_status())
            return
        if path == "/api/card/list":
            _json(self, 200, do_card_list())
            return
        if path == "/api/card/chat-prompt":
            qs = urllib.parse.parse_qs(parsed.query or "")
            name = (qs.get("name") or [""])[0]
            brief = (qs.get("brief") or [""])[0]
            result = do_card_chat_prompt(name=name, brief=brief)
            _json(self, 200 if result.get("ok") else 404, result)
            return
        if path == "/api/card/get":
            qs = urllib.parse.parse_qs(parsed.query or "")
            local_id = (qs.get("id") or [""])[0]
            result = do_card_get(local_id)
            _json(self, 200 if result.get("ok") else 404, result)
            return
        if path == "/api/card/cloud":
            qs = urllib.parse.parse_qs(parsed.query or "")
            quick_raw = (qs.get("quick") or ["0"])[0]
            quick = str(quick_raw).lower() in ("1", "true", "yes")
            result = do_card_cloud_list(quick=quick)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/poll":
            qs = urllib.parse.parse_qs(parsed.query or "")
            local_id = (qs.get("id") or [""])[0]
            try:
                since = float((qs.get("since") or ["0"])[0] or 0)
            except Exception:
                since = 0.0
            since_sig = (qs.get("sig") or [""])[0] or ""
            result = do_card_poll(local_id, since_mtime=since, since_sig=since_sig)
            _json(self, 200 if result.get("ok") else 404, result)
            return
        if path == "/api/card/asset":
            qs = urllib.parse.parse_qs(parsed.query or "")
            local_id = (qs.get("id") or [""])[0]
            rel = (qs.get("path") or [""])[0]
            _serve_card_asset(self, local_id, rel)
            return
        if path == "/api/card/export-png":
            qs = urllib.parse.parse_qs(parsed.query or "")
            local_id = (qs.get("id") or [""])[0]
            result = do_card_export_png(local_id)
            if not result.get("ok"):
                _json(self, 400, {k: v for k, v in result.items() if k != "bytes"})
                return
            raw = result["bytes"]
            filename = str(result.get("filename") or "card.png")
            # RFC 5987 文件名
            star = urllib.parse.quote(filename)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"card.png\"; filename*=UTF-8''{star}",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/api/card/voices":
            result = do_card_voices()
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/meta":
            qs = urllib.parse.parse_qs(parsed.query or "")
            try:
                card_id = int((qs.get("cardId") or ["0"])[0] or 0)
            except Exception:
                card_id = 0
            result = do_card_play_meta(card_id)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/models":
            result = do_card_play_models()
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/presets":
            result = do_card_play_presets()
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/messages":
            qs = urllib.parse.parse_qs(parsed.query or "")
            chat_id = (qs.get("chatId") or [""])[0]
            result = do_card_play_messages(chat_id)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/settings":
            qs = urllib.parse.parse_qs(parsed.query or "")
            chat_id = (qs.get("chatId") or [""])[0]
            result = do_card_play_settings_get(chat_id)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        body = _read_body(self)
        if path == "/api/login":
            result = do_login(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/config":
            result = do_save_config(body)
            _json(self, 200, result)
            return
        if path == "/api/logout":
            _json(self, 200, do_logout())
            return
        if path == "/api/ping":
            result = do_ping_editor()
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/pull":
            result = do_start_pull(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/pull/retry":
            result = do_retry_failed_pull(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/preview/start":
            result = do_start_preview(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/preview/stop":
            _json(self, 200, do_stop_preview())
            return
        if path == "/api/bridge/publish":
            result = do_bridge_publish(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/sync":
            result = do_start_sync(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/new":
            result = do_card_new(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/save":
            result = do_card_save(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/ai":
            result = do_card_ai(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/pull":
            result = do_card_pull_cloud(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/avatar":
            result = do_card_avatar(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/image":
            result = do_card_image(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/voice":
            result = do_card_voice(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/publish":
            result = do_card_publish(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/shelf":
            result = do_card_shelf(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/delete":
            result = do_card_delete_local(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/cloud/delete":
            result = do_card_delete_cloud(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/start":
            result = do_card_play_start(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/settings":
            result = do_card_play_settings_update(body)
            _json(self, 200 if result.get("ok") else 400, result)
            return
        if path == "/api/card/play/send":
            _proxy_card_play_generate(self, body)
            return
        _json(self, 404, {"ok": False, "error": "not found"})

    def _serve_static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/").replace("\\", "/")
        if ".." in rel.split("/"):
            self.send_error(400)
            return
        file_path = (WEB_DIR / rel).resolve()
        if not str(file_path).startswith(str(WEB_DIR.resolve())) or not file_path.is_file():
            self.send_error(404)
            return
        data = file_path.read_bytes()
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description="DZMM local dev web console")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    studio.refresh_root()
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[console] DZMM 本地开发控制台: {url}")
    print("[console] 在网页填写邮箱/密码/character_id 后登录即可")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[console] stopped")


if __name__ == "__main__":
    main()
