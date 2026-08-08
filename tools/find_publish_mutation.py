#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pathlib import Path
import re

js = Path(__file__).resolve().parents[1] / ".probe-character-api" / "js"
text = (js / "D4_csDye.js").read_text(encoding="utf-8", errors="replace")
print("HEAD IMPORTS:")
print(text[:1200])
print("\nALL from ./ imports:")
for m in re.finditer(r'from"\./([^"]+)"', text):
    print(" ", m.group(1))

# Find definition/import of qe Ke Je ct lt ut
for name in ("qe", "Ke", "Je", "ct", "lt", "ut", "mt"):
    print(f"\n=== {name} ===")
    for m in re.finditer(rf"(?:^|[^\w]){name}\b", text):
        s = max(0, m.start() - 60)
        e = min(len(text), m.end() + 100)
        print(text[s:e].replace("\n", " ")[:200])
        break

# Scan ALL small js for studio.* procedures
print("\n=== studio.* across all js ===")
procs = set()
for fp in js.glob("*.js"):
    t = fp.read_text(encoding="utf-8", errors="replace")
    for p in re.findall(r"studio\.([a-zA-Z][a-zA-Z0-9_]*)", t):
        procs.add(f"studio.{p}")
    for p in re.findall(r'["\']studio\.([a-zA-Z][a-zA-Z0-9_.]*)["\']', t):
        procs.add(f"studio.{p}")
for p in sorted(procs):
    print(p)
