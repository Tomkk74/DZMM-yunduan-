#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import re
from pathlib import Path

JS_DIR = Path(__file__).resolve().parents[1] / ".probe-character-api" / "js"
OUT = Path(__file__).resolve().parents[1] / ".probe-character-api"


def contexts(text: str, needle: str, pad: int = 180, limit: int = 30):
    out = []
    for m in re.finditer(re.escape(needle), text, flags=re.I):
        s = max(0, m.start() - pad)
        e = min(len(text), m.end() + pad)
        out.append(text[s:e].replace("\n", " "))
        if len(out) >= limit:
            break
    return out


def main():
    # Prefer small imported modules referenced by studio edit
    focus = [
        "CYUu9pw8.js",
        "D4_csDye.js",
        "BlOXH3jK.js",
        "Dp04fI0j.js",
        "CI4523dA.js",
    ]
    needles = [
        "createOrUpdateCharacter",
        "rawData",
        "draftId",
        "Kk.",
        "character.create",
        "character.update",
        "character.publish",
        "character.save",
        "character.draft",
        "card.create",
        "card.update",
        "card.publish",
        "card.save",
        "studio.character",
        "studio.draft",
        "draft.create",
        "draft.save",
        "draft.publish",
        "/api/card",
        "character-card",
        "db_id",
        "character_book",
        "world_book",
        "qe=",
        "function qe",
        "lt=",
        "Ke=",
    ]
    lines = []
    for name in focus:
        fp = JS_DIR / name
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")
        lines.append(f"\n===== {name} =====\n")
        # Extract Kk.xxx.yyy style procedure refs
        procs = sorted(set(re.findall(r"\bKk\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,3})\b", text)))
        char_procs = [p for p in procs if any(k in p.lower() for k in ("char", "card", "draft", "studio", "world", "persona"))]
        lines.append(f"Kk.* procedures mentioning card/char/draft/studio: {len(char_procs)}\n")
        for p in char_procs[:200]:
            lines.append(f"  Kk.{p}\n")
        # Also Wk()/useTRPC style path strings
        paths = sorted(set(re.findall(r'["\']([a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_.]*)["\']', text)))
        paths = [p for p in paths if any(k in p.lower() for k in ("char", "card", "draft", "studio", "world"))]
        lines.append(f"string procedure-like: {len(paths)}\n")
        for p in paths[:200]:
            lines.append(f"  {p}\n")
        for n in needles:
            ctxs = contexts(text, n, pad=220, limit=8)
            if not ctxs:
                continue
            lines.append(f"\n-- needle {n} ({len(ctxs)}) --\n")
            for c in ctxs:
                lines.append(c + "\n\n")

    out = OUT / "trpc_character_extract.txt"
    out.write_text("".join(lines), encoding="utf-8")
    print(f"wrote {out} chars={out.stat().st_size}")

    # Probe discovered procedures
    print("\nTop char_procs across files:")
    all_procs = set()
    for name in focus:
        fp = JS_DIR / name
        if not fp.exists():
            continue
        text = fp.read_text(encoding="utf-8", errors="replace")
        for p in re.findall(r"\bKk\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,3})\b", text):
            if any(k in p.lower() for k in ("char", "card", "draft", "studio", "world", "persona")):
                all_procs.add(p)
    for p in sorted(all_procs):
        print(" ", p)


if __name__ == "__main__":
    main()
