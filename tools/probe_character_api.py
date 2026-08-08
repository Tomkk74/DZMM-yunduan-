#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe DZMM studio/edit character APIs using saved login. Read-only discovery."""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dzmm_studio as s  # noqa: E402

ORIGIN = s.ORIGIN
OUT = Path(__file__).resolve().parents[1] / ".probe-character-api"
OUT.mkdir(exist_ok=True)


def try_req(cookie, token, method, url, data=None, accept="application/json"):
    try:
        st, raw, _ = s.http(
            url, cookie, token, method=method, data=data, timeout=45, accept=accept
        )
        text = raw.decode("utf-8", "replace")
        return st, text
    except Exception as e:
        return None, str(e)


def trpc_get(cookie, token, path: str, payload=None):
    if payload is None:
        payload = {}
    q = urllib.parse.quote(json.dumps({"0": {"json": payload}}, separators=(",", ":")))
    url = f"{ORIGIN}/api/trpc/{path}?batch=1&input={q}"
    return try_req(cookie, token, "GET", url)


def main():
    cookie, token, remain, email = s.load_auth(min_remain=60)
    print(f"login={email} remain_s={remain}")

    st, html = try_req(
        cookie, token, "GET", f"{ORIGIN}/studio/edit", accept="text/html"
    )
    print(f"studio/edit HTTP {st} len={len(html) if html else 0}")
    (OUT / "edit.html").write_text(html or "", encoding="utf-8")

    chunks = sorted(set(re.findall(r"/_next/static/[^\"'\\s>]+\.js", html or "")))
    print(f"js chunks in html: {len(chunks)}")
    (OUT / "chunks.txt").write_text("\n".join(chunks), encoding="utf-8")

    # Also pull build manifest if present
    build_ids = re.findall(r"/_next/static/([A-Za-z0-9_-]+)/_buildManifest\.js", html or "")
    for bid in build_ids[:1]:
        url = f"{ORIGIN}/_next/static/{bid}/_buildManifest.js"
        st2, body = try_req(cookie, token, "GET", url, accept="*/*")
        print(f"buildManifest HTTP {st2}")
        if body:
            (OUT / "buildManifest.js").write_text(body, encoding="utf-8")

    # Download a few large app chunks and mine procedure-like strings
    interesting = []
    for rel in chunks:
        if any(x in rel for x in ("app/", "studio", "edit", "page-", "main-app", "webpack")):
            interesting.append(rel)
    # fallback: take some chunks
    if len(interesting) < 5:
        interesting = chunks[:25]

    hits = []
    proc_names = set()
    for rel in interesting[:40]:
        url = ORIGIN + rel if rel.startswith("/") else f"{ORIGIN}/{rel}"
        st2, body = try_req(cookie, token, "GET", url, accept="*/*")
        if not body or st2 != 200:
            continue
        # mine trpc-like paths
        for m in re.findall(
            r'["\']([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){1,3})["\']',
            body,
        ):
            low = m.lower()
            if any(
                k in low
                for k in (
                    "character",
                    "card",
                    "persona",
                    "role",
                    "studio",
                    "creator",
                    "worldbook",
                    "lore",
                    "prompt",
                    "avatar",
                    "publish",
                    "draft",
                )
            ):
                proc_names.add(m)
        if "trpc" in body or "character" in body.lower():
            hits.append((rel, len(body)))
            # save snippet file for heavy hits
            name = rel.replace("/", "_").replace("?", "_")[-80:]
            (OUT / f"js_{name}").write_bytes(body.encode("utf-8", "replace") if isinstance(body, str) else body)

    print(f"candidate procedure-like strings: {len(proc_names)}")
    names = sorted(proc_names)
    (OUT / "proc_candidates.txt").write_text("\n".join(names), encoding="utf-8")
    for n in names[:80]:
        print(" ", n)

    # Probe likely trpc procedures
    probes = [
        "character.list",
        "character.mine",
        "character.myCharacters",
        "character.getMyCharacters",
        "character.create",
        "character.createDraft",
        "character.save",
        "character.update",
        "character.publish",
        "character.getById",
        "character.get",
        "characters.mine",
        "characters.create",
        "userCharacters.list",
        "userCharacter.list",
        "userCharacter.create",
        "creator.list",
        "creator.characters",
        "studio.listCharacters",
        "studio.createCharacter",
        "studio.character.create",
        "chat.characters",
        "chat.listCharacters",
        "profile.characters",
    ]
    # add dotted names from candidates that look like procedures
    for n in names:
        if "." in n and n.count(".") <= 2 and re.match(r"^[a-zA-Z]+\.[a-zA-Z]", n):
            if any(k in n.lower() for k in ("character", "card", "studio", "creator", "draft")):
                probes.append(n)
    probes = list(dict.fromkeys(probes))

    results = []
    for path in probes:
        st3, text = trpc_get(cookie, token, path)
        snippet = (text or "")[:240].replace("\n", " ")
        # classify
        kind = "other"
        if st3 == 404 and "No procedure found" in (text or ""):
            kind = "missing"
        elif st3 == 200:
            kind = "OK"
        elif st3 in (400, 401, 403):
            kind = "exists-auth/input"
        elif st3 is not None:
            kind = f"http-{st3}"
        if kind != "missing":
            print(f"HIT {path} -> {kind} {snippet[:160]}")
            results.append({"path": path, "status": st3, "kind": kind, "snippet": snippet})

    (OUT / "trpc_hits.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"done. non-missing hits={len(results)} out={OUT}")


if __name__ == "__main__":
    main()
