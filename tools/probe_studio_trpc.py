#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe confirmed studio.* tRPC procedures (read-only where possible)."""
from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dzmm_studio as s  # noqa: E402

ORIGIN = s.ORIGIN
OUT = Path(__file__).resolve().parents[1] / ".probe-character-api"


def trpc(cookie, token, path, payload=None, method="GET"):
    if payload is None:
        payload = {}
    if method == "GET":
        q = urllib.parse.quote(json.dumps({"0": {"json": payload}}, separators=(",", ":")))
        url = f"{ORIGIN}/api/trpc/{path}?batch=1&input={q}"
        st, raw, _ = s.http(url, cookie, token, method="GET", timeout=45, accept="application/json")
    else:
        url = f"{ORIGIN}/api/trpc/{path}?batch=1"
        body = {"0": {"json": payload}}
        st, raw, _ = s.http(
            url,
            cookie,
            token,
            method="POST",
            data=body,
            timeout=45,
            accept="application/json",
        )
    text = raw.decode("utf-8", "replace")
    return st, text


def main():
    cookie, token, remain, email = s.load_auth(min_remain=60)
    print(f"login={email} remain={remain}")

    probes = [
        ("GET", "studio.getCharacters", {}),
        ("GET", "studio.getDraft", {"id": -1}),
        ("GET", "studio.getCharacterCard", {"id": 3374995}),
        ("GET", "studio.getGameStats", {}),
        ("GET", "studio.getMyVoices", {}),
        ("GET", "studio.getVoices", {}),
        ("GET", "card.getForChat", {"cardId": 3374995}),
    ]
    results = []
    for method, path, payload in probes:
        try:
            st, text = trpc(cookie, token, path, payload, method=method)
        except Exception as e:
            print(f"{path} ERR {e}")
            continue
        print(f"\n=== {path} HTTP {st} ===")
        print(text[:700])
        results.append({"path": path, "status": st, "body": text[:4000]})

    OUT.mkdir(exist_ok=True)
    (OUT / "studio_trpc_probe.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nsaved {OUT / 'studio_trpc_probe.json'}")


if __name__ == "__main__":
    main()
