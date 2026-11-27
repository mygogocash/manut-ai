// A VS Code theme file as a Manut AI theme (item 99b), read from a theme written as VS Code writes them (comments, trailing
// commas, see-through colours, a terminal palette, token colours, an include and values that are not colours): the map,
// what is worked out, the terminal's colours, and every refusal with its reason. Nothing but `#rgb`, `#rrggbb` and
// `#rrggbbaa` under "colors" is read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, over } from "./colour";
import { BANDS, fullColors, shortfall, themeCss, type ThemeToken } from "./themes";
import { importVsCode, stripJsonc, VSCODE_MAP, VSCODE_MAX_BYTES } from "./vscode";

const HARBOR = readFileSync(join(__dirname, "__fixtures__", "harbor-night-color-theme.json"), "utf8");

function imported(text: string, file = "theme.json") {
  const r = importVsCode(text, file);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.why)}`);
  return r.theme;
}
const refusal = (text: string) => {
  const r = importVsCode(text, "x.json");
  return r.ok ? null : r.why;
};

describe("JSON with comments", () => {
  it("drops line and block comments and trailing commas, and keeps strings exactly", () => {
    expect(JSON.parse(stripJsonc('{ // a\n "a": "x // not a comment", /* b */ "b": [1, 2,], "c": "/* kept */", "d": "q\\"//",\n}'))).toEqual({
      a: "x // not a comment",
      b: [1, 2],
      c: "/* kept */",
      d: 'q"//',
    });
    expect(JSON.parse(stripJsonc('﻿{"a": "a,}"}'))).toEqual({ a: "a,}" });
    expect(() => stripJsonc('{"a": 1 /* never closed')).toThrow();
  });
});

describe("Harbor Night, a theme as VS Code writes them", () => {
  const th = imported(HARBOR, "harbor-night-color-theme.json");

  it("takes its name and kind from the file", () => {
    expect(th.name).toBe("Harbor Night");
    expect(th.kind).toBe("dark");
  });

  it("maps each key by the table, the first key present winning", () => {
    const c = th.colors;
    expect(c["--main"]).toBe("#1b2330");
    expect(c["--side"]).toBe("#161d28");
    // editor.foreground comes before foreground: answers are read on the editor's background
    expect(c["--aui-ink"]).toBe("#d8dee9");
    expect(c["--aui-placeholder"]).toBe("#7a8494");
    expect(c["--aui-border"]).toBe("#2c3647");
    expect(c["--aui-border-strong"]).toBe("#5a6578");
    expect(c["--aui-surface"]).toBe("#212a38");
    expect(c["--aui-overlay"]).toBe("#1f2836");
    expect(c["--aui-info"]).toBe("#7fb4ff");
    expect(c["--aui-focus"]).toBe("#5e9cff");
    expect(c["--aui-primary"]).toBe("#3d6fd6");
    expect(c["--aui-on-primary"]).toBe("#ffffff");
    // the bubble and the grey band have no VS Code key: worked out
    expect(c["--soft"]).toBeUndefined();
    expect(c["--aui-subtle"]).toBeUndefined();
  });

  it("lays a see-through colour over the background it sits on", () => {
    expect(th.colors["--aui-muted"]).toBe(over("#d8dee9b3", "#1b2330"));
    expect(th.colors["--hov"]).toBe(over("#ffffff14", "#1b2330"));
    expect(th.colors["--hov"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps the text rule on every background", () => {
    const full = fullColors("dark", th.colors);
    expect(shortfall(full)).toBeNull();
    for (const band of BANDS) expect(contrast(full["--aui-ink"], full[band]), band).toBeGreaterThanOrEqual(4.5);
  });

  it("gives the terminal its terminal.* colours, the selection laid over the terminal's background", () => {
    expect(th.term).toMatchObject({
      background: "#141a24",
      foreground: "#d8dee9",
      cursor: "#f0c674",
      selectionBackground: over("#3d6fd666", "#141a24"),
      black: "#1b2330",
      red: "#e06c75",
      brightBlue: "#7cc4ff",
      brightWhite: "#ffffff",
    });
    expect(Object.keys(th.term!)).toHaveLength(20);
  });

  it("counts what came from the file: 14 of the page's 16 colours and the terminal's 20", () => {
    expect(Object.keys(th.colors)).toHaveLength(14);
    expect(th.read).toBe(14 + 20);
  });

  it("reads nothing that is not a colour: rgb(), a url, a name and a value with a rule break in it put nothing on the page", () => {
    const css = themeCss({ id: "mine-harbor01", name: th.name, from: "vscode", dark: th.colors });
    for (const bad of ["rgba", "url(", "example.invalid", "red", "display", "body", "}  }"]) expect(css, bad).not.toContain(bad);
    for (const v of Object.values(th.colors)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("fallbacks", () => {
  const theme = (colors: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "T", ...extra, colors });

  it("is whole from editor.background alone, its kind read from the background when the file names none", () => {
    const light = imported(theme({ "editor.background": "#fdf6e3" }));
    expect(light.kind).toBe("light");
    expect(light.colors).toEqual({ "--main": "#fdf6e3" });
    expect(shortfall(fullColors("light", light.colors))).toBeNull();
    expect(imported(theme({ "sideBar.background": "#202020" })).colors["--main"]).toBe("#202020");
  });

  it("works out a line the eye cannot see and a field edge too faint to find", () => {
    const t = imported(theme({ "editor.background": "#1e1e1e", "panel.border": "#1f1f1f", "input.border": "#2a2a2a" }));
    expect(t.colors["--aui-border"]).toBeUndefined();
    expect(t.colors["--aui-border-strong"]).toBeUndefined();
  });

  it("lets an accent that cannot be found on the page give way to the next key", () => {
    const t = imported(theme({ "editor.background": "#1e1e1e", "textLink.foreground": "#202a40", focusBorder: "#4f9dff" }));
    expect(t.colors["--aui-info"]).toBe("#4f9dff");
  });

  it("draws a button whose words cannot be read on it as text on the background", () => {
    const t = imported(theme({ "editor.background": "#1e1e1e", "editor.foreground": "#dddddd", "button.background": "#777777", "button.foreground": "#888888" }));
    expect(t.colors["--aui-primary"]).toBeUndefined();
    expect(t.colors["--aui-on-primary"]).toBeUndefined();
    const full = fullColors("dark", t.colors);
    expect(contrast(full["--aui-primary"], full["--aui-on-primary"])).toBeGreaterThanOrEqual(4.5);
  });

  it("has no terminal colours when the file has no terminal keys", () => {
    expect(imported(theme({ "editor.background": "#1e1e1e" })).term).toBeUndefined();
  });

  it("names a theme without a name after its file", () => {
    expect(imported(JSON.stringify({ colors: { "editor.background": "#1e1e1e" } }), "/Users/x/themes/Deep Sea-color-theme.json").name).toBe("Deep Sea-color-theme");
  });

  it("documents a key for every token it reads", () => {
    const tokens = new Set<ThemeToken>(VSCODE_MAP.map((m) => m.token));
    for (const tk of ["--side", "--aui-ink", "--aui-muted", "--aui-border", "--aui-info", "--aui-focus", "--aui-primary"] as const) expect(tokens.has(tk), tk).toBe(true);
  });
});

describe("refusals, each with its reason", () => {
  it("refuses a file over the size cap before reading it", () => {
    expect(refusal(" ".repeat(VSCODE_MAX_BYTES + 1))).toEqual({ kind: "big" });
  });

  it("refuses what is not JSON with comments, or not an object", () => {
    for (const text of ["", "not json", "{ \"colors\": ", "[1,2]", "null", "\"x\"", '{"a": 1 /* open'])
      expect(refusal(text), text).toEqual({ kind: "parse" });
  });

  it("refuses a file with no colours, or with none it can read", () => {
    expect(refusal("{}")).toEqual({ kind: "noColors" });
    expect(refusal('{"tokenColors": []}')).toEqual({ kind: "noColors" });
    expect(refusal('{"colors": {"editor.background": "rgb(0,0,0)", "foreground": "white"}}')).toEqual({ kind: "noColors" });
  });

  it("refuses a theme with colours but no background", () => {
    expect(refusal('{"colors": {"editor.foreground": "#ffffff"}}')).toEqual({ kind: "noBackground" });
  });

  it("refuses body text under 4.5 to 1, saying on which background and how far", () => {
    const why = refusal('{"colors": {"editor.background": "#1e1e1e", "editor.foreground": "#5a5a5a"}}');
    expect(why).toMatchObject({ kind: "contrast", why: { what: "text", band: expect.any(String) } });
    if (why?.kind === "contrast") expect(why.why.ratio).toBeLessThan(4.5);
  });

  it("refuses second-line text under 4.5 to 1 that the file states, rather than quietly changing it", () => {
    const why = refusal('{"colors": {"editor.background": "#1e1e1e", "editor.foreground": "#e0e0e0", "descriptionForeground": "#ffffff55"}}');
    expect(why).toMatchObject({ kind: "contrast", why: { what: "muted" } });
  });
});
