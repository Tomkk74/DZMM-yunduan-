#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download studio/edit JS bundles and mine character API paths."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dzmm_studio as s  # noqa: E402

ORIGIN = s.ORIGIN
OUT = Path(__file__).resolve().parents[1] / ".probe-character-api"
OUT.mkdir(exist_ok=True)
JS_DIR = OUT / "js"
JS_DIR.mkdir(exist_ok=True)


def get(cookie, token, url, accept="*/*"):
    st, raw, _ = s.http(url, cookie, token, method="GET", timeout=60, accept=accept)
    return st, raw


def main():
    cookie, token, remain, email = s.load_auth(min_remain=60)
    print(f"login={email} remain={remain}")
    st, raw = get(cookie, token, f"{ORIGIN}/studio/edit", accept="text/html")
    html = raw.decode("utf-8", "replace")
    hrefs = re.findall(r"""(?:href|src)=["'](/assets/[^"']+\.js)["']""", html)
    hrefs = list(dict.fromkeys(hrefs))
    print(f"js assets: {len(hrefs)}")

    # context around createCharacter in HTML itself
    for m in re.finditer(r".{0,120}createCharacter.{0,120}", html, flags=re.I):
        print("HTML CTX:", m.group(0).replace("\n", " ")[:240])

    api_paths = set()
    trpc_paths = set()
    fetch_urls = set()
    keywords = []

    for rel in hrefs:
        url = ORIGIN + rel
        st2, body = get(cookie, token, url)
        if st2 != 200:
            print(f"FAIL {rel} HTTP {st2}")
            continue
        text = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
        # save
        (JS_DIR / Path(rel).name).write_bytes(body if isinstance(body, bytes) else body.encode("utf-8"))
        # mine
        for p in re.findall(r'["\'](/api/[a-zA-Z0-9_./?-]+)["\']', text):
            api_paths.add(p.split("?")[0])
        for p in re.findall(r'["\']([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.]*)["\']', text):
            if any(k in p.lower() for k in ("character", "card", "studio", "creator", "draft", "persona", "world")):
                trpc_paths.add(p)
        for p in re.findall(r'["\'](https?://[^"\']*(?:character|card|studio)[^"\']*)["\']', text, flags=re.I):
            fetch_urls.add(p[:200])
        # string literals containing createCharacter / publishCharacter etc
        for m in re.finditer(
            r'.{0,80}(createCharacter|updateCharacter|publishCharacter|saveCharacter|deleteCharacter|characterId|/character/)[a-zA-Z0-9_./-]*.{0,80}',
            text,
            flags=re.I,
        ):
            keywords.append((rel, m.group(0).replace("\n", " ")[:220]))
        print(f"ok {rel} bytes={len(body)}")

    print("\n=== /api paths ===")
    for p in sorted(api_paths):
        print(p)
    print("\n=== procedure-like ===")
    for p in sorted(trpc_paths):
        print(p)
    print("\n=== keyword contexts (sample) ===")
    for rel, ctx in keywords[:60]:
        print(f"[{Path(rel).name}] {ctx}")

    report = {
        "api_paths": sorted(api_paths),
        "trpc_like": sorted(trpc_paths),
        "keyword_hits": len(keywords),
        "bundles": hrefs,
    }
    (OUT / "mine_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "keyword_ctx.txt").write_text(
        "\n".join(f"{a}\t{b}" for a, b in keywords), encoding="utf-8"
    )
    print(f"\ndone -> {OUT}")


if __name__ == "__main__":
    main()
