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
import hashlib
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
# 海外主站；国内易被拦时请换线路（见 ADDR_PAGE / BUILTIN_ORIGINS）
DEFAULT_ORIGIN = "https://www.dzmm.ai"
ADDR_PAGE = "https://dzmm-home.github.io/dzmm-addr/"
# 与官方线路页国内池一致（测速用 /api/heartbeat）；海外主站放最后兜底
BUILTIN_ORIGINS = [
    "https://www.aifukk.com",
    "https://www.fuckaibot.com",
    "https://www.thottai.com",
    "https://www.aicbnv.com",
    "https://www.aikda.com",
    "https://www.ainvmei.com",
    "https://www.girlloveai.com",
    "https://www.meimoaidao.com",
    "https://www.loreveil.xyz",
    "https://www.museloom.xyz",
    "https://www.echolore.xyz",
    DEFAULT_ORIGIN,
]
ORIGIN = DEFAULT_ORIGIN
AUTH_REFRESH_SKEW = 180  # refresh when < 3 minutes left
DEFAULT_CARD_ID = 0


def normalize_origin(raw) -> str:
    """接受完整 URL 或裸域名，统一成 https://www.host。"""
    text = str(raw or "").strip()
    if not text:
        return DEFAULT_ORIGIN
    if "://" not in text:
        text = "https://" + text
    try:
        u = urllib.parse.urlsplit(text)
    except Exception:
        return DEFAULT_ORIGIN
    host = (u.hostname or "").lower().strip(".")
    if not host:
        return DEFAULT_ORIGIN
    if not host.startswith("www.") and host.count(".") == 1:
        host = "www." + host
    scheme = "https"
    return f"{scheme}://{host}"


def list_origin_choices() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in BUILTIN_ORIGINS:
        o = normalize_origin(item)
        if o not in seen:
            seen.add(o)
            out.append(o)
    cur = get_origin()
    if cur not in seen:
        out.insert(0, cur)
    return out


def get_origin() -> str:
    """当前 API / 鉴权线路。优先 config.json origin，其次 .env origin。"""
    global ORIGIN
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg = data
        except Exception:
            cfg = {}
    env = _read_env_map_raw()
    raw = (cfg.get("origin") or env.get("origin") or env.get("ORIGIN") or "").strip()
    ORIGIN = normalize_origin(raw) if raw else DEFAULT_ORIGIN
    return ORIGIN


def set_origin(raw, *, clear_cookie: bool = True) -> str:
    """切换线路并写入 config；换域后旧 cookie 通常失效，默认清除。"""
    global ORIGIN
    origin = normalize_origin(raw)
    save_config({"origin": origin})
    ORIGIN = origin
    if clear_cookie:
        try:
            _save_env(clear_cookie=True)
        except Exception:
            pass
    return origin


def probe_origins(timeout: float = 6.0) -> list[dict]:
    """并行测速各线路（对齐官方页：GET /api/heartbeat）。"""
    import concurrent.futures

    origins = list_origin_choices()

    def _one(origin: str) -> dict:
        url = origin.rstrip("/") + f"/api/heartbeat?_={int(time.time() * 1000)}"
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 DZMM-Studio-Bridge",
                    "Accept": "application/json",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                ms = int((time.perf_counter() - t0) * 1000)
                ok = 200 <= int(resp.status) < 500
                return {
                    "origin": origin,
                    "ok": ok,
                    "ms": ms,
                    "status": int(resp.status),
                    "bytes": len(raw or b""),
                }
        except Exception as e:
            ms = int((time.perf_counter() - t0) * 1000)
            return {
                "origin": origin,
                "ok": False,
                "ms": ms,
                "status": 0,
                "error": str(e),
            }

    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, len(origins) or 1)) as pool:
        futs = [pool.submit(_one, o) for o in origins]
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda r: (0 if r.get("ok") else 1, int(r.get("ms") or 10**9)))
    return results


def pick_fastest_origin(timeout: float = 6.0) -> dict:
    """测速并自动切到最快可用线路。"""
    results = probe_origins(timeout=timeout)
    best = next((r for r in results if r.get("ok")), None)
    if not best:
        return {
            "ok": False,
            "error": "所有线路均不可用，请稍后重试或打开官方线路页",
            "addrPage": ADDR_PAGE,
            "results": results,
            "origin": get_origin(),
        }
    origin = set_origin(best["origin"], clear_cookie=True)
    return {
        "ok": True,
        "origin": origin,
        "ms": best.get("ms"),
        "addrPage": ADDR_PAGE,
        "results": results,
        "message": f"已切换到 {origin}（{best.get('ms')}ms）。请重新登录（换域后旧 cookie 无效）。",
    }


def load_config() -> dict:
    cfg: dict = {
        "character_id": 0,
        "project_path": "",
        "preview_port": 8791,
        "origin": DEFAULT_ORIGIN,
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
    if env.get("origin") and not cfg.get("origin"):
        cfg["origin"] = env["origin"]
    if cfg.get("origin"):
        cfg["origin"] = normalize_origin(cfg["origin"])
    get_origin()
    return cfg


def _looks_like_player_package(dir_path: Path) -> bool:
    """目录本身是否像玩家包（根上就有 index.html）。"""
    if not (dir_path / "index.html").is_file():
        return False
    markers = (
        "game.js",
        "app.js",
        "main.js",
        "config.js",
        "style.css",
        "assets",
        "libs",
        "functions",
        "template.json",
    )
    return any((dir_path / name).exists() for name in markers)


def resolve_game_project(raw) -> dict:
    """智能识别游戏项目路径，不依赖写死目录名之外的布局约定。

    返回字段：
      ok, root, publish_dir, index, layout(nested|flat), error, hint, failedPaths
    """
    empty = {
        "ok": False,
        "root": Path(),
        "publish_dir": Path(),
        "index": Path(),
        "layout": "",
        "error": "未设置游戏项目路径",
        "hint": "",
        "failedPaths": [],
    }
    text = str(raw or "").strip()
    if not text:
        return dict(empty)

    path = Path(text).expanduser()
    try:
        path = path.resolve()
    except OSError:
        path = Path(text).expanduser()

    def _ok(root: Path, publish_dir: Path, layout: str, hint: str = "") -> dict:
        return {
            "ok": True,
            "root": root,
            "publish_dir": publish_dir,
            "index": publish_dir / "index.html",
            "layout": layout,
            "error": "",
            "hint": hint,
            "failedPaths": [],
        }

    if not path.exists():
        return {
            **empty,
            "root": path,
            "publish_dir": path / "publish",
            "index": path / "publish" / "index.html",
            "error": f"路径不存在：{path}",
        }

    # 标准：根/publish/index.html
    if path.is_dir() and (path / "publish" / "index.html").is_file():
        return _ok(path, path / "publish", "nested")

    # 误填到 …/publish（有或没有 index 都上溯到项目根再识别）
    if path.is_dir() and path.name.lower() == "publish":
        if (path / "index.html").is_file():
            return _ok(path.parent, path, "nested", "已自动上溯到项目根（你填的是 publish/）")
        parent_resolved = resolve_game_project(path.parent)
        if parent_resolved.get("hint") or parent_resolved.get("error"):
            # 保留父级识别结果；补充说明填的是 publish 子目录
            if parent_resolved.get("ok"):
                parent_resolved["hint"] = (
                    (parent_resolved.get("hint") + " · ") if parent_resolved.get("hint") else ""
                ) + "已自动上溯到项目根（你填的是 publish/）"
            return parent_resolved

    # 扁平玩家包：目录根就是 index.html
    if path.is_dir() and _looks_like_player_package(path):
        parent = path.parent
        if (parent / "publish" / "index.html").is_file():
            return _ok(parent, parent / "publish", "nested", "已识别父级标准项目布局")
        return _ok(path, path, "flat", "已识别为扁平玩家包（根目录即 publish 内容）")

    # 多填了一层：子目录里才有 publish/index.html
    if path.is_dir():
        try:
            for child in sorted(path.iterdir(), key=lambda p: p.name.lower()):
                if not child.is_dir() or child.name.startswith("."):
                    continue
                if (child / "publish" / "index.html").is_file():
                    return _ok(
                        child,
                        child / "publish",
                        "nested",
                        f"已自动识别子目录：{child.name}",
                    )
                if _looks_like_player_package(child):
                    return _ok(
                        child,
                        child,
                        "flat",
                        f"已自动识别子目录玩家包：{child.name}",
                    )
        except OSError:
            pass

    # publish/ 在，但 index 缺失（常见：拉取失败）
    failed_paths: list[str] = []
    if path.is_dir():
        meta_path = path / "_pull_meta.json"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(meta, dict):
                    failed_paths = [str(x) for x in (meta.get("failed_paths") or [])]
            except Exception:
                failed_paths = []

    pub = path / "publish" if path.is_dir() else path
    if path.is_dir() and pub.is_dir() and not (pub / "index.html").is_file():
        idx_failed = any(
            "publish/index.html" in f.replace("\\", "/")
            or f.replace("\\", "/").endswith("/index.html")
            for f in failed_paths
        )
        if failed_paths or idx_failed:
            err = (
                f"项目目录已识别：{path}\n"
                f"但 publish/index.html 还没下下来"
                f"（拉取失败 {len(failed_paths)} 个，含 index.html）。\n"
                f"请到侧栏「拉取容器」点「重拉失败文件」，不要改路径。"
            )
        else:
            err = (
                f"项目目录已识别：{path}\n"
                f"已有 publish/，但缺少 index.html。\n"
                f"请先拉取容器，或确认云端项目里存在 publish/index.html。"
            )
        return {
            **empty,
            "root": path,
            "publish_dir": pub,
            "index": pub / "index.html",
            "layout": "nested",
            "error": err,
            "failedPaths": failed_paths,
        }

    return {
        **empty,
        "root": path,
        "publish_dir": path / "publish" if path.is_dir() else path,
        "index": (path / "publish" / "index.html") if path.is_dir() else path,
        "error": (
            f"在 {path} 下没找到可预览的 index.html。\n"
            f"可填：① 含 publish/index.html 的项目根；② 根上直接有 index.html 的玩家包目录。"
        ),
        "failedPaths": failed_paths,
    }


def normalize_project_root(raw) -> Path:
    """归一化为游戏项目根（供配置保存）。优先用智能识别结果。"""
    resolved = resolve_game_project(raw)
    if resolved.get("ok") and resolved.get("root"):
        return Path(resolved["root"])
    path = Path(str(raw or "")).expanduser()
    try:
        return path.resolve()
    except OSError:
        return path


def save_config(updates: dict) -> dict:
    global ORIGIN
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
    if cfg.get("project_path"):
        cfg["project_path"] = str(normalize_project_root(cfg["project_path"]))
    if cfg.get("origin"):
        cfg["origin"] = normalize_origin(cfg["origin"])
        ORIGIN = cfg["origin"]
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return cfg


def project_root() -> Path:
    cfg = load_config()
    raw = (cfg.get("project_path") or "").strip()
    if raw:
        return normalize_project_root(raw)
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
    "_sync_meta.json",
    "本地开发说明.md",
}

SKIP_PARTS = {".git", "node_modules", "__pycache__", "tools", ".cursor"}
SYNC_META_NAME = "_sync_meta.json"


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
    origin = get_origin()
    headers = {
        "User-Agent": "Mozilla/5.0 DZMM-Studio-Bridge",
        "Accept": "application/json",
        "Origin": origin,
        "Referer": referer or f"{origin}/",
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
    st, raw, jar = _auth_request(f"{get_origin()}/api/auth/token", method="GET", cookie=cookie)
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
        f"{get_origin()}/api/auth/sign-in",
        method="POST",
        data={"email": email.strip(), "password": password},
        referer=f"{get_origin()}/sign-in",
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
        "Referer": f"{get_origin()}/studio/game-creation/workbench?character_id={DEFAULT_CARD_ID}",
        "Origin": get_origin(),
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
        f"{get_origin()}/api/gamefy/editor",
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
        f"{get_origin()}/api/game-studio/proxy/{game_id}/heartbeat",
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
    return f"{get_origin()}/api/game-studio/proxy/{game_id}{path}"


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


def sync_meta_path() -> Path:
    refresh_root()
    return ROOT / SYNC_META_NAME


def _file_sig(path: Path) -> dict:
    st = path.stat()
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
    return {
        "size": int(st.st_size),
        "mtime_ns": mtime_ns,
        "sha256": h.hexdigest(),
    }


def load_sync_meta() -> dict:
    path = sync_meta_path()
    if not path.is_file():
        return {"version": 1, "files": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("files"), dict):
            data.setdefault("version", 1)
            return data
    except Exception:
        pass
    return {"version": 1, "files": {}}


def save_sync_meta(meta: dict) -> None:
    path = sync_meta_path()
    out = {
        "version": 1,
        "character_id": int(meta.get("character_id") or DEFAULT_CARD_ID or 0),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": meta.get("files") if isinstance(meta.get("files"), dict) else {},
    }
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_sync_baseline(files: list[Path] | None = None) -> dict:
    """把当前本地文件记为已同步基线（不上传）。拉取完成后应调用。"""
    refresh_root()
    files = list(files) if files is not None else list_local_files()
    entries: dict = {}
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        try:
            entries[rel] = _file_sig(path)
        except Exception:
            continue
    meta = {
        "version": 1,
        "character_id": DEFAULT_CARD_ID,
        "files": entries,
    }
    save_sync_meta(meta)
    return meta


def select_files_to_sync(files: list[Path], *, full: bool = False) -> tuple[list[Path], dict, str]:
    """选出需要上传的文件。

    - full=True：全部上传
    - 无基线：先写基线并返回空列表（假定刚拉取后本地=容器）
    - 有基线：只返回 size/mtime/sha256 变化的文件
    """
    refresh_root()
    files = list(files)
    meta = load_sync_meta()
    prev = dict(meta.get("files") or {})
    if full:
        return files, meta, "full"
    if not prev:
        write_sync_baseline(files)
        return [], load_sync_meta(), "baseline"
    changed: list[Path] = []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        try:
            st = path.stat()
        except OSError:
            continue
        old = prev.get(rel)
        mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
        if (
            old
            and int(old.get("size") or -1) == int(st.st_size)
            and int(old.get("mtime_ns") or -1) == mtime_ns
        ):
            continue
        try:
            sig = _file_sig(path)
        except Exception:
            changed.append(path)
            continue
        if old and old.get("sha256") and old.get("sha256") == sig["sha256"]:
            prev[rel] = sig
            continue
        changed.append(path)
    meta["files"] = prev
    return changed, meta, "incremental"


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
        f"{get_origin()}/api/gamefy/publish",
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
    print(f"workbench={get_origin()}/studio/game-creation/workbench?character_id={args.character_id}")


def cmd_sync(args):
    cookie, token, remain, email = load_auth()
    print(f"login={email} remain_s={remain}")
    _, game_id = ensure_editor(cookie, token, args.character_id)
    files = list_local_files()
    if args.only:
        only = {p.replace("\\", "/") for p in args.only}
        files = [f for f in files if f.relative_to(ROOT).as_posix() in only]
    full = bool(getattr(args, "full", False))
    to_upload, meta, mode = select_files_to_sync(files, full=full)
    if mode == "baseline":
        print(f"sync: 已建立增量基线（{len((meta.get('files') or {}))} 个文件），本次不上传")
        print("提示：之后只传有改动的文件；若需全量请加 --full")
        return
    if not to_upload:
        print("sync: 无变更文件，跳过上传")
        return
    print(f"sync {len(to_upload)}/{len(files)} changed -> container gameId={game_id} ({mode})")
    ok = fail = 0
    entries = dict(meta.get("files") or {})
    for i, path in enumerate(to_upload, 1):
        rel = path.relative_to(ROOT).as_posix()
        try:
            upload_file(cookie, token, game_id, path)
            entries[rel] = _file_sig(path)
            ok += 1
            if args.verbose or i % 25 == 0 or i == len(to_upload):
                print(f"  [{i}/{len(to_upload)}] {rel}")
        except Exception as e:
            fail += 1
            print(f"  FAIL {rel}: {e}")
    meta["files"] = entries
    meta["character_id"] = int(getattr(args, "character_id", 0) or DEFAULT_CARD_ID or 0)
    save_sync_meta(meta)
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
    print(f"play/check: {get_origin()}/character/{args.character_id}")
    print(f"workbench: {get_origin()}/studio/game-creation/workbench?character_id={args.character_id}")


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
        print(f"线上开发端预览请打开: {get_origin()}/studio/game-creation/workbench?character_id={args.character_id}")
        print("  → Preview 面板刷新即可看到已 sync 的容器内容")
        if not args.no_open:
            webbrowser.open(url)
            webbrowser.open(f"{get_origin()}/studio/game-creation/workbench?character_id={args.character_id}")
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

    s = sub.add_parser("sync", help="增量同步本地改动到线上容器并 git save（默认只传变更）")
    add_common(s)
    s.add_argument("--message", default="sync from local")
    s.add_argument("--no-git-save", action="store_true")
    s.add_argument("--full", action="store_true", help="强制全量上传（忽略增量基线）")
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
