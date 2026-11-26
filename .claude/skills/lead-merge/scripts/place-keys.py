#!/usr/bin/env python3
"""Puts dictionary lines into the area file each key belongs to (apps/desktop/src/i18n/README.md).

Usage: place-keys.py <i18n dir> <lang> [<file>]      (reads the lines from <file>, or from stdin)

Each line is a key line (  "lane.title": "Lanes",), a comment line (  // ...) or blank; a comment goes with the key
after it. A key goes to <lang>/<prefix>.ts, where <prefix> is the key up to its first dot. A key already in that file has
its line replaced; a new one is added at the end of the file's object. A file that does not exist yet is made, and its
import and spread are added to <lang>.ts in name order, so the type check sees it at once.

It is how item 128 split the four one-file dictionaries, and how the lead carries the keys of a branch made before
that split into the area files:

  for l in en ja ko zh; do
    git diff <merge base> <item branch> -- apps/desktop/src/i18n/$l.ts | sed -n 's/^+\\( *[/"]\\)/\\1/p' |
      .claude/skills/lead-merge/scripts/place-keys.py apps/desktop/src/i18n $l
  done

A key the branch removed is not removed here: read the diff's own - lines for that.
"""
import re
import sys
from pathlib import Path

KEY = re.compile(r'^\s*"([^"]+)":(.*)$')
COMMENT = re.compile(r"^\s*//")
IMPORT = re.compile(r'^import \{ (\S+) \} from "\./([a-z]+)/([^"]+)";$')
SPREAD = re.compile(r"^  \.\.\.(\S+),$")
RESERVED = set(
    "break case catch class const continue debugger default delete do else enum export extends false finally for "
    "function if import in instanceof new null return super switch this throw true try typeof var void while with "
    "yield let static implements interface package private protected public await".split()
)


def ident(area: str) -> str:
    """The name an area's object is exported as: the prefix itself when it is a plain name, else a safe one."""
    name = re.sub(r"[^A-Za-z0-9_$]+(.)?", lambda m: (m.group(1) or "").upper(), area)
    if not re.match(r"[A-Za-z_$]", name):
        name = "_" + name
    return name + "Keys" if name in RESERVED else name


def new_area(lang: str, area: str) -> list[str]:
    """A new area file's lines. English is the source; the others are typed against it, so a key missing from either
    side of an area, or one too many, fails the type check in that area's own file."""
    name = ident(area)
    if lang == "en":
        return [f"export const {name} = {{", "};"]
    return [f'import type {{ {name} as en }} from "../en/{area}";', "", f"export const {name}: Record<keyof typeof en, string> = {{", "};"]


def add_to_assembly(path: Path, lang: str, area: str) -> None:
    """Adds `import { area } from "./lang/area";` and `  ...area,` to <lang>.ts, each in name order."""
    lines = path.read_text().split("\n")
    name = ident(area)
    imp = f'import {{ {name} }} from "./{lang}/{area}";'
    spread = f"  ...{name},"
    if imp in lines:
        return
    imports = [i for i, l in enumerate(lines) if (m := IMPORT.match(l)) and m.group(2) == lang]
    at = next((i for i in imports if IMPORT.match(lines[i]).group(3) > area), None)
    if at is None:
        at = imports[-1] + 1 if imports else max(i for i, l in enumerate(lines) if l.startswith("import ") or l.startswith("//")) + 1
    lines.insert(at, imp)
    start = next(i for i, l in enumerate(lines) if l.startswith("export const ") and l.endswith("{"))
    end = next(i for i in range(start, len(lines)) if lines[i] == "};")
    spreads = [i for i in range(start + 1, end) if SPREAD.match(lines[i])]
    at = next((i for i in spreads if SPREAD.match(lines[i]).group(1) > name), end)
    lines.insert(at, spread)
    path.write_text("\n".join(lines))


def main() -> None:
    args = sys.argv[1:]
    if len(args) not in (2, 3):
        sys.exit(__doc__)
    root, lang = Path(args[0]), args[1]
    source = Path(args[2]).read_text() if len(args) == 3 else sys.stdin.read()
    assembly = root / f"{lang}.ts"
    if not assembly.exists():
        sys.exit(f"{assembly}: no such dictionary")
    files: dict[str, list[str]] = {}
    made: list[str] = []
    pending: list[str] = []
    raw = source.split("\n")
    placed = replaced = 0
    i = 0
    while i < len(raw):
        line = raw[i].rstrip()
        i += 1
        if not line.strip():
            if not pending or pending[-1] != "":
                pending.append("")
            continue
        if COMMENT.match(line):
            pending.append("  " + line.strip())
            continue
        m = KEY.match(line)
        if not m:
            print(f"skipped, not a key or a comment: {line.strip()[:90]!r}", file=sys.stderr)
            continue
        key, rest = m.group(1), m.group(2).strip()
        if not rest:  # a value wrapped onto the next line
            while i < len(raw) and not raw[i].strip():
                i += 1
            rest = raw[i].strip() if i < len(raw) else ""
            i += 1
            if not rest or KEY.match(rest) or rest[0] not in "\"'`":
                sys.exit(f"{key}: no value after it")
        text = f'  "{key}": {rest}'
        area = key.split(".")[0]
        path = root / lang / f"{area}.ts"
        if area not in files:
            if path.exists():
                files[area] = path.read_text().rstrip("\n").split("\n")
            else:
                files[area] = new_area(lang, area)
                made.append(area)
        body = files[area]
        end = len(body) - 1 - body[::-1].index("};")
        found = next((j for j in range(end) if (k := KEY.match(body[j])) and k.group(1) == key), None)
        comments = [c for c in pending if c != ""]
        if found is not None:
            body[found] = text
            replaced += 1
        else:
            first = next(j for j, l in enumerate(body) if l.startswith("export const ")) + 1
            add = pending if end > first else comments
            if add and add[0] == "" and body[end - 1] == "":
                add = add[1:]
            body[end:end] = add + [text]
            placed += 1
        pending = []
    if any(c for c in pending):
        print(f"skipped {len([c for c in pending if c])} comment line(s) with no key after them", file=sys.stderr)
    (root / lang).mkdir(exist_ok=True)
    for area, body in files.items():
        (root / lang / f"{area}.ts").write_text("\n".join(body) + "\n")
    for area in made:
        add_to_assembly(assembly, lang, area)
    print(f"{lang}: {placed} key(s) added, {replaced} replaced, {len(made)} new area file(s)")


main()
