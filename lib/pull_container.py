#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pull entire Game Studio container to a local directory."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Callable

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dzmm_studio as s  # noqa: E402

SKIP_NAMES = {".git", "node_modules", "__pycache__", ".DS_Store"}
ProgressCb = Callable[[dict], None]


def list_dir(cookie, token, game_id: str, path: str):
    q = urllib.parse.urlencode({"path": path})
    st, raw, _ = s.http(
        s.proxy_url(game_id, f"/files?{q}"),
        cookie,
        token,
        accept="application/json",
    )
    if st != 200:
        raise RuntimeError(f"list {path} HTTP {st}: {raw[:200]!r}")
    return json.loads(raw)


def norm_path(p: str) -> str:
    p = (p or "").replace("\\", "/")
    if not p.startswith("/"):
        p = "/" + p
    while "//" in p:
        p = p.replace("//", "/")
    return p


def walk(cookie, token, game_id: str, path: str = "/") -> list[dict]:
    entries = list_dir(cookie, token, game_id, path)
    files: list[dict] = []
    for e in entries:
        name = e.get("name") or ""
        p = norm_path(e.get("path") or "")
        if name in SKIP_NAMES:
            continue
        t = e.get("type")
        if t == "directory":
            files.extend(walk(cookie, token, game_id, p))
        elif t == "file":
            files.append({"path": p, "size": e.get("size") or 0, "name": name})
    return files


def download_raw(cookie, token, game_id: str, remote: str) -> bytes:
    q = urllib.parse.urlencode({"path": remote})
    st, raw, _ = s.http(
        s.proxy_url(game_id, f"/files/raw?{q}"),
        cookie,
        token,
        accept="*/*",
        timeout=180,
    )
    if st != 200:
        raise RuntimeError(f"download {remote} HTTP {st}: {raw[:200]!r}")
    return raw


def default_out_dir(character_id: int) -> Path:
    s.refresh_root()
    cfg = s.load_config()
    raw = (cfg.get("project_path") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    # 默认落到工具旁：../{character_id}
    return (KIT.parent / str(character_id)).resolve()


def read_pull_meta(out_dir: Path) -> dict:
    meta_path = Path(out_dir) / "_pull_meta.json"
    if not meta_path.is_file():
        return {}
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_pull_meta(out_dir: Path, meta: dict) -> None:
    (Path(out_dir) / "_pull_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def pull_paths(
    character_id: int,
    paths: list[str],
    out: Path | None = None,
    on_progress: ProgressCb | None = None,
    *,
    mode: str = "retry",
) -> dict:
    """Download only the given remote paths into out."""
    if not character_id:
        raise ValueError("缺少 character_id")
    remote_paths = []
    seen = set()
    for p in paths or []:
        np = norm_path(str(p or "").strip())
        if not np or np == "/" or np in seen:
            continue
        seen.add(np)
        remote_paths.append(np)
    if not remote_paths:
        raise ValueError("没有可重试的失败文件")

    out_dir = Path(out).expanduser().resolve() if out else default_out_dir(character_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    def emit(payload: dict) -> None:
        if on_progress:
            on_progress(payload)

    cookie, token, remain, email = s.load_auth()
    emit({
        "phase": "auth",
        "message": f"已登录 {email}，剩余约 {remain}s",
        "email": email,
        "remainSec": remain,
    })

    _, game_id = s.ensure_editor(cookie, token, character_id)
    emit({
        "phase": "editor",
        "message": f"已连接编辑器 gameId={game_id}",
        "gameId": game_id,
        "out": str(out_dir),
    })

    total = len(remote_paths)
    emit({
        "phase": "scan",
        "message": f"{'重试失败文件' if mode == 'retry' else '下载指定文件'} {total} 个",
        "total": total,
        "current": 0,
        "ok": 0,
        "fail": 0,
    })

    ok = fail = 0
    failed_paths: list[str] = []
    for i, remote in enumerate(remote_paths, 1):
        rel = remote.lstrip("/").replace("\\", "/")
        local = out_dir.joinpath(*rel.split("/")) if rel else out_dir
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = download_raw(cookie, token, game_id, remote)
            local.write_bytes(data)
            ok += 1
            emit({
                "phase": "download",
                "message": f"[{i}/{total}] {remote}",
                "current": i,
                "total": total,
                "ok": ok,
                "fail": fail,
                "path": remote,
            })
        except Exception as e:
            fail += 1
            failed_paths.append(remote)
            emit({
                "phase": "download",
                "message": f"FAIL [{i}/{total}] {remote}: {e}",
                "current": i,
                "total": total,
                "ok": ok,
                "fail": fail,
                "path": remote,
                "error": str(e),
            })

    prev = read_pull_meta(out_dir)
    prev_files = list(prev.get("files") or [])
    # 合并文件清单
    file_set = set(prev_files)
    for p in remote_paths:
        file_set.add(p)
    meta = {
        "character_id": character_id,
        "game_id": game_id,
        "workbench": f"{s.ORIGIN}/studio/game-creation/workbench?character_id={character_id}",
        "out": str(out_dir),
        "pulled_files": int(prev.get("pulled_files") or 0) + ok if mode == "retry" else ok,
        "failed": fail,
        "failed_paths": failed_paths,
        "files": sorted(file_set),
        "last_mode": mode,
    }
    write_pull_meta(out_dir, meta)
    s.save_config({"character_id": character_id, "project_path": str(out_dir)})

    summary = {
        "ok": fail == 0,
        "characterId": character_id,
        "gameId": game_id,
        "out": str(out_dir),
        "total": total,
        "pulled": ok,
        "failed": fail,
        "failedPaths": failed_paths,
        "mode": mode,
        "workbenchUrl": meta["workbench"],
        "message": (
            f"{'重试完成' if mode == 'retry' else '拉取完成'} ok={ok} fail={fail} → {out_dir}"
        ),
    }
    emit({"phase": "done", **summary})
    return summary


def pull_project(
    character_id: int,
    out: Path | None = None,
    on_progress: ProgressCb | None = None,
) -> dict:
    """Pull full container tree into out. Returns summary dict."""
    if not character_id:
        raise ValueError("缺少 character_id")

    out_dir = Path(out).expanduser().resolve() if out else default_out_dir(character_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    def emit(payload: dict) -> None:
        if on_progress:
            on_progress(payload)

    cookie, token, remain, email = s.load_auth()
    emit({
        "phase": "auth",
        "message": f"已登录 {email}，剩余约 {remain}s",
        "email": email,
        "remainSec": remain,
    })

    _, game_id = s.ensure_editor(cookie, token, character_id)
    emit({
        "phase": "editor",
        "message": f"已连接编辑器 gameId={game_id}",
        "gameId": game_id,
        "out": str(out_dir),
    })

    emit({"phase": "scan", "message": "正在扫描容器文件…"})
    all_files = walk(cookie, token, game_id, "/")
    paths = [f["path"] for f in all_files]
    emit({
        "phase": "scan",
        "message": f"发现 {len(paths)} 个文件",
        "total": len(paths),
        "current": 0,
        "ok": 0,
        "fail": 0,
    })

    # 全量：复用路径下载逻辑，但 meta 的 pulled_files 用本轮 ok
    summary = pull_paths(
        character_id,
        paths,
        out_dir,
        on_progress=on_progress,
        mode="full",
    )
    # pull_paths 在 retry 时会累加 pulled_files；full 模式已正确写本轮 ok
    return summary


def retry_failed(
    character_id: int,
    out: Path | None = None,
    on_progress: ProgressCb | None = None,
    failed_paths: list[str] | None = None,
) -> dict:
    """Retry only previously failed files (from arg or _pull_meta.json)."""
    out_dir = Path(out).expanduser().resolve() if out else default_out_dir(character_id)
    paths = list(failed_paths or [])
    if not paths:
        meta = read_pull_meta(out_dir)
        paths = list(meta.get("failed_paths") or [])
    if not paths:
        raise ValueError("没有记录到的失败文件可重试（请先全量拉取一次）")
    return pull_paths(
        character_id,
        paths,
        out_dir,
        on_progress=on_progress,
        mode="retry",
    )


def main():
    ap = argparse.ArgumentParser(description="拉取 DZMM 容器完整项目到本地")
    s.refresh_root()
    cfg = s.load_config()
    ap.add_argument("--character-id", type=int, default=int(cfg.get("character_id") or 0) or None)
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="本地输出目录（默认：配置里的项目路径，或 ../{character_id}）",
    )
    ap.add_argument(
        "--retry-failed",
        action="store_true",
        help="只重试 _pull_meta.json 里记录的失败文件",
    )
    args = ap.parse_args()
    if not args.character_id:
        raise SystemExit("请先在网页控制台填写 character_id，或传 --character-id")

    def _print(p: dict) -> None:
        msg = p.get("message") or p.get("phase")
        if msg:
            print(msg)

    try:
        if args.retry_failed:
            summary = retry_failed(args.character_id, args.out, on_progress=_print)
        else:
            summary = pull_project(args.character_id, args.out, on_progress=_print)
    except Exception as e:
        raise SystemExit(str(e)) from e
    print(f"DONE ok={summary['pulled']} fail={summary['failed']} out={summary['out']}")
    if summary["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
