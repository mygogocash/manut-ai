// The app's token file must say what the design system says. tokens.css carries the values of
// packages/ui-kit/tokens.json under the kit's own names (its "layer 1"); this reads both and fails on any drift, so a
// token is changed in the kit first and here second, never here alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "tokens.css"), "utf8");
const FONTS = readFileSync(join(__dirname, "fonts.css"), "utf8");
const KIT = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "ui-kit", "tokens.json"), "utf8")) as {
  version: string;
  color: { name: string; var: string; light: string; dark: string }[];
  fixedColor: { name: string; var?: string; value: string }[];
  shadow: { var: string; light: string; dark: string };
  radius: { name: string; var: string; value: number }[];
  font: { name: string; var: string; value: string }[];
};

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): Record<string, string> {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("\n}", at));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  return out;
}

/** Spelling that does not change a value: case, quote marks, a leading zero, spaces after commas. */
const same = (v: string) => v.toLowerCase().replace(/["']/g, "").replace(/\b0\./g, ".").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();

const dark = block(":root");
const light = block('[data-theme="light"]');

describe("tokens.css against packages/ui-kit/tokens.json", () => {
  it("is written for the kit's current version", () => {
    expect(KIT.version).toBe("0.2");
    expect(CSS).toContain("tokens.json (version 0.2)");
  });

  it("carries every colour for dark (the default) and for light", () => {
    for (const c of KIT.color) {
      expect(same(dark[c.var] ?? ""), `${c.name} dark`).toBe(same(c.dark));
      expect(same(light[c.var] ?? ""), `${c.name} light`).toBe(same(c.light));
    }
  });

  it("carries the colours that are the same in both themes once, in the default block", () => {
    for (const c of KIT.fixedColor) {
      if (!c.var) continue; // team colours and the brand mark have no variable: they are used where they are drawn
      expect(same(dark[c.var] ?? ""), c.name).toBe(same(c.value));
      expect(light[c.var], c.name).toBeUndefined();
    }
  });

  it("carries the one shadow, the radii and the font stacks", () => {
    expect(same(dark[KIT.shadow.var])).toBe(same(KIT.shadow.dark));
    expect(same(light[KIT.shadow.var])).toBe(same(KIT.shadow.light));
    for (const r of KIT.radius) expect(dark[r.var], r.name).toBe(`${r.value}px`);
    for (const f of KIT.font) expect(same(dark[f.var]), f.name).toBe(same(f.value));
  });

  it("points the names the screens use at design tokens, never at a colour of their own", () => {
    const mapped = ["--bg", "--raise", "--raise2", "--line", "--line-strong", "--hover", "--pop", "--ink", "--body", "--muted", "--quiet", "--ok", "--danger", "--link", "--focus", "--bub-me", "--on-accent", "--r", "--r-sm", "--r-bubble", "--mono", "--pop-shadow"];
    for (const name of mapped) expect(dark[name], name).toMatch(/^var\(--/);
    // nothing in the light block restates a screen name with a literal colour: light comes from the tokens alone
    for (const [name, value] of Object.entries(light)) {
      if (KIT.color.some((c) => c.var === name) || name === KIT.shadow.var || name === "--src-slack") continue;
      expect(value, name).toMatch(/^var\(--/);
    }
  });

  it("starts the interface stack with the bundled families and keeps the CJK ones before the generic name", () => {
    const stack = dark["--font"].split(",").map((s) => s.trim().replace(/"/g, ""));
    expect(stack.slice(0, 2)).toEqual(["Geist", "IBM Plex Sans Thai"]);
    expect(stack[stack.length - 1]).toBe("sans-serif");
    for (const cjk of ["PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo"]) expect(stack, cjk).toContain(cjk);
    // each family the tokens name first is a font file in the bundle, not a hope that the computer has it
    for (const family of ["Geist", "Geist Mono", "IBM Plex Sans Thai"]) expect(FONTS, family).toContain(`font-family: "${family}";`);
    expect(FONTS).not.toMatch(/https?:/);
  });
});
