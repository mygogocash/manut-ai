// A VS Code colour theme as a Manut AI theme (item 99b). The person picks the theme's JSON file in Settings › General ›
// Appearance; this reads its `colors` and nothing else. Nothing in the file is run, fetched or followed: an `include` of
// another file, `tokenColors` and `semanticTokenColors` are left alone, and a value is taken only when it is a colour
// written as `#rgb`, `#rrggbb` or `#rrggbbaa`. VS Code writes these files as JSON with comments and trailing commas, so
// both are allowed. A file over `VSCODE_MAX_BYTES` is refused before it is read.
//
// The map, first key present wins (docs/decisions/99b-themes.md keeps the same table):
//
// | Manut AI token         | What it paints                         | VS Code keys                                                      | When none is there                    |
// | ---------------------- | -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
// | `--main`               | the page behind the chat (`--bg`)      | editor.background, sideBar.background, panel.background           | refused: no background                |
// | `--side`               | the side menu                          | sideBar.background, activityBar.background                        | the background, a step darker         |
// | `--aui-ink`            | text (`--ink`, `--body`)               | editor.foreground, foreground                                     | the brand's text of the theme's kind  |
// | `--aui-muted`          | second-line text (`--muted`)           | descriptionForeground                                             | text toward the background, at 4.5:1  |
// | `--aui-placeholder`    | a field's placeholder (`--quiet`)      | input.placeholderForeground                                       | second-line text, a little fainter    |
// | `--aui-border`         | lines (`--line`)                       | panel.border, editorGroup.border, sideBar.border, contrastBorder  | a step from the background            |
// | `--aui-border-strong`  | a field's edge (`--line-strong`)       | input.border, dropdown.border, checkbox.border                    | between lines and second-line text    |
// | `--aui-surface`        | a card, a field (`--raise`)            | editorWidget.background, dropdown.background                      | a step from the background            |
// | `--aui-overlay`        | a menu, a popover (`--pop`)            | menu.background, quickInput.background, editorWidget.background   | a step from the background            |
// | `--hov`                | a hovered or chosen row (`--hover`)    | list.hoverBackground                                              | a step from the background            |
// | `--soft`, `--aui-subtle` | your bubble, a grey band             | (none: VS Code has no such grounds)                               | steps from the background             |
// | `--aui-info`           | the accent: links (`--accent`)         | textLink.foreground, focusBorder, button.background               | the brand's of the theme's kind       |
// | `--aui-focus`          | the focus ring (`--focus`)             | focusBorder                                                       | the accent                            |
// | `--aui-primary`        | the send button, your solid bubble     | button.background                                                 | text                                  |
// | `--aui-on-primary`     | what is written on it                  | button.foreground                                                 | the background, or black or white     |
//
// Sensible fallbacks: a see-through colour is laid over the background it sits on; a line the eye cannot tell from the
// background (under 1.1 to 1) and a field edge under 1.5 to 1 are worked out instead; an accent under 3 to 1 on the
// background gives way to the next key; a button whose words read under 4.5 to 1 on it gives way to text on the
// background. The terminal takes `terminal.background`, `terminal.foreground`, `terminalCursor.*`,
// `terminal.selectionBackground` and the sixteen `terminal.ansi*` colours when the file has any of them.
//
// Then the theme meets the text rule like any other (themes.ts `shortfall`): body and second-line text at 4.5 to 1 on
// every background, or it is refused with the ratio and the background.
import { contrast, HEX_COLOUR, isLight, over, parseHex, toHex } from "./colour";
import { cleanName, fullColors, shortfall, type Kind, type Shortfall, type TermColors, type ThemeColors, type ThemeToken } from "./themes";

/** 1 MiB. A VS Code theme with every key and its token colours is tens of kilobytes; anything near this is not one. */
export const VSCODE_MAX_BYTES = 1024 * 1024;

export const VSCODE_MAP: readonly { token: ThemeToken; keys: readonly string[] }[] = [
  { token: "--side", keys: ["sideBar.background", "activityBar.background"] },
  { token: "--aui-ink", keys: ["editor.foreground", "foreground"] },
  { token: "--aui-muted", keys: ["descriptionForeground"] },
  { token: "--aui-placeholder", keys: ["input.placeholderForeground"] },
  { token: "--aui-border", keys: ["panel.border", "editorGroup.border", "sideBar.border", "contrastBorder"] },
  { token: "--aui-border-strong", keys: ["input.border", "dropdown.border", "checkbox.border"] },
  { token: "--aui-surface", keys: ["editorWidget.background", "dropdown.background"] },
  { token: "--aui-overlay", keys: ["menu.background", "quickInput.background", "editorWidget.background"] },
  { token: "--hov", keys: ["list.hoverBackground"] },
  { token: "--aui-info", keys: ["textLink.foreground", "focusBorder", "button.background"] },
  { token: "--aui-focus", keys: ["focusBorder"] },
  { token: "--aui-primary", keys: ["button.background"] },
  { token: "--aui-on-primary", keys: ["button.foreground"] },
];
export const VSCODE_BACKGROUND = ["editor.background", "sideBar.background", "panel.background"] as const;

/** The terminal's slots and the keys VS Code keeps them under. */
export const VSCODE_TERM_MAP: readonly { slot: keyof TermColors; keys: readonly string[] }[] = [
  { slot: "foreground", keys: ["terminal.foreground"] },
  { slot: "cursor", keys: ["terminalCursor.foreground"] },
  { slot: "cursorAccent", keys: ["terminalCursor.background"] },
  { slot: "selectionBackground", keys: ["terminal.selectionBackground"] },
  ...(
    [
      ["black", "Black"],
      ["red", "Red"],
      ["green", "Green"],
      ["yellow", "Yellow"],
      ["blue", "Blue"],
      ["magenta", "Magenta"],
      ["cyan", "Cyan"],
      ["white", "White"],
    ] as const
  ).flatMap(([slot, name]) => [
    { slot, keys: [`terminal.ansi${name}`] },
    { slot: `bright${name}` as keyof TermColors, keys: [`terminal.ansiBright${name}`] },
  ]),
];

export type ImportRefusal = { kind: "big" } | { kind: "parse" } | { kind: "noColors" } | { kind: "noBackground" } | { kind: "contrast"; why: Shortfall };

export interface Imported {
  name: string;
  kind: Kind;
  colors: ThemeColors;
  term?: TermColors;
  /** How many of the theme's colours came from the file (the rest were worked out). */
  read: number;
}

/** JSON with comments, as VS Code writes it, as plain JSON: `//` and `/* *\/` comments and trailing commas go, strings are
 *  kept exactly. Throws on a comment that never closes. */
export function stripJsonc(text: string): string {
  const src = text.replace(/^﻿/, "");
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new Error("a comment that never closes");
      out += " ";
      i = end + 2;
    } else if (c === ",") {
      // a trailing comma: only space stands between it and the brace or bracket that closes
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] !== "}" && src[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const fileStem = (fileName: string) => fileName.replace(/^.*[\\/]/, "").replace(/\.(jsonc?|json5)$/i, "");

/** Read a VS Code theme file's text. `fileName` names a theme whose file has no `name`. */
export function importVsCode(text: string, fileName: string): { ok: true; theme: Imported } | { ok: false; why: ImportRefusal } {
  if (text.length > VSCODE_MAX_BYTES) return { ok: false, why: { kind: "big" } };
  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(text));
  } catch {
    return { ok: false, why: { kind: "parse" } };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, why: { kind: "parse" } };
  const r = root as Record<string, unknown>;
  const raw = r.colors && typeof r.colors === "object" && !Array.isArray(r.colors) ? (r.colors as Record<string, unknown>) : {};
  // the colours only, each as written; any other value (a name, rgb(), a number) is not read
  const colours = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && HEX_COLOUR.test(v.trim())) colours.set(k, v.trim());
  if (!colours.size) return { ok: false, why: { kind: "noColors" } };

  const type = typeof r.type === "string" ? r.type.toLowerCase() : "";
  const bgRaw = VSCODE_BACKGROUND.map((k) => colours.get(k)).find(Boolean);
  if (!bgRaw) return { ok: false, why: { kind: "noBackground" } };
  // the theme's own word for its kind, else what its background is (its colour without any see-through part)
  const named: Kind | null = type === "light" || type === "hclight" ? "light" : type === "dark" || type === "hc" || type === "hcdark" ? "dark" : null;
  const kind: Kind = named ?? (isLight(toHex(parseHex(bgRaw)!)) ? "light" : "dark");
  const bg = over(bgRaw, kind === "light" ? "#ffffff" : "#000000")!;

  const colors: ThemeColors = { "--main": bg };
  for (const { token, keys } of VSCODE_MAP) {
    for (const key of keys) {
      const v = colours.has(key) ? over(colours.get(key), bg) : null;
      if (!v) continue;
      // an accent the eye can hardly find on the page gives way to the next key
      if (token === "--aui-info" && contrast(v, bg) < 3) continue;
      colors[token] = v;
      break;
    }
  }
  // a line nobody can see, or a field edge too faint to find, is worked out instead
  if (colors["--aui-border"] && contrast(colors["--aui-border"], bg) < 1.1) delete colors["--aui-border"];
  if (colors["--aui-border-strong"] && contrast(colors["--aui-border-strong"], bg) < 1.5) delete colors["--aui-border-strong"];
  // a button whose words cannot be read on it is drawn as the brand draws it: text on the background
  const full = fullColors(kind, colors);
  if (contrast(full["--aui-primary"], full["--aui-on-primary"]) < 4.5) {
    delete colors["--aui-primary"];
    delete colors["--aui-on-primary"];
  }

  const why = shortfall(fullColors(kind, colors));
  if (why) return { ok: false, why: { kind: "contrast", why } };

  let term: TermColors | undefined;
  let termRead = 0;
  if ([...colours.keys()].some((k) => k.startsWith("terminal.") || k.startsWith("terminalCursor."))) {
    termRead = colours.has("terminal.background") ? 1 : 0;
    const tbg = over(colours.get("terminal.background") ?? colours.get("panel.background"), bg) ?? bg;
    term = { background: tbg };
    for (const { slot, keys } of VSCODE_TERM_MAP) {
      const key = keys.find((k) => colours.has(k));
      const v = key ? over(colours.get(key), tbg) : null;
      if (!v) continue;
      term[slot] = v;
      termRead++;
    }
    term.foreground ??= fullColors(kind, colors)["--aui-ink"];
  }

  const name = cleanName(r.name) || cleanName(fileStem(fileName)) || "VS Code";
  const read = Object.keys(colors).length + termRead;
  return { ok: true, theme: { name, kind, colors, ...(term ? { term } : {}), read } };
}
