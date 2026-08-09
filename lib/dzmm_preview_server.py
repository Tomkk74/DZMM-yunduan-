#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Authenticated DZMM preview with window.dzmm bridge (completions / kv / capabilities).

Open: http://127.0.0.1:8791/ (character 3355944)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from html import escape as html_escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # overwritten by --project-root
PUBLISH_DIR = ROOT / "publish"  # may equal ROOT for flat player packages
DEFAULT_CARD_ID = 0
DEFAULT_PORT = 8791
def _origin() -> str:
    try:
        mod = load_studio()
        if hasattr(mod, 'get_origin'):
            return str(mod.get_origin())
    except Exception:
        pass
    return "https://www.dzmm.ai"


DEFAULT_PROJECT_NAME = "DZMM Game"


def set_project_root(path: Path | str, publish_dir: Path | str | None = None) -> Path:
    global ROOT, PUBLISH_DIR
    ROOT = Path(path).expanduser().resolve()
    if publish_dir is not None and str(publish_dir).strip():
        PUBLISH_DIR = Path(publish_dir).expanduser().resolve()
    elif (ROOT / "publish" / "index.html").is_file():
        PUBLISH_DIR = ROOT / "publish"
    elif (ROOT / "index.html").is_file():
        PUBLISH_DIR = ROOT
    else:
        PUBLISH_DIR = ROOT / "publish"
    return ROOT

BRIDGE_JS = r"""
(() => {
  if (window.dzmm && window.dzmm.__localPreviewBridge) return;
  const API = "/_dzmm";
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
      err.code = (data && data.code) || "HTTP_" + res.status;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function completions(config, onChunk) {
    const res = await fetch(API + "/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({
        model: (config && config.model) || "default",
        messages: (config && config.messages) || [],
        maxTokens: (config && config.maxTokens) || 1000,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      const err = new Error(msg || ("completions HTTP " + res.status));
      err.code = "COMPLETIONS_FAILED";
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          if (json.error) {
            const err = new Error(json.error.message || JSON.stringify(json.error));
            err.code = json.error.code || "COMPLETIONS_ERROR";
            throw err;
          }
          const delta = (((json.choices || [])[0] || {}).delta || {}).content;
          if (typeof delta === "string" && delta) {
            full += delta;
            if (typeof onChunk === "function") onChunk(full, false);
          }
        } catch (e) {
          if (e && e.code) throw e;
        }
      }
    }
    if (typeof onChunk === "function") onChunk(full, true);
  }

  const kvMem = new Map();
  const kvLsPrefix = "dzmm-preview-kv-3355944:";
  function kvLsRead(key) {
    try {
      const raw = localStorage.getItem(kvLsPrefix + key);
      if (raw != null && raw !== "") {
        try { return JSON.parse(raw); } catch { return raw; }
      }
      // 兼容游戏自己写入的同名 localStorage
      const native = localStorage.getItem(key);
      if (native != null && native !== "") {
        try { return JSON.parse(native); } catch { return native; }
      }
    } catch {}
    return undefined;
  }
  function kvLsWrite(key, value) {
    try {
      if (value == null) localStorage.removeItem(kvLsPrefix + key);
      else localStorage.setItem(kvLsPrefix + key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {}
  }
  // 给 Ct.kvGet → Ra() 的返回值：必须是 string 或 { value }，不能直接丢裸对象（否则会变成 "[object Object]" 冲掉本地档）
  function toRaShape(value) {
    if (value === undefined) return null;
    return { value };
  }

  const dzmm = {
    __localPreviewBridge: true,
    toast: {
      info: (m) => console.info("[toast:info]", m),
      success: (m) => console.info("[toast:success]", m),
      warn: (m) => console.warn("[toast:warn]", m),
      error: (m) => console.error("[toast:error]", m),
    },
    loading: {
      progress: (p) => {
        const phase = p && p.phase;
        if (phase === "resource_loading") {
          const loaded = Number(p.loadedResources) || 0;
          const total = Number(p.totalResources) || 0;
          if (total > 0 && (loaded === total || loaded % 10 === 0 || loaded <= 1)) {
            console.log("[loading]", `${loaded}/${total}`, p.currentResource || "");
          }
          return;
        }
        console.log("[loading]", phase || p, p && p.message || "");
      },
      ready: () => console.log("[loading] ready"),
      error: (m) => console.error("[loading]", m),
    },
    capabilities: {
      async get() {
        return {
          kv: true, kvBatch: true, kvList: true, fn: true, completions: true,
          draw: true, chat: false, share: false, workshop: true, audio: false, models: true,
        };
      },
    },
    completions,
    kv: {
      async get(key) {
        try {
          const data = await api("/kv/get", { method: "POST", body: { key } });
          if (data && Object.prototype.hasOwnProperty.call(data, "value")) {
            kvMem.set(key, data.value);
            kvLsWrite(key, data.value);
            return toRaShape(data.value);
          }
        } catch (e) {
          console.warn("[local-dzmm] kv.get cloud fail, try local", key, e.message);
        }
        if (kvMem.has(key)) return toRaShape(kvMem.get(key));
        const local = kvLsRead(key);
        if (local !== undefined) {
          kvMem.set(key, local);
          return toRaShape(local);
        }
        return toRaShape(null);
      },
      async put(key, value) {
        kvMem.set(key, value);
        kvLsWrite(key, value);
        try {
          await api("/kv/put", { method: "POST", body: { key, value } });
        } catch (e) {
          console.warn("[local-dzmm] kv.put cloud fail, kept local", key, e.message);
        }
      },
      async delete(key) {
        kvMem.delete(key);
        kvLsWrite(key, null);
        try { localStorage.removeItem(key); } catch {}
        try {
          await api("/kv/delete", { method: "POST", body: { key } });
        } catch (e) {
          console.warn("[local-dzmm] kv.delete cloud fail", key, e.message);
        }
      },
    },
    models: {
      async list() {
        try { return await api("/models"); }
        catch { return { models: [{ id: "default", displayName: "default", internalName: "default" }], defaultModel: "default" }; }
      },
    },
    draw: {
      async generate(input) {
        // 服务端会创建任务并轮询到完成，返回 SDK 形状 { taskId, images, status }
        return api("/draw/generate", { method: "POST", body: input || {} });
      },
      async generateModels() {
        return api("/draw/models?kind=generate");
      },
      async editModels() {
        return api("/draw/models?kind=edit");
      },
    },
    fn: {
      async invoke(name, body) {
        // 本地预览：游戏侧 HarborGuard 若误走 platform 模式，仍给可用票据
        if (String(name || "") === "harbor_guard") {
          const method = String((body && body.method) || "issue");
          const now = Date.now();
          const ttl = 45 * 60 * 1000;
          if (method === "ping" && body && body.token) {
            return { ok: true, token: String(body.token), exp: now + ttl, local: true };
          }
          const token = "local-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 10);
          return { ok: true, token, exp: now + ttl, ttlMs: ttl, local: true };
        }
        try {
          const data = await api("/fn/invoke", { method: "POST", body: { name, body: body || {} } });
          // 线上 HTTP 包一层 { result }；SDK 对浏览器直接返回函数返回值
          return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
        } catch (e) {
          // 418 = 平台未开通/限流的自定义函数，预览里忽略即可
          console.warn("[local-dzmm] fn.invoke skip", name, e && e.message || e);
          return null;
        }
      },
    },
    workshop: {
      async list(options) { return api("/workshop/list", { method: "POST", body: options || {} }); },
      async publish(input) { return api("/workshop/publish", { method: "POST", body: input || {} }); },
      async unpublish(id) { return api("/workshop/unpublish", { method: "POST", body: { id } }); },
      async setLiked(id, liked) { return api("/workshop/like", { method: "POST", body: { id, liked: !!liked } }); },
    },
    user: {
      async info() { return api("/user"); },
      async jwks() { return { keys: [] }; },
    },
  };

  window.dzmm = dzmm;
  window.dispatchEvent(new Event("dzmm:ready"));
  try { document.dispatchEvent(new Event("dzmm:ready")); } catch {}
  try { window.postMessage({ type: "dzmm:ready" }, "*"); } catch {}
  console.info("[local-dzmm] bridge ready");
})();
"""


def load_studio():
    path = Path(__file__).resolve().parent / "dzmm_studio.py"
    spec = importlib.util.spec_from_file_location("dzmm_studio", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def _load_project_name() -> str:
    for path in (ROOT / "template.json", PUBLISH_DIR / "template.json", ROOT / "publish" / "template.json"):
        try:
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            name = str(data.get("name") or "").strip()
            if name:
                # 取主名，去掉过长副标题
                return name.split("·", 1)[0].strip() or DEFAULT_PROJECT_NAME
        except Exception:
            continue
    return DEFAULT_PROJECT_NAME


class PreviewState:
    def __init__(self, character_id: int, port: int = DEFAULT_PORT):
        self.character_id = character_id
        self.port = int(port or DEFAULT_PORT)
        self.studio = load_studio()
        self.cookie = ""
        self.token = ""
        self.remain = 0
        self.auth_checked_at = 0.0
        self.email = ""
        self.display_name = ""
        self.game_id = str(character_id)
        self.container_id = ""
        self.chat_id = ""
        self.project_name = _load_project_name()
        self.lock = threading.Lock()
        self.publish_lock = threading.Lock()
        self.publish_job = {
            "status": "idle",  # idle | running | ok | error
            "phase": "idle",  # idle | publish | done
            "message": "",
            "startedAt": 0,
            "finishedAt": 0,
            "total": 0,
            "current": 0,
            "currentFile": "",
            "percent": 0,
            "synced": 0,
            "failed": 0,
        }
        self.refresh(force=True)

    def is_logged_in(self) -> bool:
        return bool(self.token) and self._remain_now() > 0

    def container_short(self) -> str:
        cid = (self.container_id or self.game_id or "").strip()
        if len(cid) <= 16:
            return cid or "—"
        return cid[:12] + "…"

    def _remain_now(self) -> int:
        """Wall-clock remain: last JWT remain minus elapsed since that check."""
        if not self.auth_checked_at:
            return 0
        return int(self.remain - (time.time() - self.auth_checked_at))

    def refresh(self, force: bool = False):
        with self.lock:
            if not force and self._remain_now() > 90 and self.chat_id:
                return
            try:
                cookie, token, remain, email = self.studio.load_auth()
                self.cookie, self.token, self.remain, self.email = cookie, token, remain, email
                self.auth_checked_at = time.time()
            except Exception as e:
                print(f"[preview] load_auth fail (local-only mode): {e}")
                self.auth_checked_at = time.time()
                return
            try:
                info, game_id = self.studio.ensure_editor(cookie, token, self.character_id)
                self.game_id = str(game_id)
                self.container_id = str((info or {}).get("containerId") or self.container_id or "")
            except Exception as e:
                print(f"[preview] ensure_editor fail, keep gameId={self.game_id}: {e}")
                info = {"status": "offline"}
            except SystemExit as e:
                # ensure_editor 用 SystemExit 表示「未选模板」等；本地预览应降级继续
                print(f"[preview] ensure_editor unavailable, local-only mode: {e}")
                info = {"status": "offline"}
                if not self.game_id:
                    self.game_id = str(self.character_id)
            try:
                st, raw, _ = self.studio.http(
                    f"{_origin()}/api/gamefy/{self.character_id}/dev-chat",
                    cookie,
                    token,
                    method="POST",
                    data={},
                    timeout=20,
                    accept="application/json",
                )
                if st == 200:
                    self.chat_id = json.loads(raw).get("chatId") or self.chat_id
            except Exception as e:
                print(f"[preview] dev-chat fail (KV/云端暂不可用): {e}")
            try:
                q = urllib.parse.quote(json.dumps({"0": {"json": {}}}, separators=(",", ":")))
                st_me, raw_me, _ = self.studio.http(
                    f"{_origin()}/api/trpc/user.getMe?batch=1&input={q}",
                    cookie,
                    token,
                    method="GET",
                    timeout=20,
                    accept="application/json",
                )
                if st_me == 200 and raw_me:
                    payload = json.loads(raw_me.decode("utf-8", "replace"))
                    row = payload[0] if isinstance(payload, list) and payload else payload
                    me = (((row or {}).get("result") or {}).get("data") or {}).get("json") or {}
                    if isinstance(me, dict):
                        full = str(me.get("fullName") or me.get("name") or "").strip()
                        if full:
                            self.display_name = full[:40]
            except Exception as e:
                print(f"[preview] user name fail: {e}")
            print(
                f"[preview] auth={self.email or '?'} name={self.display_name or '—'} "
                f"remain={self._remain_now()}s gameId={self.game_id} "
                f"chatId={(self.chat_id or '')[:8] or '—'}… status={(info or {}).get('status')}"
            )

    def _set_publish_job(self, **kwargs):
        with self.publish_lock:
            self.publish_job.update(kwargs)
            return dict(self.publish_job)

    def start_publish(self, message: str = "publish from local preview") -> dict:
        # 容器同步/git save 由日常 sync 负责；发布按钮只把已保存容器上线为玩家包
        _ = message  # 保留入参兼容旧前端
        with self.publish_lock:
            if self.publish_job.get("status") == "running":
                return dict(self.publish_job)
            self.publish_job = {
                "status": "running",
                "phase": "publish",
                "message": "正在准备发布…",
                "startedAt": time.time(),
                "finishedAt": 0,
                "total": 0,
                "current": 0,
                "currentFile": "",
                "percent": 5,
                "synced": 0,
                "failed": 0,
            }

        def worker():
            try:
                self._set_publish_job(phase="publish", message="正在登录…", percent=10)
                self.refresh(force=True)
                cookie, token = self.cookie, self.token
                if not cookie or not token:
                    raise RuntimeError("未登录，无法发布")
                self._set_publish_job(phase="publish", percent=40, message="正在发布到线上玩家版…")
                try:
                    self.studio.publish(cookie, token, self.character_id)
                except SystemExit as e:
                    raise RuntimeError(str(e)) from e
                self._set_publish_job(
                    status="ok",
                    phase="done",
                    percent=100,
                    message="发布成功 · 已上线玩家版",
                    finishedAt=time.time(),
                    currentFile="",
                )
                print("[preview] publish ok")
            except Exception as e:
                self._set_publish_job(
                    status="error",
                    phase="done",
                    message=str(e) or "发布失败",
                    finishedAt=time.time(),
                )
                print(f"[preview] publish error: {e}")

        threading.Thread(target=worker, daemon=True).start()
        return self.publish_status()

    def publish_status(self) -> dict:
        with self.publish_lock:
            return dict(self.publish_job)

    def user_info(self) -> dict:
        """Mirror dzmm.user.info(); nickname comes from tRPC user.getMe.fullName (not auth email)."""
        self.refresh()
        user_id = ""
        name = None
        avatar = None
        try:
            q = urllib.parse.quote(json.dumps({"0": {"json": {}}}, separators=(",", ":")))
            st, raw, _ = self.studio.http(
                f"{_origin()}/api/trpc/user.getMe?batch=1&input={q}",
                self.cookie,
                self.token,
                method="GET",
                timeout=20,
                accept="application/json",
            )
            if st == 200 and raw:
                payload = json.loads(raw.decode("utf-8", "replace"))
                row = payload[0] if isinstance(payload, list) and payload else payload
                me = (((row or {}).get("result") or {}).get("data") or {}).get("json") or {}
                if isinstance(me, dict):
                    user_id = str(me.get("id") or "")
                    full = str(me.get("fullName") or me.get("name") or "").strip()
                    if full:
                        name = full[:40]
                    av = str(me.get("avatarUrl") or "").strip()
                    if av.startswith("http"):
                        avatar = av
        except Exception as e:
            print(f"[preview] user.getMe fail: {e}")
        if not user_id and self.token:
            try:
                import base64 as _b64

                part = self.token.split(".")[1]
                part += "=" * ((-len(part)) % 4)
                claims = json.loads(_b64.urlsafe_b64decode(part.encode("ascii")))
                user_id = str(claims.get("sub") or "")
            except Exception:
                pass
        return {
            "id": user_id or None,
            "name": name,
            "avatarUrl": avatar,
            "token": self.token or None,
            "environment": "dev",
        }

    def upstream(self, method: str, url: str, body: bytes | None = None, content_type: str | None = None, accept: str = "*/*"):
        try:
            self.refresh()
        except Exception as e:
            print(f"[preview] refresh before upstream: {e}")
        headers = {
            "Cookie": self.cookie,
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "Mozilla/5.0 DZMM-Local-Preview",
            "Accept": accept,
            "Referer": f"{_origin()}/studio/game-creation/workbench?character_id={self.character_id}",
            "Origin": _origin(),
        }
        if self.chat_id:
            headers["X-Dzmm-Chat-Id"] = self.chat_id
            headers["x-chat-id"] = self.chat_id
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        last_err = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    return resp.status, resp.read(), dict(resp.headers)
            except urllib.error.HTTPError as e:
                try:
                    raw = e.read()
                except Exception:
                    raw = b""
                return e.code, raw, dict(e.headers or {})
            except Exception as e:
                last_err = e
                if attempt == 0:
                    time.sleep(0.35)
                    continue
        raise last_err or RuntimeError("upstream failed")


def make_handler(state: PreviewState):
    class Handler(BaseHTTPRequestHandler):
        # 大资源并发时避免单连接拖太久
        timeout = 60

        def log_message(self, fmt, *args):
            # 静态资源日志太多会堵控制台管道 / 拖慢线程，只打 API / 错误
            try:
                msg = fmt % args
            except Exception:
                msg = str(fmt)
            path = (self.path or "").split("?", 1)[0]
            if path.startswith("/static/") or path.startswith("/assets/"):
                if " 200 " in f" {msg} " or msg.startswith('"GET /static/') or msg.startswith('"GET /assets/'):
                    return
            print(f"[preview] {self.address_string()} {msg}", flush=True)

        def handle_one_request(self):
            try:
                super().handle_one_request()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                pass

        def _send(self, code: int, body: bytes, content_type: str = "text/plain; charset=utf-8"):
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                pass

        def _send_file(self, path: Path, content_type: str):
            """Stream local file; avoid read_bytes() OOM under concurrent spine/png loads."""
            try:
                size = path.stat().st_size
            except OSError:
                return self._send(404, b"not found")
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("X-Preview-Source", "local")
                self.end_headers()
                with path.open("rb") as fp:
                    while True:
                        chunk = fp.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                pass

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {}

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path in ("/", "/index.html", "/preview"):
                return self.serve_index()
            if path == "/health":
                try:
                    state.refresh()
                except Exception:
                    pass
                remain_sec = max(0, state._remain_now())
                payload = {
                    "ok": True,
                    "loggedIn": state.is_logged_in(),
                    "email": state.email,
                    "displayName": state.display_name or "",
                    "remain": remain_sec,
                    "remainSec": remain_sec,
                    "remainMin": remain_sec // 60,
                    "gameId": state.game_id,
                    "containerId": state.container_id or state.game_id,
                    "containerShort": state.container_short(),
                    "chatId": state.chat_id,
                    "characterId": state.character_id,
                    "projectName": state.project_name or DEFAULT_PROJECT_NAME,
                    "port": int(state.port or DEFAULT_PORT),
                    "services": "服务端函数、生图、对话模型已接入",
                    "bridge": True,
                }
                return self._send(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")
            if path == "/_dzmm/user":
                return self._send(
                    200,
                    json.dumps(state.user_info(), ensure_ascii=False).encode("utf-8"),
                    "application/json",
                )
            if path == "/_dzmm/models":
                return self.proxy_chat_models()
            if path == "/_dzmm/draw/models":
                kind = urllib.parse.parse_qs(parsed.query).get("kind", ["generate"])[0]
                return self.proxy_draw_models(kind)
            if path == "/_dzmm/studio/publish":
                return self._send(200, json.dumps(state.publish_status(), ensure_ascii=False).encode("utf-8"), "application/json")
            if path.startswith("/static/"):
                return self.proxy_static(path[len("/static/") :])
            if path.startswith("/assets/") or path.endswith((".json", ".js", ".css", ".png", ".jpg", ".webp", ".mp3", ".ogg", ".html")):
                return self.proxy_static(path.lstrip("/"))
            self._send(404, b"not found")

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if not path.startswith("/_dzmm/"):
                self._send(404, b"not found")
                return
            body = self._read_json()
            try:
                if path == "/_dzmm/completions":
                    return self.proxy_completions(body)
                if path == "/_dzmm/kv/get":
                    return self.proxy_kv("GET", body.get("key"))
                if path == "/_dzmm/kv/put":
                    return self.proxy_kv("PUT", body.get("key"), {"value": body.get("value")})
                if path == "/_dzmm/kv/delete":
                    return self.proxy_kv("DELETE", body.get("key"))
                if path == "/_dzmm/models":
                    return self.proxy_chat_models()
                if path == "/_dzmm/draw/generate":
                    return self.proxy_draw_generate(body)
                if path == "/_dzmm/studio/publish":
                    job = state.start_publish(str((body or {}).get("message") or "publish from local preview"))
                    return self._send(200, json.dumps(job, ensure_ascii=False).encode("utf-8"), "application/json")
                if path == "/_dzmm/fn/invoke":
                    name = str(body.get("name") or "")
                    fn_body = body.get("body") or {}
                    st, raw, hdr = state.upstream(
                        "POST",
                        f"{_origin()}/api/gamefy/{state.character_id}/fn/{urllib.parse.quote(name)}",
                        body=json.dumps(fn_body).encode("utf-8"),
                        content_type="application/json",
                        accept="application/json",
                    )
                    # 418 teapot / 404：预览桥返回空结果，避免控制台刷红
                    if st in (404, 418, 501, 503):
                        return self._send(200, json.dumps({"result": None, "skipped": True, "status": st}).encode("utf-8"), "application/json")
                    ctype = hdr.get("Content-Type") or "application/json"
                    return self._send(st, raw, ctype)
                if path == "/_dzmm/workshop/list":
                    # bool 必须编成 true/false；urlencode(True) 会变成 True，平台报「请求参数有误」
                    params = {}
                    for k, v in (body or {}).items():
                        if v is None:
                            continue
                        if isinstance(v, bool):
                            params[k] = "true" if v else "false"
                        else:
                            params[k] = v
                    q = urllib.parse.urlencode(params)
                    url = f"{_origin()}/api/gamefy/{state.chat_id}/workshop" + (f"?{q}" if q else "")
                    return self.proxy_json("GET", url, None)
                if path == "/_dzmm/workshop/publish":
                    return self.proxy_json("POST", f"{_origin()}/api/gamefy/{state.chat_id}/workshop", body)
                if path == "/_dzmm/workshop/unpublish":
                    item_id = urllib.parse.quote(str(body.get("id") or ""))
                    return self.proxy_json("DELETE", f"{_origin()}/api/gamefy/{state.chat_id}/workshop/{item_id}", None)
                if path == "/_dzmm/workshop/like":
                    item_id = urllib.parse.quote(str(body.get("id") or ""))
                    method = "PUT" if body.get("liked") else "DELETE"
                    return self.proxy_json(method, f"{_origin()}/api/gamefy/{state.chat_id}/workshop/{item_id}/like", None)
                self._send(404, json.dumps({"error": "unknown bridge route"}).encode(), "application/json")
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        def _local_static_path(self, rel: str):
            """Resolve publish/ file path when present locally."""
            rel = urllib.parse.urlsplit(rel).path.lstrip("/").replace("\\", "/")
            if ".." in rel.split("/"):
                return None
            candidates = [
                PUBLISH_DIR / rel,
                PUBLISH_DIR / "static" / rel,
                ROOT / "publish" / rel,
                ROOT / "publish" / "static" / rel,
            ]
            if not rel.startswith("assets/"):
                for base in (PUBLISH_DIR, ROOT / "publish"):
                    asset = base / "assets" / rel
                    if asset.is_file():
                        candidates.insert(0, asset)
                        break
            for path in candidates:
                try:
                    if path.is_file():
                        return path
                except OSError:
                    continue
            return None

        def _guess_ctype(self, path: Path) -> str:
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix.lower() == ".webp":
                return "image/webp"
            if path.suffix.lower() == ".atlas":
                return "text/plain; charset=utf-8"
            if path.suffix.lower() == ".skel":
                return "application/octet-stream"
            return ctype

        def proxy_static(self, rel: str):
            # Local-first: avoid cloud empty responses / slow proxy for every texture.
            local_path = self._local_static_path(rel)
            if local_path is not None:
                return self._send_file(local_path, self._guess_ctype(local_path))
            url = f"{_origin()}/api/game-studio/proxy/{state.game_id}/static/{rel}"
            try:
                st, raw, hdr = state.upstream("GET", url)
            except Exception as e:
                print(f"[preview] static upstream fail {rel}: {e}", flush=True)
                return self._send(502, f"static proxy failed: {e}".encode("utf-8"), "text/plain; charset=utf-8")
            if st in (400, 401, 403, 404) or not raw:
                if st in (401, 403):
                    try:
                        state.refresh(force=True)
                        st, raw, hdr = state.upstream("GET", url)
                    except Exception as e:
                        print(f"[preview] auth refresh after {st}: {e}", flush=True)
                if st in (400, 401, 403, 404) or not raw:
                    local_path = self._local_static_path(rel)
                    if local_path is not None:
                        return self._send_file(local_path, self._guess_ctype(local_path))
            ctype = hdr.get("Content-Type") or hdr.get("content-type") or mimetypes.guess_type(rel)[0] or "application/octet-stream"
            self._send(st, raw or b"", ctype)

        def proxy_json(self, method: str, url: str, data):
            body = None if data is None else json.dumps(data).encode("utf-8")
            st, raw, hdr = state.upstream(
                method,
                url,
                body=body,
                content_type="application/json" if body is not None else None,
                accept="application/json",
            )
            ctype = hdr.get("Content-Type") or "application/json"
            self._send(st, raw, ctype)

        def proxy_kv(self, method: str, key, data=None):
            """REST: /api/gamefy/{chatId}/kv/{key}  GET→{value} PUT body={value} DELETE"""
            if not state.chat_id:
                return self._send(503, json.dumps({"error": "chatId not ready"}).encode(), "application/json")
            key = str(key or "").strip()
            if not key or "/" in key or "\\" in key:
                return self._send(400, json.dumps({"error": "invalid kv key"}).encode(), "application/json")
            url = f"{_origin()}/api/gamefy/{state.chat_id}/kv/{urllib.parse.quote(key, safe='')}"
            body = None if data is None else json.dumps(data).encode("utf-8")
            try:
                st, raw, hdr = state.upstream(
                    method,
                    url,
                    body=body,
                    content_type="application/json" if body is not None else None,
                    accept="application/json",
                )
            except Exception as e:
                print(f"[preview] kv {method} cloud fail {key}: {e}")
                payload = {"ok": False, "localOnly": True, "error": str(e)}
                if method == "GET":
                    payload = {"value": None, "error": str(e)}
                return self._send(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")
            # 对齐 SDK：get 返回 value；缺 key 时上游可能 404 或空
            if method == "GET" and st == 200:
                try:
                    obj = json.loads(raw.decode("utf-8"))
                    if isinstance(obj, dict) and "value" in obj:
                        raw = json.dumps({"value": obj.get("value")}).encode("utf-8")
                    elif isinstance(obj, dict) and "data" in obj and not obj.get("data"):
                        raw = json.dumps({"value": None}).encode("utf-8")
                except Exception:
                    pass
            elif method == "GET" and st == 404:
                raw = json.dumps({"value": None}).encode("utf-8")
                st = 200
            ctype = hdr.get("Content-Type") or "application/json"
            self._send(st, raw, ctype)

        def proxy_completions(self, body: dict):
            payload = {
                "model": body.get("model") or "default",
                "messages": body.get("messages") or [],
                "maxTokens": max(200, min(3000, int(body.get("maxTokens") or 1000))),
            }
            if state.chat_id:
                payload["chatId"] = state.chat_id
            st, raw, hdr = state.upstream(
                "POST",
                f"{_origin()}/api/gamefy/completions",
                body=json.dumps(payload).encode("utf-8"),
                content_type="application/json",
                accept="text/event-stream, application/json",
            )
            ctype = hdr.get("Content-Type") or "text/event-stream"
            self._send(st, raw, ctype)

        def proxy_chat_models(self):
            """真实 SDK：GET /api/trpc/chat.models?input={"json":{"service":"gamefy"}}"""
            q = urllib.parse.quote(json.dumps({"json": {"service": "gamefy"}}, separators=(",", ":")))
            st, raw, _ = state.upstream(
                "GET",
                f"{_origin()}/api/trpc/chat.models?input={q}",
                accept="application/json",
            )
            if st != 200:
                return self._send(st, raw, "application/json")
            try:
                obj = json.loads(raw.decode("utf-8"))
                data = (((obj.get("result") or {}).get("data") or {}).get("json")) or obj
                payload = {
                    "categories": data.get("categories") or [],
                    "models": data.get("models") or [],
                    "defaultModel": data.get("defaultModel") or "default",
                    "unsupportedLanguages": data.get("unsupportedLanguages"),
                    "language": data.get("language"),
                }
                return self._send(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        def proxy_draw_models(self, kind: str = "generate"):
            kind = kind if kind in ("generate", "edit") else "generate"
            st, raw, _ = state.upstream(
                "GET",
                f"{_origin()}/api/gamefy/draw/models?kind={urllib.parse.quote(kind)}",
                accept="application/json",
            )
            if st != 200:
                return self._send(st, raw, "application/json")
            try:
                obj = json.loads(raw.decode("utf-8"))
                payload = {
                    "models": obj.get("models") or [],
                    "defaultModel": obj.get("defaultModel")
                    or next((m.get("id") for m in (obj.get("models") or []) if m.get("isDefault")), None)
                    or ("anime" if kind == "generate" else "lite"),
                }
                return self._send(200, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        def _abs_draw_image(self, url: str) -> str:
            if not url:
                return url
            if url.startswith("http://") or url.startswith("https://"):
                return url
            if url.startswith("/"):
                return _origin() + url
            return url

        def proxy_draw_generate(self, body: dict):
            """对齐真实 SDK：POST /draw 创建任务，再轮询 /draw/status 直到 completed。"""
            payload = dict(body or {})
            if state.chat_id:
                payload["chatId"] = state.chat_id
            st, raw, _ = state.upstream(
                "POST",
                f"{_origin()}/api/gamefy/draw",
                body=json.dumps(payload).encode("utf-8"),
                content_type="application/json",
                accept="application/json",
            )
            if st != 200:
                return self._send(st, raw, "application/json")
            try:
                created = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._send(502, b'{"error":"invalid draw create response"}', "application/json")
            if created.get("success") is False:
                return self._send(
                    400,
                    json.dumps(
                        {
                            "error": created.get("message") or "Draw generation failed",
                            "code": created.get("code") or "CREATE_TASK_FAILED",
                        }
                    ).encode(),
                    "application/json",
                )
            task_id = created.get("taskId") or (created.get("task") or {}).get("id")
            if not task_id:
                return self._send(502, b'{"error":"Missing draw task identifier"}', "application/json")

            deadline = time.time() + 120
            delay = 1.0
            last_raw = b""
            while time.time() < deadline:
                st, last_raw, _ = state.upstream(
                    "GET",
                    f"{_origin()}/api/gamefy/draw/status?taskId={urllib.parse.quote(str(task_id))}",
                    accept="application/json",
                )
                if st == 200:
                    try:
                        obj = json.loads(last_raw.decode("utf-8"))
                    except Exception:
                        obj = {}
                    task = obj.get("task") or {}
                    status = task.get("status")
                    if status in ("pending", "processing"):
                        time.sleep(delay)
                        delay = min(delay + 0.5, 4.0)
                        continue
                    if status == "failed":
                        return self._send(
                            400,
                            json.dumps(
                                {
                                    "error": task.get("errorMessage") or "Draw generation failed",
                                    "code": task.get("errorCode") or "CREATE_TASK_FAILED",
                                }
                            ).encode(),
                            "application/json",
                        )
                    images = task.get("outputImages") or []
                    if not isinstance(images, list) or not images:
                        return self._send(
                            502,
                            json.dumps({"error": "Draw generation returned no images", "code": "NO_OUTPUT_IMAGES"}).encode(),
                            "application/json",
                        )
                    result = {
                        "taskId": task_id,
                        "images": [self._abs_draw_image(str(u)) for u in images],
                        "createdAt": task.get("createdAt") or "",
                        "status": status or "completed",
                        "errorMessage": task.get("errorMessage") or None,
                    }
                    return self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json")
                time.sleep(delay)
                delay = min(delay + 0.5, 4.0)
            return self._send(
                504,
                json.dumps({"error": "Draw generation timed out", "code": "DRAW_TIMEOUT"}).encode(),
                "application/json",
            )

        def serve_index(self):
            html = None
            local_index = None
            for cand in (PUBLISH_DIR / "index.html", ROOT / "publish" / "index.html", ROOT / "index.html"):
                if cand.is_file():
                    local_index = cand
                    break
            if local_index is not None:
                try:
                    html = local_index.read_text(encoding="utf-8")
                    try:
                        rel = local_index.relative_to(ROOT).as_posix()
                    except ValueError:
                        rel = str(local_index)
                    print(f"[preview] index from local {rel}")
                except OSError as e:
                    print(f"[preview] local index read fail: {e}")
            if html is None:
                url = f"{_origin()}/api/game-studio/proxy/{state.game_id}/static/index.html"
                try:
                    st, raw, _ = state.upstream("GET", url)
                except Exception as e:
                    print(f"[preview] index cloud fail: {e}")
                    return self._send(502, f"index load failed: {e}".encode("utf-8"), "text/plain; charset=utf-8")
                if st != 200:
                    return self._send(502, f"index load failed HTTP {st}".encode())
                html = raw.decode("utf-8", "replace")
            inject = f"<script>{BRIDGE_JS}</script><base href=\"/static/\">"
            if re.search(r"<head[^>]*>", html, flags=re.I):
                html = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + inject, html, count=1, flags=re.I)
            else:
                html = inject + html
            # 开发 UI 仅在控制台 8788；预览页只注入 SDK bridge
            self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character-id", type=int, default=DEFAULT_CARD_ID)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--project-root", type=Path, default=None, help="本地游戏项目根目录（含 publish/）")
    ap.add_argument("--publish-dir", type=Path, default=None, help="实际玩家包目录（含 index.html）")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    studio_mod = load_studio()
    if hasattr(studio_mod, "refresh_root"):
        studio_mod.refresh_root()
    project = args.project_root
    publish_dir = args.publish_dir
    if project is None and hasattr(studio_mod, "project_root"):
        project = studio_mod.project_root()
    if project is None:
        project = ROOT
    if hasattr(studio_mod, "resolve_game_project"):
        resolved = studio_mod.resolve_game_project(project)
        if resolved.get("ok"):
            project = resolved["root"]
            if publish_dir is None:
                publish_dir = resolved["publish_dir"]
        elif hasattr(studio_mod, "normalize_project_root"):
            project = studio_mod.normalize_project_root(project)
    elif hasattr(studio_mod, "normalize_project_root"):
        project = studio_mod.normalize_project_root(project)
    set_project_root(project, publish_dir)
    cid = int(args.character_id or 0)
    if not cid and hasattr(studio_mod, "load_config"):
        cid = int(studio_mod.load_config().get("character_id") or 0)
    if not cid:
        raise SystemExit("缺少 character_id")
    if not (PUBLISH_DIR / "index.html").is_file():
        raise SystemExit(f"缺少 index.html：{PUBLISH_DIR}")

    state = PreviewState(cid, port=args.port)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state))
    server.request_queue_size = 256
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[preview] root={ROOT}")
    print(f"[preview] publish={PUBLISH_DIR}")
    print(f"[preview] character_id={cid} port={args.port} ready {url}", flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[preview] stopped")


if __name__ == "__main__":
    main()
