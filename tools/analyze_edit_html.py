#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pathlib import Path
import re

p = Path(__file__).resolve().parents[1] / ".probe-character-api" / "edit.html"
t = p.read_text(encoding="utf-8", errors="replace")
print("len", len(t))
print("head:\n", t[:2000])
print("\n--- title/meta ---")
for m in re.findall(r"<title[^>]*>.*?</title>", t, flags=re.I | re.S)[:3]:
    print(m[:200])
print("script tags", len(re.findall(r"<script", t, flags=re.I)))
srcs = re.findall(r"""src=["']([^"']+)["']""", t)
print("srcs", len(srcs))
for s in srcs[:40]:
    print(" ", s)
hrefs = re.findall(r"""href=["']([^"']+)["']""", t)
print("css/js hrefs sample:")
for h in hrefs[:40]:
    if any(x in h for x in (".js", ".css", "_next", "assets", "chunk")):
        print(" ", h)
apis = sorted(set(re.findall(r"/api/[a-zA-Z0-9_./-]+", t)))
print("inline /api mentions", len(apis))
for a in apis[:50]:
    print(" ", a)
# look for __NEXT_DATA__
m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', t, flags=re.S)
if m:
    print("FOUND __NEXT_DATA__ len", len(m.group(1)))
    Path(p.parent / "next_data.json").write_text(m.group(1), encoding="utf-8")
else:
    print("no __NEXT_DATA__")
# trpc paths in page
for pat in ("trpc", "character", "createCharacter", "studio/edit", "graphql"):
    print(pat, t.lower().count(pat.lower()))
