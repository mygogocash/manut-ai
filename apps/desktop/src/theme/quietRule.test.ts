// One grey for second-line text (docs/design-audit.md, finding 11; the Contrast board, BrandContrast.dc.html): text that
// is second in line is `--muted`. `--quiet` is the placeholder's grey (`--aui-placeholder`), which on a grey band, the side
// menu or a hovered row measures 4.0 to 4.3 to 1, under the 4.5 the board asks of text. So it stays for a field's
// placeholder and for a disabled control, which the board lets fall under 4.5 because nothing is to be read or done there,
// and nowhere else. This walks every stylesheet under src and fails on a text colour of either name in any other rule.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss } from "./cssRules";

const SRC = join(__dirname, "..");
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".css"))
  .map((f) => f.split("\\").join("/"))
  .sort();

/** The properties that colour text. */
const TEXT = new Set(["color", "-webkit-text-fill-color"]);
/** The placeholder's grey under either of its names. */
const PLACEHOLDER_GREY = /var\(--(quiet|aui-placeholder)\b/;
/** A placeholder, or a control that is turned off: the two places the placeholder's grey belongs. */
const ALLOWED = /::?placeholder|:placeholder-shown|:disabled|\[disabled\]|\[aria-disabled(="true")?\]|\.disabled\b/;

/** The argued exceptions: a folder whose rules are left as they are for now, and why. */
const PENDING: Record<string, string> = {
  "chat/":
    "item 85f rewrites the chat's type in these stylesheets on the same night (26 Nov 2026), so they are not touched here; " +
    "the lead removes this entry after merging 85f, and this test then names each rule left to change",
};

/** Every rule that colours text with the placeholder's grey, outside a placeholder or a disabled control. */
function offenders(): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f === "theme/tokens.css" || Object.keys(PENDING).some((p) => f.startsWith(p))) continue;
    for (const r of parseCss(readFileSync(join(SRC, f), "utf8")).rules) {
      if (ALLOWED.test(r.selector)) continue;
      for (const d of r.decls) if (TEXT.has(d.prop) && PLACEHOLDER_GREY.test(d.value)) out.push(`${f}: ${r.selector} { ${d.prop}: ${d.value} }`);
    }
  }
  return out;
}

describe("one grey for second-line text", () => {
  it("reads the stylesheets it holds to the rule", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("pages/pages.css");
  });

  it("colours no text with the placeholder's grey outside a placeholder or a disabled control", () => {
    expect(offenders()).toEqual([]);
  });

  it("would catch one: a rule of each kind, read as the walk reads them", () => {
    const sample = parseCss(`.a { color: var(--quiet); } .b::placeholder { color: var(--quiet); } .c:disabled { color: var(--aui-placeholder); } .d { color: var(--aui-placeholder, #999); }`);
    const caught = sample.rules.filter((r) => !ALLOWED.test(r.selector) && r.decls.some((d) => TEXT.has(d.prop) && PLACEHOLDER_GREY.test(d.value)));
    expect(caught.map((r) => r.selector)).toEqual([".a", ".d"]);
  });

  it("keeps each pending exception a folder that still exists, with its reason", () => {
    for (const [prefix, why] of Object.entries(PENDING)) {
      expect(files.some((f) => f.startsWith(prefix)), prefix).toBe(true);
      expect(why.length).toBeGreaterThan(40);
    }
  });
});
