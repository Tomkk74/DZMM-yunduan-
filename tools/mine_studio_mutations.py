#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deep-mine studio edit bundles for mutation/API endpoints."""
from __future__ import annotations

import re
from pathlib import Path

JS_DIR = Path(__file__).resolve().parents[1] / ".probe-character-api" / "js"
OUT = Path(__file__).resolve().parents[1] / ".probe-character-api"


def main():
    files = sorted(JS_DIR.glob("*.js"), key=lambda p: -p.stat().st_size)
    patterns = [
        r"createOrUpdateCharacter",
        r"createDraft",
        r"saveDraft",
        r"publishCharacter",
        r"mutateAsync",
        r"/api/[a-zA-Z0-9_./-]+",
        r"trpc\.[a-zA-Z0-9_.]+",
        r"['\"]api\.[a-zA-Z0-9_.]+['\"]",
        r"character\.(create|update|publish|save|get|list|draft)[a-zA-Z]*",
        r"draft\.(create|update|save|publish|get)[a-zA-Z]*",
        r"studio\.[a-zA-Z0-9_.]+",
        r"rawData",
        r"editorMode",
        r"world_book|character_book|avatar_url|chat_history",
        r"supabase|rest/v1",
        r"gamefy/",
    ]
    hits = []
    for fp in files:
        text = fp.read_text(encoding="utf-8", errors="replace")
        for pat in patterns:
            for m in re.finditer(pat, text, flags=re.I):
                start = max(0, m.start() - 100)
                end = min(len(text), m.end() + 160)
                ctx = text[start:end].replace("\n", " ")
                hits.append((fp.name, pat, ctx))

    # Dedup by ctx
    seen = set()
    lines = []
    for name, pat, ctx in hits:
        key = (name, pat, ctx[:120])
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"[{name}] /{pat}/\n  {ctx}\n")

    out = OUT / "mutation_ctx.txt"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"hits={len(lines)} -> {out}")

    # Focus D4 and main bundle for URL construction
    for focus in ("D4_csDye.js", "CI4523dA.js", "BvqsKWV-.js", "Dp04fI0j.js"):
        fp = JS_DIR / focus
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")
        print(f"\n==== {focus} size={len(text)} ====")
        for pat in (
            r'["\']/api/[^"\']+["\']',
            r'["\'][^"\']*character[^"\']*["\']',
            r'fetch\([^)]{0,200}',
            r'\.mutate[A-Za-z]*\([^)]{0,120}',
            r'useMutation\([^)]{0,200}',
            r'procedure[^,]{0,80}',
        ):
            ms = list(re.finditer(pat, text, flags=re.I))
            if not ms:
                continue
            print(f"  pattern {pat}: {len(ms)}")
            for m in ms[:12]:
                s = max(0, m.start() - 40)
                e = min(len(text), m.end() + 80)
                print("   ", text[s:e].replace("\n", " ")[:200])


if __name__ == "__main__":
    main()
