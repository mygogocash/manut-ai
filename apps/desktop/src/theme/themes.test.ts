// The theme model (item 99b): the brand's values are tokens.css's own, a theme is whole from a background and text, its text
// keeps the board's 4.5 to 1 on every background or it is refused with where, a changed main colour takes what depends on
// it along, the stylesheet holds only listed tokens with `#rrggbb` values and outranks tokens.css and contrast.css, and under
// Increase contrast a theme's own colours are raised to contrast.css's promises.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, ratioText } from "./colour";
import { parseCss } from "./cssRules";
import { BANDS, BRAND, cleanTheme, copyOf, editKind, fullColors, isThemeId, kindsOf, raised, shortfall, THEME_TOKENS, themeCss, withColour, type UserTheme } from "./themes";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");
const CONTRAST = readFileSync(join(__dirname, "contrast.css"), "utf8");

/** The declarations of tokens.css's first rule for `selector`, outside any at-rule. */
function block(css: string, selector: string): Record<string, string> {
  const rule = parseCss(css).rules.find((r) => r.selector === selector && !r.at.length);
  return Object.fromEntries((rule?.decls ?? []).map((d) => [d.prop, d.value.toLowerCase()]));
}

const night: UserTheme = { id: "mine-night01", name: "Night", from: "own", dark: { "--main": "#101820", "--aui-ink": "#e8edf2" } };

describe("the brand's look", () => {
  it("is tokens.css's own values, in both kinds, so a copy of it is the brand exactly", () => {
    const dark = block(TOKENS, ":root");
    const light = block(TOKENS, '[data-theme="light"]');
    for (const tk of THEME_TOKENS) {
      expect(BRAND.dark[tk], `dark ${tk}`).toBe(dark[tk]);
      expect(BRAND.light[tk], `light ${tk}`).toBe(light[tk]);
    }
  });

  it("keeps its text and second-line text at 4.5 to 1 on all seven backgrounds", () => {
    expect(shortfall(BRAND.dark)).toBeNull();
    expect(shortfall(BRAND.light)).toBeNull();
    expect(BANDS).toHaveLength(7);
  });

  it("is drawn by no stylesheet: themeCss is empty for it", () => {
    expect(themeCss(null)).toBe("");
  });
});

describe("a theme", () => {
  it("is whole from a background and text: the rest is worked out, its second-line text at 4.5 to 1 or better", () => {
    const full = fullColors("dark", night.dark!);
    for (const tk of THEME_TOKENS) expect(full[tk], tk).toMatch(/^#[0-9a-f]{6}$/);
    expect(full["--main"]).toBe("#101820");
    expect(full["--aui-primary"]).toBe("#e8edf2");
    // a card, a menu and a hovered row are steps up from a dark background, the side menu a step down
    expect(contrast(full["--hov"], "#000000")).toBeGreaterThan(contrast(full["--main"], "#000000"));
    expect(contrast(full["--side"], "#000000")).toBeLessThan(contrast(full["--main"], "#000000"));
    expect(shortfall(full)).toBeNull();
    for (const band of BANDS) expect(contrast(full["--aui-muted"], full[band]), band).toBeGreaterThanOrEqual(4.5);
  });

  it("works a light one out the light way: a card is whiter than the page, a row darker", () => {
    const full = fullColors("light", { "--main": "#f4efe6", "--aui-ink": "#201c18" });
    expect(contrast(full["--aui-surface"], "#000000")).toBeGreaterThan(contrast(full["--main"], "#000000"));
    expect(contrast(full["--hov"], "#000000")).toBeLessThan(contrast(full["--main"], "#000000"));
    expect(shortfall(full)).toBeNull();
  });

  it("says where its text misses the rule: which text, the background, the ratio", () => {
    const grey = fullColors("dark", { "--main": "#202020", "--aui-ink": "#e0e0e0", "--aui-muted": "#707070" });
    const miss = shortfall(grey)!;
    expect(miss.what).toBe("muted");
    expect(miss.ratio).toBeLessThan(4.5);
    expect(BANDS).toContain(miss.band);
    // body text before second-line text
    expect(shortfall(fullColors("dark", { "--main": "#202020", "--aui-ink": "#555555", "--aui-muted": "#707070" }))!.what).toBe("text");
    // the ratio is never rounded up past the line it missed
    expect(ratioText(4.46)).toBe("4.4");
  });

  it("refuses a change that would put text under the rule, and keeps one that does not", () => {
    const mine = copyOf(null, "mine-mine0001", "Mine");
    const bad = withColour(mine, "dark", "text", "#3a3a3a");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.why).toMatchObject({ what: "text" });
    const dim = withColour(mine, "dark", "muted", "#4a4a48");
    expect(dim.ok).toBe(false);
    if (!dim.ok) expect(dim.why.what).toBe("muted");
    const good = withColour(mine, "dark", "accent", "#ffb86c");
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.theme.dark!["--aui-info"]).toBe("#ffb86c");
      // the focus ring follows the accent; light is untouched
      expect(fullColors("dark", good.theme.dark!)["--aui-focus"]).toBe("#ffb86c");
      expect(good.theme.light).toEqual(BRAND.light);
    }
  });

  it("takes what depends on a main colour along when it changes: a new background brings new cards and rows", () => {
    const mine = copyOf(null, "mine-mine0002", "Mine");
    const r = withColour(mine, "dark", "background", "#0d2233");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const full = fullColors("dark", r.theme.dark!);
    expect(full["--main"]).toBe("#0d2233");
    expect(full["--aui-surface"]).not.toBe(BRAND.dark["--aui-surface"]);
    expect(full["--hov"]).not.toBe(BRAND.dark["--hov"]);
    // the side menu is a main colour of its own and stays
    expect(full["--side"]).toBe(BRAND.dark["--side"]);
  });

  it("is copied whole, the brand's in both kinds or another theme with its terminal colours", () => {
    const brand = copyOf(null, "mine-copy0001", "Copy");
    expect(kindsOf(brand)).toEqual(["dark", "light"]);
    expect(brand.dark).toEqual(BRAND.dark);
    const term = copyOf({ ...night, term: { background: "#000000" } }, "mine-copy0002", "Night copy");
    expect(term).toEqual({ id: "mine-copy0002", name: "Night copy", from: "own", dark: night.dark, term: { background: "#000000" } });
    expect(term.dark).not.toBe(night.dark);
  });

  it("is changed in the kind in force when it has it, else in the one it has", () => {
    expect(editKind(BRAND_COPY, "light")).toBe("light");
    expect(editKind(night, "light")).toBe("dark");
  });
});
const BRAND_COPY = copyOf(null, "mine-brandcp1", "B");

describe("the stylesheet", () => {
  const css = themeCss(copyOf(night, "mine-night02", "N"));
  const sheet = parseCss(css);

  it("sets only the listed tokens, each to a #rrggbb, under the kinds the theme has", () => {
    expect(sheet.rules.length).toBeGreaterThan(0);
    for (const r of sheet.rules) {
      expect(r.selector).toBe(':root[data-theme="dark"]');
      for (const d of r.decls) {
        expect(THEME_TOKENS as readonly string[]).toContain(d.prop);
        expect(d.value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(css).not.toContain("light");
  });

  it("outranks tokens.css and contrast.css whatever order they load in: two parts of specificity to their one", () => {
    // tokens.css and contrast.css name the kinds with one part (`:root`, `[data-theme="light"]`)
    for (const sel of [...parseCss(TOKENS).rules, ...parseCss(CONTRAST).rules].map((r) => r.selector).filter((s) => /^(:root|\[data-theme="light"\])$/.test(s))) {
      expect(sel.split(/(?=\[)|(?=:)/).filter(Boolean)).toHaveLength(1);
    }
    for (const r of sheet.rules) expect(r.selector.split(/(?=\[)|(?=:)/).filter(Boolean)).toHaveLength(2);
  });

  it("raises its own second-line text, lines and focus ring under Increase contrast, to contrast.css's promises", () => {
    const more = sheet.rules.find((r) => r.at.includes("@media (prefers-contrast: more)"))!;
    expect(more.decls.map((d) => d.prop).sort()).toEqual(["--aui-border", "--aui-border-strong", "--aui-focus", "--aui-muted", "--aui-placeholder"]);
    for (const t of [copyOf(night, "mine-night03", "N"), BRAND_COPY]) {
      for (const kind of kindsOf(t)) {
        const full = fullColors(kind, t[kind]!);
        const up = raised(full);
        for (const band of BANDS) {
          expect(contrast(up["--aui-muted"]!, full[band]), `${kind} muted on ${band}`).toBeGreaterThanOrEqual(7);
          expect(contrast(up["--aui-border"]!, full[band]), `${kind} hairline on ${band}`).toBeGreaterThanOrEqual(3);
        }
        expect(contrast(up["--aui-focus"]!, full["--main"])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("a theme read back from storage", () => {
  it("keeps a good one as it is", () => {
    expect(cleanTheme(night)).toEqual(night);
  });

  it("refuses one that is not a theme: a bad id, no name, no background, text under the rule", () => {
    expect(cleanTheme({ ...night, id: "ocean" })).toBeNull();
    expect(cleanTheme({ ...night, id: "mine-../../x" })).toBeNull();
    expect(cleanTheme({ ...night, name: "  " })).toBeNull();
    expect(cleanTheme({ ...night, dark: { "--aui-ink": "#ffffff" } })).toBeNull();
    expect(cleanTheme({ ...night, dark: { "--main": "#101820", "--aui-ink": "#202830" } })).toBeNull();
    for (const junk of [null, 7, "x", [], { id: "mine-abcd" }]) expect(cleanTheme(junk)).toBeNull();
  });

  it("keeps only colours: an unknown token, a name, rgb(), a url or a rule break is dropped", () => {
    const t = cleanTheme({
      ...night,
      dark: { ...night.dark, "--aui-info": "red", "--side": "url(x)", "--hov": "#123; } body {", "--aui-focus": "rgb(1,2,3)", "--evil": "#ffffff", "--aui-border": "#ABCDEF" },
      term: { red: "#ff0000", blue: "blue", nope: "#000000" },
    })!;
    expect(t.dark).toEqual({ ...night.dark, "--aui-border": "#abcdef" });
    expect(t.term).toEqual({ red: "#ff0000" });
  });

  it("cleans a name: no control or direction characters, at most 60 characters", () => {
    expect(cleanTheme({ ...night, name: "  A‮B\u0007C  " })!.name).toBe("ABC");
    expect(cleanTheme({ ...night, name: "x".repeat(90) })!.name).toHaveLength(60);
  });

  it("knows a theme id from anything else", () => {
    expect(isThemeId("mine-ab12cd34")).toBe(true);
    for (const v of ["manut", "mine-", "mine-AB12", "ocean", 3, null, "mine-ab12cd34; x"]) expect(isThemeId(v), String(v)).toBe(false);
  });
});
