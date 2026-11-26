#!/usr/bin/env python3
"""Resolves merge conflicts where both sides only ADDED lines at the same place, by keeping both (this branch's first).

Usage: keep-both.py <file> [<file> ...]

It is for the files two items nearly always both add to: new keys at the end of the four dictionaries in
apps/desktop/src/i18n, an import or a page in a Settings list, and rows of a decisions table. Since item 128 decisions are
one file per item (docs/decisions/README.md), so a decisions table conflicts only when two items share a file. It refuses
a file where keeping both would be wrong or cannot be told:

- a decisions table (docs/decisions.md, or any .md under docs/decisions/): every conflicting line must be a table row.
- a dictionary (i18n/*.ts): every conflicting line must be a key, a comment or blank, and no key may end up twice.
- any other file: only with --any, after you have read the conflict yourself. Two functions added at one place share the
  closing brace after the marker, and a sentence both sides extended needs joining by hand: this script does neither.
"""
import re
import sys
from pathlib import Path

PAT = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
args = [a for a in sys.argv[1:] if a != "--any"]
any_file = "--any" in sys.argv
if not args:
    sys.exit(__doc__)

for name in args:
    path = Path(name)
    text = path.read_text()
    blocks = PAT.findall(text)
    if not blocks:
        print(f"{name}: no conflict")
        continue
    lines = [line for ours, theirs in blocks for line in (ours + theirs).splitlines()]
    if name.endswith(".md") and "decisions" in name:
        bad = [line for line in lines if not line.startswith("| ")]
    elif "/i18n/" in name:
        bad = [line for line in lines if line.strip() and not re.match(r'\s*("[^"]+":|//|/\*|\*)', line)]
    elif any_file:
        bad = []
    else:
        sys.exit(f"{name}: not a file this script knows; read the conflict, then pass --any if keeping both is right")
    if bad:
        sys.exit(f"{name}: a conflict holds a line that is not a plain addition: {bad[0][:90]!r}")
    text = PAT.sub(lambda m: m.group(1) + m.group(2), text)
    if "<<<<<<<" in text or ">>>>>>>" in text:
        sys.exit(f"{name}: a conflict is left")
    if "/i18n/" in name:
        keys = re.findall(r'^  ("[^"]+"):', text, re.M)
        twice = sorted({k for k in keys if keys.count(k) > 1})
        if twice:
            sys.exit(f"{name}: a key is there twice after keeping both: {twice[:3]}")
    path.write_text(text)
    print(f"{name}: kept both sides of {len(blocks)} conflict(s)")
