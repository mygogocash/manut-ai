// Find in a chat (item 150): the colours of a match, measured from find.css and the tokens themselves. A match must never make
// the text under it unreadable, in either theme, on any band a message is drawn on, for the text colours the chat uses
// (its ink and its muted grey, which step rows and times are drawn in).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../../sessions/term/find-colors";
import { parseCss } from "../../theme/cssRules";

const CSS = readFileSync(join(__dirname, "find.css"), "utf8");
const TOKENS = readFileSync(join(__dirname, "../../theme/tokens.css"), "utf8");
const rules = parseCss(CSS).rules;
const decl = (selector: string, prop: string) => rules.find((r) => r.selector === selector)?.decls.find((d) => d.prop === prop)?.value ?? "";

/** A token's value in the block of `selector`. */
function token(selector: string, name: string): string {
  const at = TOKENS.indexOf(`${selector} {`);
  const m = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(TOKENS.slice(at, TOKENS.indexOf("\n}", at)));
  if (!m) throw new Error(`${selector} ${name}`);
  return m[1]!;
}
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `top` laid over `under` at opacity `a`. */
const over = (top: string, under: string, a: number) => hex(rgb(under).map((u, i) => u * (1 - a) + rgb(top)[i]! * a));
/** `top` at opacity `a` laid over `under` with a blend mode: what the box layer does to a pixel of the page. */
const blend = (mode: string, top: string, under: string, a: number) =>
  hex(
    rgb(under).map((u, i) => {
      const t = rgb(top)[i]!;
      const mixed = mode === "screen" ? u + t - (u * t) / 255 : mode === "multiply" ? (u * t) / 255 : t;
      return u + a * (mixed - u);
    }),
  );
const tint = (value: string) => {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(value);
  if (!m) throw new Error(value);
  return { hex: hex([Number(m[1]), Number(m[2]), Number(m[3])]), alpha: Number(m[4]) };
};

const THEMES = [
  { name: "dark", sel: ":root" },
  { name: "light", sel: '[data-theme="light"]' },
] as const;
/** The bands a message is drawn on: the page, the person's bubble, the bot's, and a card (not a hovered row: --hov). */
const BANDS = ["--main", "--aui-surface", "--soft", "--aui-subtle"];
const TEXTS = ["--aui-ink", "--aui-muted"];

describe("the amber", () => {
  const amber = token(":root", "--aui-amber");

  it("is the design kit's, in the tints as well as in var(): the numbers in find.css are tokens.css's amber", () => {
    expect(tint(decl("::highlight(chat-find)", "background-color")).hex).toBe(amber);
    expect(tint(decl(".cf-box", "background")).hex).toBe(amber);
    expect(decl("::highlight(chat-find-current)", "background-color")).toBe("var(--aui-amber)");
  });

  for (const { name, sel } of THEMES) {
    it(`keeps the chat's ink and muted grey at 4.5 to 1 or better under a match painted behind the text, on every band (${name})`, () => {
      const t = tint(decl("::highlight(chat-find)", "background-color"));
      for (const band of BANDS) {
        const fill = over(t.hex, token(sel, band), t.alpha);
        for (const text of TEXTS) expect(contrastRatio(token(sel, text), fill), `${band} ${text}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps them at 4.5 to 1 under a box laid over the text, which the layer blends the way ${name === "dark" ? "screen" : "multiply"} does (${name})`, () => {
      const t = tint(decl(".cf-box", "background"));
      const mode = name === "dark" ? decl(".cf-layer", "mix-blend-mode") : decl('[data-theme="light"] .cf-layer', "mix-blend-mode");
      expect(mode).toBe(name === "dark" ? "screen" : "multiply");
      for (const band of BANDS) {
        const bg = token(sel, band);
        for (const text of TEXTS) expect(contrastRatio(blend(mode, t.hex, token(sel, text), t.alpha), blend(mode, t.hex, bg, t.alpha)), `${band} ${text}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`draws the current match's ring in a colour that stands out from every band at 3 to 1 (${name})`, () => {
      expect(decl(".cf-box.cf-cur", "outline")).toBe("2px solid var(--aui-warning)");
      for (const band of BANDS) expect(contrastRatio(token(sel, "--aui-warning"), token(sel, band)), band).toBeGreaterThanOrEqual(3);
    });
  }

  it("puts near-black text on the current match's solid amber at 7 to 1 or better, the terminal's own bar (find-colors.ts)", () => {
    expect(contrastRatio(decl("::highlight(chat-find-current)", "color"), amber)).toBeGreaterThanOrEqual(7);
  });

  it("is drawn only by the properties a highlight takes, and the box layer takes no click", () => {
    expect(rules.filter((r) => r.selector.startsWith("::highlight")).flatMap((r) => r.decls.map((d) => d.prop)).sort()).toEqual(["background-color", "background-color", "color"]);
    expect(decl(".cf-layer", "pointer-events")).toBe("none");
  });
});
