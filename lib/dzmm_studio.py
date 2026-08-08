#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DZMM Game Studio bridge: sync local project to online workbench container and publish.

Auth (.env, gitignored):
  email=...
  password=...
  cookie=sb-rls-auth-token=base64-...   # optional; auto-refreshed / rewritten

Access token ~1h；脚本会在快过期时用 cookie 调 GET /api/auth/token 自动续期。
refresh 失效或没有 cookie 时，用 email+password 调 POST /api/auth/sign-in。

Target workbench: https://www.dzmm.ai/studio/game-creation/workbench?character_id=<id>
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = KIT_ROOT / "config.json"
ENV_PATH = KIT_ROOT / ".env"
ORIGIN = "https://www.dzmm.ai"
AUTH_REFRESH_SKEW = 180  # refresh when < 3 minutes left
DEFAULT_CARD_ID = 0


def load_config() -> dict:
    cfg: dict = {
        "character_id": 0,
        "project_path": "",
        "preview_port": 8791,
    }
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update(data)
        except Exception:
            pass
    env = _read_env_map_raw()
    if env.get("character_id") and not cfg.get("character_id"):
        try:
            cfg["character_id"] = int(env["character_id"])
        except Exception:
            pass
    if env.get("project_path") and not cfg.get("project_path"):
        cfg["project_path"] = env["project_path"]
    return cfg


def save_config(updates: dict) -> dict:
    cfg = load_config()
    cfg.update({k: v for k, v in updates.items() if v is not None})
    if "character_id" in cfg:
        try:
            cfg["character_id"] = int(cfg["character_id"] or 0)
        except Exception:
            cfg["character_id"] = 0
    if "preview_port" in cfg:
        try:
            cfg["preview_port"] = int(cfg["preview_port"] or 8791)
        except Exception:
            cfg["preview_port"] = 8791
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return cfg


def project_root() -> Path:
    cfg = load_config()
    raw = (cfg.get("project_path") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return KIT_ROOT


# Back-compat aliases used throughout this module
ROOT = KIT_ROOT  # overwritten by refresh_root()


def refresh_root() -> Path:
    global ROOT, DEFAULT_CARD_ID
    ROOT = project_root()
    cfg = load_config()
    DEFAULT_CARD_ID = int(cfg.get("character_id") or 0)
    return ROOT


def _read_env_map_raw() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    out: dict[str, str] = {}
    cookie_chunks: list[str] = []
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        lk = key.lower()
        if lk in ("email", "dzmm_email", "user", "username"):
            out["email"] = val
        elif lk in ("password", "dzmm_password", "pass"):
            out["password"] = val
        elif lk == "cookie":
            cookie_chunks.append(val)
        else:
            out[key] = val
    if cookie_chunks:
        out["cookie"] = cookie_chunks[-1]
    elif not out and ENV_PATH.exists():
        text = ENV_PATH.read_text(encoding="utf-8").strip()
        if text:
            out["cookie"] = text[len("cookie=") :] if text.lower().startswith("cookie=") else text
    return out

# Paths synced into container (relative to repo root)
SYNC_GLOBS = [
    "publish/**/*",
    "functions/**/*",
    "AGENTS.md",
    "README.md",
    "CUSTOMIZATION.md",
    "template.json",
    "index.html",
    "favicon.svg",
    "icons.svg",
    "使用说明.txt",
    "assets/**/*",
]

SYNC_SKIP_REL = {
    "_pull_meta.json",
    "本地开发说明.md",
}

SKIP_PARTS = {".git", "node_modules", "__pycache__", "tools", ".cursor"}


def _read_env_map() -> dict[str, str]:
    return _read_env_map_raw()


def _normalize_cookie(cookie: str) -> str:
    cookie = (cookie or "").strip()
    if cookie.lower().startswith("cookie="):
        cookie = cookie[len("cookie=") :].strip()
    while cookie.startswith("sb-rls-auth-token=sb-rls-auth-token="):
        cookie = cookie[len("sb-rls-auth-token=") :]
    if cookie.startswith("base64-") or cookie.startswith("eyJ"):
        cookie = f"sb-rls-auth-token={cookie if cookie.startswith('base64-') else 'base64-' + cookie}"
    if cookie and not cookie.startswith("sb-rls-auth-token="):
        cookie = f"sb-rls-auth-token={cookie}"
    return cookie


def _session_from_cookie(cookie: str) -> dict:
    cookie = _normalize_cookie(cookie)
    if not cookie:
        raise ValueError("empty cookie")
    b64 = cookie.split("=", 1)[1]
    payload = b64[len("base64-") :] if b64.startswith("base64-") else b64
    payload += "=" * ((-len(payload)) % 4)
    return json.loads(base64.b64decode(payload))


def _cookie_from_jar(jar: CookieJar) -> str | None:
    for c in jar:
        if c.name == "sb-rls-auth-token" and c.value:
            return _normalize_cookie(f"{c.name}={c.value}")
    return None


def _save_env(
    *,
    cookie: str | None = None,
    email: str | None = None,
    password: str | None = None,
    clear_cookie: bool = False,
) -> None:
    cur = _read_env_map()
    if clear_cookie:
        cur.pop("cookie", None)
    if cookie is not None:
        cur["cookie"] = _normalize_cookie(cookie)
    if email is not None:
        cur["email"] = email
    if password is not None:
        if password == "":
            cur.pop("password", None)
        else:
            cur["password"] = password
    cfg = load_config()
    if cfg.get("character_id"):
        cur["character_id"] = str(cfg["character_id"])
    if cfg.get("project_path"):
        cur["project_path"] = str(cfg["project_path"])
    lines: list[str] = []
    if cur.get("email"):
        lines.append(f"email={cur['email']}")
    if cur.get("password"):
        lines.append(f"password={cur['password']}")
    if cur.get("cookie"):
        lines.append(f"cookie={_normalize_cookie(cur['cookie'])}")
    for k, v in cur.items():
        if k in ("email", "password", "cookie"):
            continue
        lines.append(f"{k}={v}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _auth_request(url: str, *, method: str = "GET", data=None, cookie: str | None = None, referer: str | None = None):
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    headers = {
        "User-Agent": "Mozilla/5.0 DZMM-Studio-Bridge",
        "Accept": "application/json",
        "Origin": ORIGIN,
        "Referer": referer or f"{ORIGIN}/",
        "x-dzmm-request-id": f"studio{int(time.time()) % 10_000_000}",
    }
    if cookie:
        headers["Cookie"] = _normalize_cookie(cookie)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, raw, jar
    except urllib.error.HTTPError as e:
        return e.code, e.read(), jar


def refresh_session_cookie(cookie: str) -> str:
    """Renew access via GET /api/auth/token (uses refresh_token inside cookie)."""
    st, raw, jar = _auth_request(f"{ORIGIN}/api/auth/token", method="GET", cookie=cookie)
    new_cookie = _cookie_from_jar(jar)
    if new_cookie:
        return new_cookie
    if st != 200:
        raise RuntimeError(f"refresh failed HTTP {st}: {raw[:200]!r}")
    # some responses only return access_token JSON; keep old cookie if jar empty
    try:
        data = json.loads(raw)
        tok = _session_from_cookie(cookie)
        if data.get("access_token"):
            tok["access_token"] = data["access_token"]
        if data.get("expires_at"):
            tok["expires_at"] = int(data["expires_at"])
            tok["expires_in"] = max(0, int(data["expires_at"]) - int(time.time()))
        raw_b64 = base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode().rstrip("=")
        return f"sb-rls-auth-token=base64-{raw_b64}"
    except Exception as e:
        raise RuntimeError(f"refresh parse failed: {e}") from e


def login_with_password(email: str, password: str) -> str:
    st, raw, jar = _auth_request(
        f"{ORIGIN}/api/auth/sign-in",
        method="POST",
        data={"email": email.strip(), "password": password},
        referer=f"{ORIGIN}/sign-in",
    )
    new_cookie = _cookie_from_jar(jar)
    if new_cookie:
        return new_cookie
    err = raw[:300]
    try:
        err = json.loads(raw).get("error") or json.loads(raw).get("message") or err
    except Exception:
        pass
    raise RuntimeError(f"login failed HTTP {st}: {err}")


def load_auth(min_remain: int = 60):
    env = _read_env_map()
    email = (env.get("email") or "").strip()
    password = env.get("password") or ""
    cookie = _normalize_cookie(env.get("cookie") or "")

    def _ok(c: str):
        tok = _session_from_cookie(c)
        remain = int(tok.get("expires_at", 0) - time.time())
        return c, tok["access_token"], remain, tok.get("user", {}).get("email") or email or "?"

    # 1) try existing cookie + auto refresh
    if cookie:
        try:
            c, token, remain, mail = _ok(cookie)
            if remain >= max(min_remain, AUTH_REFRESH_SKEW):
                return c, token, remain, mail
            # near expiry / expired → refresh via token API
            try:
                refreshed = refresh_session_cookie(c)
                mail = email or mail
                _save_env(cookie=refreshed, email=mail if mail and mail != "?" else None, password=password or None)
                print(f"[auth] cookie refreshed, remain≈{_ok(refreshed)[2]}s", file=sys.stderr)
                return _ok(refreshed)
            except Exception as e:
                print(f"[auth] cookie refresh failed: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[auth] cookie invalid: {e}", file=sys.stderr)

    # 2) email + password login
    if email and password:
        print(f"[auth] signing in as {email} …", file=sys.stderr)
        fresh = login_with_password(email, password)
        _save_env(cookie=fresh, email=email, password=password)
        return _ok(fresh)

    raise SystemExit(
        "未登录：请在 .env 写上 email=... 与 password=...（推荐），"
        "或粘贴 cookie=sb-rls-auth-token=base64-..."
    )


def http(url, cookie, token, method="GET", data=None, raw_body=None, content_type=None, timeout=120, accept="*/*"):
    headers = {
        "Cookie": cookie,
        "Authorization": f"Bearer {token}",
        "User-Agent": "Mozilla/5.0 DZMM-Studio-Bridge",
        "Accept": accept,
        "Referer": f"{ORIGIN}/studio/game-creation/workbench?character_id={DEFAULT_CARD_ID}",
        "Origin": ORIGIN,
        "x-dzmm-request-id": f"studio{int(time.time()) % 10_000_000}",
    }
    body = None
    if raw_body is not None:
        body = raw_body
        headers["Content-Type"] = content_type or "application/octet-stream"
    elif data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def ensure_editor(cookie, token, character_id: int):
    st, raw, _ = http(
        f"{ORIGIN}/api/gamefy/editor",
        cookie,
        token,
        method="POST",
        data={"characterId": character_id},
        timeout=180,
        accept="application/json",
    )
    if st != 200:
        raise SystemExit(f"创建/连接编辑器失败 HTTP {st}: {raw[:300]!r}")
    info = json.loads(raw)
    if "needsTemplate" in info:
        raise SystemExit("该角色需要先在网页 workbench 选择模板")
    game_id = str(info.get("gameId") or character_id)
    # keep container warm
    http(
        f"{ORIGIN}/api/game-studio/proxy/{game_id}/heartbeat",
        cookie,
        token,
        method="POST",
        data={},
        timeout=60,
        accept="application/json",
    )
    return info, game_id


def proxy_url(game_id: str, path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return f"{ORIGIN}/api/game-studio/proxy/{game_id}{path}"


def list_local_files() -> list[Path]:
    refresh_root()
    files: list[Path] = []
    for pattern in SYNC_GLOBS:
        for path in ROOT.glob(pattern):
            if not path.is_file():
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            rel_skip = path.relative_to(ROOT).as_posix()
            if rel_skip in SYNC_SKIP_REL:
                continue
            files.append(path)
    # unique
    return sorted(set(files), key=lambda p: p.as_posix())


def to_container_path(path: Path) -> str:
    rel = path.relative_to(ROOT).as_posix()
    return "/" + rel


def upload_file(cookie, token, game_id: str, local: Path) -> None:
    remote = to_container_path(local)
    data = local.read_bytes()
    q = urllib.parse.urlencode({"path": remote, "createDirectories": "true"})
    st, raw, _ = http(
        proxy_url(game_id, f"/files/upload?{q}"),
        cookie,
        token,
        method="PUT",
        raw_body=data,
        content_type="application/octet-stream",
        timeout=180,
    )
    if st not in (200, 201, 204):
        raise RuntimeError(f"upload failed {remote} HTTP {st}: {raw[:200]!r}")


def git_save(cookie, token, game_id: str, message: str | None) -> None:
    st, raw, _ = http(
        proxy_url(game_id, "/git/save"),
        cookie,
        token,
        method="POST",
        data={"message": message or None},
        timeout=120,
        accept="application/json",
    )
    if st not in (200, 201):
        raise SystemExit(f"git save 失败 HTTP {st}: {raw[:300]!r}")


def publish(cookie, token, character_id: int) -> None:
    st, raw, _ = http(
        f"{ORIGIN}/api/gamefy/publish",
        cookie,
        token,
        method="POST",
        data={"characterId": character_id},
        timeout=300,
        accept="application/json",
    )
    if st not in (200, 201):
        try:
            err = json.loads(raw).get("error")
        except Exception:
            err = raw[:300]
        raise SystemExit(f"发布失败 HTTP {st}: {err}")


def cmd_login(args):
    env = _read_env_map()
    email = (args.email or env.get("email") or "").strip()
    password = args.password if args.password is not None else (env.get("password") or "")
    if not email or not password:
        raise SystemExit(
            "用法: python tools/dzmm_studio.py login --email you@mail.com --password '***'\n"
            "或先在 .env 写好 email= / password="
        )
    fresh = login_with_password(email, password)
    _save_env(cookie=fresh, email=email, password=password)
    _, _, remain, mail = load_auth()
    print(f"login ok email={mail} remain_s={remain}")
    print(".env 已写入 cookie（并保留 email/password，供以后自动续期/重登）")


def cmd_status(args):
    cookie, token, remain, email = load_auth()
    print(f"login={email} remain_s={remain}")
    info, game_id = ensure_editor(cookie, token, args.character_id)
    print(f"editor status={info.get('status')} gameId={game_id} container={str(info.get('containerId'))[:16]}…")
    st, raw, _ = http(proxy_url(game_id, "/git/status"), cookie, token, accept="application/json")
    print("git", raw.decode("utf-8", "replace")[:500])
    st, raw, _ = http(proxy_url(game_id, "/publish/files"), cookie, token, accept="application/json")
    files = json.loads(raw).get("files") or []
    print(f"publish_files={len(files)}")
    print(f"workbench={ORIGIN}/studio/game-creation/workbench?character_id={args.character_id}")


def cmd_sync(args):
    cookie, token, remain, email = load_auth()
    print(f"login={email} remain_s={remain}")
    _, game_id = ensure_editor(cookie, token, args.character_id)
    files = list_local_files()
    if args.only:
        only = {p.replace("\\", "/") for p in args.only}
        files = [f for f in files if f.relative_to(ROOT).as_posix() in only]
    print(f"sync {len(files)} files -> container gameId={game_id}")
    ok = fail = 0
    for i, path in enumerate(files, 1):
        rel = path.relative_to(ROOT).as_posix()
        try:
            upload_file(cookie, token, game_id, path)
            ok += 1
            if args.verbose or i % 25 == 0 or i == len(files):
                print(f"  [{i}/{len(files)}] {rel}")
        except Exception as e:
            fail += 1
            print(f"  FAIL {rel}: {e}")
    print(f"uploaded ok={ok} fail={fail}")
    if fail:
        raise SystemExit(1)
    if not args.no_git_save:
        print("git save…")
        git_save(cookie, token, game_id, args.message)
        print("git save done")


def cmd_publish(args):
    cookie, token, remain, email = load_auth()
    print(f"login={email} remain_s={remain}")
    ensure_editor(cookie, token, args.character_id)
    if not args.yes:
        ans = input(f"确认发布 character_id={args.character_id} 到线上？[y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            raise SystemExit("已取消")
    print("publishing…")
    publish(cookie, token, args.character_id)
    print("publish ok")
    print(f"play/check: {ORIGIN}/character/{args.character_id}")
    print(f"workbench: {ORIGIN}/studio/game-creation/workbench?character_id={args.character_id}")


def cmd_deploy(args):
    # sync + publish
    args.no_git_save = False
    cmd_sync(args)
    args.yes = True if args.yes else args.yes
    if not args.yes:
        ans = input("同步完成，继续发布到线上？[y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            raise SystemExit("已同步，未发布")
        args.yes = True
    cmd_publish(args)


def cmd_preview(args):
    # local static preview of publish/
    import http.server
    import socketserver
    import webbrowser

    publish_dir = ROOT / "publish"
    if not (publish_dir / "index.html").exists():
        raise SystemExit("缺少 publish/index.html")
    port = args.port
    handler = http.server.SimpleHTTPRequestHandler
    os_chdir = __import__("os").chdir
    os_chdir(publish_dir)

    class Quiet(handler):
        def log_message(self, fmt, *a):
            if args.verbose:
                super().log_message(fmt, *a)

    with socketserver.TCPServer(("127.0.0.1", port), Quiet) as httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"local publish preview: {url}")
        print("说明：这是本地静态预览，不含完整 Workbench 容器/SDK。")
        print(f"线上开发端预览请打开: {ORIGIN}/studio/game-creation/workbench?character_id={args.character_id}")
        print("  → Preview 面板刷新即可看到已 sync 的容器内容")
        if not args.no_open:
            webbrowser.open(url)
            webbrowser.open(f"{ORIGIN}/studio/game-creation/workbench?character_id={args.character_id}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


def main():
    refresh_root()
    p = argparse.ArgumentParser(description="DZMM Studio local bridge")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--character-id", type=int, default=DEFAULT_CARD_ID or 0)

    s = sub.add_parser("login", help="邮箱+密码登录，写入 .env cookie")
    s.add_argument("--email")
    s.add_argument("--password")
    s.set_defaults(func=cmd_login)

    s = sub.add_parser("status", help="检查登录态与远程容器")
    add_common(s)
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("sync", help="把本地 publish/functions/docs 同步到线上容器并 git save")
    add_common(s)
    s.add_argument("--message", default="sync from local")
    s.add_argument("--no-git-save", action="store_true")
    s.add_argument("--only", nargs="*", help="只同步指定相对路径")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(func=cmd_sync)

    s = sub.add_parser("publish", help="触发线上「保存游戏」发布")
    add_common(s)
    s.add_argument("-y", "--yes", action="store_true")
    s.set_defaults(func=cmd_publish)

    s = sub.add_parser("deploy", help="sync + publish")
    add_common(s)
    s.add_argument("--message", default="deploy from local")
    s.add_argument("-y", "--yes", action="store_true")
    s.add_argument("-v", "--verbose", action="store_true")
    s.add_argument("--only", nargs="*")
    s.set_defaults(func=cmd_deploy)

    s = sub.add_parser("preview", help="本地静态预览 + 打开线上 workbench")
    add_common(s)
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--no-open", action="store_true")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(func=cmd_preview)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
