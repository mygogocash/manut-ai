// More contrast when the system asks for it (contrast.css, item 136), measured from the file itself: under Increase contrast,
// second-line text reads at 7 to 1 or better and a hairline at 3 to 1 on every band of either theme, and the light focus ring
// at 4.5 to 1; under Windows high contrast, every status dot, spinner and badge keeps its colour.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "contrast.css"), "utf8");
const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** A token's value in the first block after `after` whose selector is `selector`. */
function token(text: string, selector: string, name: string, after = 0): string {
  const at = text.indexOf(`${selector} {`, after);
  const body = text.slice(at, text.indexOf("}", at));
  const m = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(body);
  if (!m) throw new Error(`${selector} ${name}`);
  return m[1]!;
}

const more = CSS.indexOf("@media (prefers-contrast: more)");
const BANDS = ["--main", "--side", "--aui-surface", "--hov"];

describe("Increase contrast", () => {
  for (const [theme, sel] of [
    ["dark", ":root"],
    ["light", '[data-theme="light"]'],
  ] as const) {
    it(`reads second-line text at 7 to 1 and a hairline at 3 to 1 on every band (${theme})`, () => {
      const muted = token(CSS, sel, "--aui-muted", more);
      const border = token(CSS, sel, "--aui-border", more);
      for (const band of BANDS) {
        const bg = token(TOKENS, sel, band);
        expect(ratio(muted, bg), `${theme} muted on ${band}`).toBeGreaterThanOrEqual(7);
        expect(ratio(border, bg), `${theme} hairline on ${band}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("draws the light focus ring at 4.5 to 1 or better, and wider", () => {
    expect(ratio(token(CSS, '[data-theme="light"]', "--aui-focus", more), token(TOKENS, '[data-theme="light"]', "--main"))).toBeGreaterThanOrEqual(4.5);
    expect(CSS.slice(more)).toMatch(/:focus-visible\s*{\s*outline-width:\s*3px/);
  });
});

describe("Windows high contrast", () => {
  it("keeps the colour of every status dot, spinner and badge, which is what each says", () => {
    const forced = CSS.slice(CSS.indexOf("@media (forced-colors: active)"));
    for (const cls of [".st-dot", ".needs-dot", ".ui-spin", ".badge"]) expect(forced, cls).toContain(cls);
    expect(forced).toContain("forced-color-adjust: none");
    expect(forced).toContain("outline: 2px solid Highlight");
  });
});
