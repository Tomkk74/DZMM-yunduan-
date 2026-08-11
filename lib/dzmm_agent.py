# -*- coding: utf-8 -*-
"""DZMM Workbench official coding Agent (Claude / Codex) via game-studio proxy."""
from __future__ import annotations

import json
import time
import urllib.parse
from typing import Any

import dzmm_studio as studio

DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit"]
DEFAULT_MAX_TURNS = 100
BACKENDS = ("claude", "codex")


def _cid() -> int:
    return int(studio.load_config().get("character_id") or 0)


def _auth():
    return studio.load_auth(min_remain=60)


def _proxy_base(game_id: str, backend: str = "claude") -> str:
    be = (backend or "claude").strip().lower()
    if be not in BACKENDS:
        be = "claude"
    return f"{studio.get_origin()}/api/game-studio/proxy/{game_id}/{be}"


def _http(url: str, cookie: str, token: str, method: str = "GET", data=None, timeout: int = 120, accept: str = "application/json"):
    cid = _cid() or studio.DEFAULT_CARD_ID
    headers = {
        "Cookie": cookie,
        "Authorization": f"Bearer {token}",
        "User-Agent": "Mozilla/5.0 DZMM-Studio-Bridge",
        "Accept": accept,
        "Referer": f"{studio.get_origin()}/studio/game-creation/workbench?character_id={cid}",
        "Origin": studio.get_origin(),
        "x-dzmm-request-id": f"agent{int(time.time()) % 10_000_000}",
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    import urllib.request
    import urllib.error

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def ensure_ready(character_id: int | None = None) -> dict:
    """Connect editor + heartbeat; return gameId / status."""
    cid = int(character_id or _cid() or 0)
    if cid <= 0:
        raise RuntimeError("请先在「项目配置」填写有效的游戏卡 character_id")
    cookie, token, remain, email = _auth()
    # 先探活：卡可能仍存在，但当前账号不是 owner（本地预览仍可用）
    try:
        st_h, raw_h, _ = _http(
            f"{studio.get_origin()}/api/game-studio/proxy/{cid}/health",
            cookie,
            token,
            method="GET",
            timeout=20,
        )
        if st_h == 403:
            detail = ""
            try:
                detail = json.loads(raw_h.decode("utf-8", "replace")).get("error") or ""
            except Exception:
                detail = raw_h[:120].decode("utf-8", "replace") if isinstance(raw_h, (bytes, bytearray)) else str(raw_h)
            raise RuntimeError(
                f"游戏卡 #{cid} 在平台上存在，但当前登录账号没有 Workbench 所有权"
                f"（{detail or 'not the game owner'}）。"
                f"当前登录：{email or '未知'}。"
                "官方助手只能用「卡主账号」登录；请换创建/持有该卡的账号，或把项目配置改成你名下的游戏卡 ID。"
            )
    except RuntimeError:
        raise
    except Exception:
        pass

    try:
        info, game_id = studio.ensure_editor(cookie, token, cid)
    except SystemExit as e:
        msg = str(e)
        if "角色卡不存在" in msg or "NOT_FOUND" in msg or "404" in msg or "\\xe8\\xa7\\x92" in msg:
            raise RuntimeError(
                f"当前登录账号无法打开游戏卡 #{cid} 的 Workbench（editor 返回不存在/无权限）。"
                "本地预览只读本机文件，不代表你是云端卡主。"
                f"当前登录：{email or '未知'}。请用卡主账号登录后再连官方助手。"
            ) from e
        raise RuntimeError(msg) from e
    gid = str(game_id)
    st, raw, _ = _http(
        f"{studio.get_origin()}/api/game-studio/proxy/{gid}/heartbeat",
        cookie,
        token,
        method="POST",
        data={},
        timeout=30,
    )
    hb = {}
    if raw:
        try:
            hb = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            pass
    if st not in (200, 201) and not hb.get("success"):
        err = raw[:200] if isinstance(raw, (bytes, bytearray)) else raw
        raise RuntimeError(f"容器心跳失败 HTTP {st}: {err}")
    return {
        "characterId": cid,
        "gameId": gid,
        "editorStatus": (info or {}).get("status"),
        "containerId": (info or {}).get("containerId"),
        "ttlSeconds": hb.get("ttlSeconds"),
        "email": email,
        "remainSec": remain,
        "backends": list(BACKENDS),
    }


def list_sessions(backend: str = "claude", limit: int = 20) -> dict:
    ready = ensure_ready()
    cookie, token, _, _ = _auth()
    gid = ready["gameId"]
    url = f"{_proxy_base(gid, backend)}/sessions?limit={int(limit)}"
    st, raw, _ = _http(url, cookie, token, method="GET", timeout=45)
    if st != 200:
        raise RuntimeError(f"拉取会话失败 HTTP {st}: {raw[:200]!r}")
    data = json.loads(raw.decode("utf-8", "replace") or "{}")
    return {"ok": True, **ready, "backend": backend, "sessions": data}


def session_messages(session_id: str, backend: str = "claude", limit: int = 100) -> dict:
    ready = ensure_ready()
    cookie, token, _, _ = _auth()
    gid = ready["gameId"]
    sid = urllib.parse.quote(str(session_id or "").strip(), safe="")
    if not sid:
        raise RuntimeError("缺少 sessionId")
    url = f"{_proxy_base(gid, backend)}/sessions/{sid}/messages?limit={int(limit)}"
    st, raw, _ = _http(url, cookie, token, method="GET", timeout=60)
    if st != 200:
        raise RuntimeError(f"拉取消息失败 HTTP {st}: {raw[:200]!r}")
    data = json.loads(raw.decode("utf-8", "replace") or "{}")
    return {"ok": True, **ready, "backend": backend, "sessionId": session_id, **data}


def send_prompt(
    prompt: str,
    *,
    backend: str = "claude",
    resume_session_id: str | None = None,
    allowed_tools: list[str] | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
    continue_session: bool = True,
) -> dict:
    text = (prompt or "").strip()
    if not text:
        raise RuntimeError("请输入内容")
    ready = ensure_ready()
    cookie, token, _, _ = _auth()
    gid = ready["gameId"]
    payload: dict[str, Any] = {
        "prompt": text,
        "allowedTools": allowed_tools or list(DEFAULT_TOOLS),
        "maxTurns": max(1, min(200, int(max_turns or DEFAULT_MAX_TURNS))),
    }
    # 与官网一致：只有拿到「对话 session」才带 continue + resumeSessionId
    # （async-run 返回的 sessionId 是任务包装 ID，不能用来续聊）
    resume = str(resume_session_id or "").strip()
    if continue_session and resume:
        payload["continue"] = True
        payload["resumeSessionId"] = resume
    url = f"{_proxy_base(gid, backend)}/async-run"
    st, raw, _ = _http(url, cookie, token, method="POST", data=payload, timeout=90)
    if st not in (200, 201, 202):
        raise RuntimeError(f"发送失败 HTTP {st}: {raw[:300]!r}")
    data = json.loads(raw.decode("utf-8", "replace") or "{}")
    if not data.get("taskId"):
        raise RuntimeError(f"发送失败：未返回 taskId {data!r}")
    return {
        "ok": True,
        **ready,
        "backend": (backend or "claude").lower(),
        "taskId": data.get("taskId"),
        # 续聊请用 poll 里从事件提取的 conversationSessionId；此处仅作回显
        "taskSessionId": data.get("sessionId") or "",
        "sessionId": resume or "",
        "prompt": text,
    }


def poll_task(
    task_id: str,
    *,
    backend: str = "claude",
    since: int = 0,
    game_id: str | None = None,
) -> dict:
    """轮询任务；不每次 ensure_editor，避免拖垮流式事件。"""
    cookie, token, _, _ = _auth()
    gid = str(game_id or _cid() or "").strip()
    if not gid:
        ready = ensure_ready()
        gid = str(ready["gameId"])
    tid = urllib.parse.quote(str(task_id or "").strip(), safe="")
    if not tid:
        raise RuntimeError("缺少 taskId")
    url = f"{_proxy_base(gid, backend)}/tasks/{tid}/status?since={int(since or 0)}"
    # 工具轮次结束时可能一次吐大量事件，超时放宽
    st, raw, _ = _http(url, cookie, token, method="GET", timeout=90)
    if st == 404:
        raise RuntimeError("任务不存在或已过期")
    if st in (410, 503):
        err = ""
        try:
            err = json.loads(raw.decode("utf-8", "replace")).get("error") or ""
        except Exception:
            pass
        raise RuntimeError(err or f"容器不可用 HTTP {st}")
    if st != 200 or not raw:
        raise RuntimeError(f"轮询失败 HTTP {st}: {(raw or b'')[:200]!r}")
    data = json.loads(raw.decode("utf-8", "replace") or "{}")
    events = data.get("events") or []
    deltas = []
    last_id = int(since or 0)
    conversation_sid = ""
    for row in events:
        try:
            eid = int(row.get("id") or 0)
        except Exception:
            eid = 0
        if eid > last_id:
            last_id = eid
        ev = row.get("event") or row
        try:
            sid = _conversation_session_from_event(ev)
            if sid:
                conversation_sid = sid
            for piece in extract_event_pieces(ev):
                if piece:
                    deltas.append(piece)
        except Exception:
            continue
    raw_status = data.get("status") or "running"
    if isinstance(raw_status, dict):
        task_status = str(
            raw_status.get("status")
            or raw_status.get("state")
            or raw_status.get("phase")
            or "running"
        )
    else:
        task_status = str(raw_status)
    done = task_status in ("completed", "failed", "cancelled", "error")
    # 若流式 delta 漏了，用完整 assistant / item/completed 文本兜底
    if done and not any(d.get("kind") == "text" for d in deltas):
        for row in events:
            for piece in extract_event_pieces(row.get("event") or row, prefer_full=True):
                if not piece:
                    continue
                if piece.get("kind") == "text":
                    deltas.append(piece)
                elif piece.get("kind") in ("reasoning", "tool", "tool_output") and not any(
                    x.get("kind") == piece.get("kind") and x.get("text") == piece.get("text") for x in deltas
                ):
                    deltas.append(piece)

    # 限制单次轮询体积：正文/状态必留，只压缩或省略工具输出，避免连接被撑爆中断
    capped: list[dict] = []
    budget = 16000
    used = 0
    omitted_tools = 0
    for piece in deltas:
        kind = str(piece.get("kind") or "")
        p = piece
        if kind in ("tool_output", "tool"):
            p = dict(piece)
            for key in ("text", "detail"):
                val = str(p.get(key) or "")
                lim = 200 if kind == "tool_output" else 160
                if len(val) > lim:
                    p[key] = val[:lim] + "…"
            if kind == "tool_output":
                p.pop("detail", None)
        blob_n = len(json.dumps(p, ensure_ascii=False))
        # 助手正文 / 思考 / 状态始终保留
        if kind in ("text", "status", "reasoning") or used + blob_n <= budget:
            capped.append(p)
            used += blob_n
        else:
            omitted_tools += 1
    if omitted_tools:
        capped.append({
            "kind": "status",
            "text": f"…另有 {omitted_tools} 条工具输出已省略（防中断）",
            "status": "info",
        })

    return {
        "ok": True,
        "gameId": gid,
        "backend": (backend or "claude").lower(),
        "taskId": task_id,
        "taskStatus": task_status,
        "done": done,
        "since": last_id,
        # 续聊必须用事件里的 conversation session，不是 async-run 的 taskSessionId
        "sessionId": conversation_sid,
        "taskSessionId": str(data.get("sessionId") or ""),
        # 不把原始 events 回传浏览器（体积大，易导致连接重置）
        "eventCount": len(events),
        "deltas": capped,
    }


def _conversation_session_from_event(ev: Any) -> str:
    """Extract resume-able conversation/thread id from Claude/Codex events."""
    if not isinstance(ev, dict):
        return ""
    # Claude Code: session_id on stream_event / assistant / result / system init
    sid = ev.get("session_id") or ev.get("sessionId")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()
    if str(ev.get("type") or "") == "system" and ev.get("subtype") == "init":
        sid = ev.get("session_id") or ev.get("sessionId")
        if isinstance(sid, str) and sid.strip():
            return sid.strip()
    method = str(ev.get("method") or ev.get("type") or "")
    params = ev.get("params") if isinstance(ev.get("params"), dict) else {}
    # Codex: thread/started → thread.id
    if method == "thread/started":
        thread = params.get("thread") if isinstance(params.get("thread"), dict) else {}
        tid = thread.get("id") or thread.get("sessionId")
        if isinstance(tid, str) and tid.strip():
            return tid.strip()
    if method in ("session",) or str(ev.get("type") or "") == "session":
        tid = ev.get("sessionId") or params.get("sessionId")
        if isinstance(tid, str) and tid.strip():
            return tid.strip()
    return ""


def cancel_task(task_id: str, backend: str = "claude") -> dict:
    ready = ensure_ready()
    cookie, token, _, _ = _auth()
    gid = ready["gameId"]
    tid = urllib.parse.quote(str(task_id or "").strip(), safe="")
    url = f"{_proxy_base(gid, backend)}/tasks/{tid}"
    st, raw, _ = _http(url, cookie, token, method="DELETE", timeout=30)
    return {"ok": st in (200, 204), "statusCode": st, "gameId": gid, "taskId": task_id}


def _text_from_content_blocks(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
        elif isinstance(block, str):
            parts.append(block)
    return "".join(parts)


def _thinking_from_content_blocks(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "thinking":
            parts.append(str(block.get("thinking") or block.get("text") or ""))
    return "".join(parts)


def _tools_from_content_blocks(content: Any) -> list[dict]:
    if not isinstance(content, list):
        return []
    out: list[dict] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = str(block.get("name") or "tool")
        detail = ""
        inp = block.get("input")
        if isinstance(inp, dict) and inp:
            try:
                detail = json.dumps(inp, ensure_ascii=False)[:160]
            except Exception:
                detail = str(inp)[:160]
        out.append({
            "kind": "tool",
            "tool": name,
            "text": detail or name,
            "itemId": block.get("id"),
            "status": "running",
        })
    return out


def _tool_results_from_user_content(content: Any) -> list[dict]:
    if not isinstance(content, list):
        return []
    out: list[dict] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        body = block.get("content")
        if isinstance(body, list):
            parts = []
            for b in body:
                if isinstance(b, dict) and b.get("type") == "text":
                    parts.append(str(b.get("text") or ""))
                elif isinstance(b, str):
                    parts.append(b)
            body = "".join(parts)
        text = str(body or "")
        # 工具输出可能很长，只给预览，避免撑爆轮询响应
        lines = text.splitlines()
        preview = "\n".join(lines[:12])
        if len(preview) > 360:
            preview = preview[:360] + "…"
        elif len(lines) > 12:
            preview = preview + f"\n…共 {len(lines)} 行"
        is_err = bool(block.get("is_error"))
        out.append({
            "kind": "tool_output",
            "text": preview or ("(error)" if is_err else "(ok)"),
            "detail": text if text and text != preview else "",
            "itemId": block.get("tool_use_id"),
            "status": "error" if is_err else "done",
            "lines": len(lines),
        })
    return out


def _pieces_from_codex_item(item: Any) -> list[dict]:
    """Normalize Codex item payloads (started/completed)."""
    if not isinstance(item, dict):
        return []
    it = str(item.get("type") or "")
    if it == "agentMessage":
        text = str(item.get("text") or "")
        return [{"kind": "text", "text": text}] if text else []
    if it == "commandExecution":
        cmd = str(item.get("command") or item.get("description") or "shell")
        st = str(item.get("status") or "")
        # 长 bash -lc 命令折叠展示；摘要取首行/截断
        summary = cmd.strip().split("\n", 1)[0]
        if len(summary) > 100:
            summary = summary[:100] + "…"
        return [{
            "kind": "tool",
            "tool": "shell",
            "text": summary,
            "detail": cmd if cmd != summary else "",
            "status": st,
            "itemId": item.get("id"),
        }]
    if it == "fileChange":
        changes = item.get("changes") or []
        paths = []
        if isinstance(changes, list):
            for c in changes[:6]:
                if isinstance(c, dict) and c.get("path"):
                    paths.append(str(c["path"]))
        label = ", ".join(paths) if paths else "file change"
        return [{"kind": "tool", "tool": "edit", "text": label, "status": str(item.get("status") or "")}]
    if it == "reasoning":
        summary = item.get("summary")
        text = ""
        if isinstance(summary, list):
            parts = []
            for s in summary:
                if isinstance(s, dict) and s.get("type") == "summary_text":
                    parts.append(str(s.get("text") or ""))
                elif isinstance(s, str):
                    parts.append(s)
            text = "".join(parts)
        elif isinstance(summary, str):
            text = summary
        if not text:
            text = str(item.get("text") or "")
        return [{"kind": "reasoning", "text": text}] if text else []
    if it in ("mcpToolCall", "dynamicToolCall"):
        name = str(item.get("tool") or item.get("name") or it)
        server = str(item.get("server") or "")
        label = f"{server}:{name}" if server else name
        return [{"kind": "tool", "tool": label, "text": label, "status": str(item.get("status") or "")}]
    return []


def extract_event_pieces(ev: Any, prefer_full: bool = False) -> list[dict]:
    """Normalize upstream agent events into UI-friendly pieces.

    Covers Claude (`type`/`stream_event`) and Codex (`method` like `item/agentMessage/delta`).
    """
    if not isinstance(ev, dict):
        return []
    # 有些包装层把真实事件塞在 event / data / payload 里
    if not (ev.get("type") or ev.get("method")) and isinstance(ev.get("event"), dict):
        return extract_event_pieces(ev.get("event"), prefer_full=prefer_full)

    # Codex 用 method；Claude 用 type
    et = str(ev.get("type") or ev.get("method") or "").strip()
    out: list[dict] = []
    params = ev.get("params") if isinstance(ev.get("params"), dict) else {}

    # —— Codex 实时增量（与官网 Workbench 一致）——
    if et == "item/agentMessage/delta":
        delta = params.get("delta") or ev.get("delta") or ""
        if delta:
            out.append({
                "kind": "text",
                "text": str(delta),
                "itemId": params.get("itemId") or ev.get("itemId"),
                "stream": True,
            })
        return out

    if et == "item/reasoning/summaryTextDelta":
        delta = params.get("delta") or ev.get("delta") or ""
        if delta:
            out.append({
                "kind": "reasoning",
                "text": str(delta),
                "itemId": params.get("itemId"),
                "stream": True,
            })
        return out

    if et == "item/commandExecution/outputDelta":
        delta = str(params.get("delta") or ev.get("delta") or "")
        if delta:
            # 流式 shell 输出很大，只保留短片段，完整内容看容器/折叠摘要
            if len(delta) > 160:
                delta = delta[:160] + "…"
            out.append({
                "kind": "tool_output",
                "text": delta,
                "itemId": params.get("itemId") or ev.get("itemId"),
            })
        return out

    if et == "item/started":
        item = params.get("item") or ev.get("item")
        return _pieces_from_codex_item(item)

    if et == "item/completed":
        item = params.get("item") or ev.get("item")
        pieces = _pieces_from_codex_item(item)
        if prefer_full:
            for p in pieces:
                if p.get("kind") == "text":
                    p["replace"] = True
                    p["full"] = True
            return pieces
        # 进行中：工具/思考仍展示；完整 assistant 文本交给 delta，避免重复
        return [p for p in pieces if p.get("kind") != "text"]

    if et == "turn/completed":
        turn = params.get("turn") or ev.get("turn") or {}
        if isinstance(turn, dict) and turn.get("status") == "completed":
            out.append({"kind": "status", "text": "Done", "status": "completed"})
        elif isinstance(turn, dict):
            err = ""
            if isinstance(turn.get("error"), dict):
                err = str(turn["error"].get("message") or "")
            out.append({"kind": "status", "text": err or "Turn failed", "status": "error"})
        return out

    if et == "message_delta":
        text = ev.get("text") or params.get("text") or params.get("delta") or ""
        if text:
            out.append({"kind": "text", "text": str(text), "stream": True, "itemId": ev.get("itemId") or params.get("itemId")})
        return out

    if et == "agentMessage":
        text = str(ev.get("text") or "")
        if text:
            out.append({
                "kind": "text",
                "text": text,
                "itemId": ev.get("id"),
                "full": True,
                "replace": bool(prefer_full),
            })
        return out

    # Claude 完整助手消息：正文 + 工具调用
    if et == "assistant":
        msg = ev.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else None
        text = ""
        if isinstance(msg, dict):
            text = _text_from_content_blocks(content)
        elif isinstance(msg, str):
            text = msg
        if not text:
            text = str(ev.get("text") or "")
        # 先抛出工具，便于 UI 在长耗时工具期间有反馈
        out.extend(_tools_from_content_blocks(content))
        thinking = _thinking_from_content_blocks(content)
        if thinking and prefer_full:
            out.append({"kind": "reasoning", "text": thinking, "full": True})
        if text:
            out.append({
                "kind": "text",
                "text": text,
                "full": True,
                "replace": bool(prefer_full),
            })
        return out

    # Claude 工具结果（user 角色回灌）
    if et == "user":
        msg = ev.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else None
        out.extend(_tool_results_from_user_content(content))
        return out

    if et == "tool_progress":
        name = str(ev.get("tool_name") or ev.get("tool") or "tool")
        note = str(ev.get("note") or ev.get("message") or "")
        elapsed = ev.get("elapsed_time_seconds")
        text = note or name
        if elapsed not in (None, ""):
            text = f"{name} · {elapsed}s" + (f" · {note}" if note else "")
        out.append({"kind": "tool", "tool": name, "text": text, "status": "running"})
        return out

    if et == "stream_event":
        if prefer_full:
            return out
        inner = ev.get("event") or {}
        if not isinstance(inner, dict):
            return out
        it = str(inner.get("type") or "")
        if it == "content_block_delta":
            delta = inner.get("delta") or {}
            if isinstance(delta, dict):
                dtype = str(delta.get("type") or "")
                if dtype == "thinking_delta" and delta.get("thinking"):
                    out.append({"kind": "reasoning", "text": str(delta.get("thinking")), "stream": True})
                elif dtype == "text_delta" or (dtype in ("",) and delta.get("text")):
                    t = delta.get("text")
                    if t:
                        out.append({"kind": "text", "text": str(t), "stream": True})
                # input_json_delta：工具参数拼装中，不刷屏
        elif it == "content_block_start":
            block = inner.get("content_block") or {}
            if not isinstance(block, dict):
                return out
            bt = str(block.get("type") or "")
            if bt == "text" and block.get("text"):
                out.append({"kind": "text", "text": str(block.get("text")), "stream": True})
            elif bt == "thinking" and block.get("thinking"):
                out.append({"kind": "reasoning", "text": str(block.get("thinking")), "stream": True})
            elif bt == "tool_use":
                name = str(block.get("name") or "tool")
                out.append({
                    "kind": "tool",
                    "tool": name,
                    "text": name,
                    "itemId": block.get("id"),
                    "status": "running",
                })
        return out

    if et == "commandExecution":
        return _pieces_from_codex_item(ev)

    if et == "fileChange":
        return _pieces_from_codex_item(ev)

    if et == "reasoning":
        summary = ev.get("summary")
        text = ""
        if isinstance(summary, list):
            parts = []
            for s in summary:
                if isinstance(s, dict) and s.get("type") == "summary_text":
                    parts.append(str(s.get("text") or ""))
                elif isinstance(s, str):
                    parts.append(s)
            text = "".join(parts)
        elif isinstance(summary, str):
            text = summary
        if not text:
            text = str(ev.get("text") or "")
        if text:
            out.append({"kind": "reasoning", "text": text, "full": True})
        return out

    if et == "result":
        msg = ev.get("result") or ev.get("message") or ""
        if ev.get("is_error") or str(ev.get("subtype") or "") in ("error", "failure"):
            err = ev.get("error") or ev.get("result") or ev.get("message") or msg or "error"
            if isinstance(err, dict):
                err = err.get("message") or err.get("error") or json.dumps(err, ensure_ascii=False)
            err_s = str(err).strip() or "error"
            if err_s.lower() in ("error", "failed", "failure"):
                err_s = "任务失败（无详细信息）。可点停止后重发，或换更短的问题。"
            out.append({"kind": "status", "text": err_s, "status": "error"})
            return out
        if prefer_full and msg:
            out.append({"kind": "text", "text": str(msg), "replace": True, "full": True})
        return out

    if et == "error":
        err = ev.get("error") or ev.get("message") or ev.get("result") or "error"
        if isinstance(err, dict):
            err = err.get("message") or err.get("error") or json.dumps(err, ensure_ascii=False)
        err_s = str(err).strip() or "error"
        if err_s.lower() in ("error", "failed", "failure"):
            err_s = "任务失败（无详细信息）。可点停止后重发，或换更短的问题。"
        out.append({"kind": "status", "text": err_s, "status": "error"})
        return out

    return out


def extract_event_piece(ev: Any) -> dict | None:
    pieces = extract_event_pieces(ev)
    return pieces[0] if pieces else None
