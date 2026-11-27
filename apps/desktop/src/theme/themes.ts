// Themes for the whole app (item 99b; the owner, 27 Nov 2026): the person's own themes and themes imported from VS
// Code, beside the brand's look, which stays the default and stays exactly the design kit's values in tokens.css.
//
// A theme is a set of values for the colour tokens of tokens.css's first layer (`--main`, `--side`, `--aui-ink`,
// `--aui-muted`, `--aui-border`…), for dark, for light, or for both. The screens read the second layer (`--bg`, `--body`,
// `--muted`, `--line`, `--accent`, `--focus`…), and every name there is a `var()` of the first, so setting the first
// moves every screen, the screens that read the first layer directly included, with no screen's CSS changed. It is how
// contrast.css raises contrast (item 136), and a theme is applied the same way: a stylesheet after tokens.css that
// changes only token values (`themeCss`, put on the page by apply.ts).
//
// The rules a theme keeps:
// - Body text and second-line text read at 4.5 to 1 or better on every background the theme has (`BANDS`): the board's
//   rule for text. A theme that misses it is refused with the ratio and the background it missed (`shortfall`), when
//   it is made, imported, edited, and when it is read back from storage.
// - Only `#rrggbb` values for the tokens listed here reach the stylesheet, so nothing in a theme can be anything but a
//   colour.
// - Under Increase contrast (macOS: Accessibility › Display) the theme's own second-line text, lines and focus ring are
//   raised to contrast.css's promises (7 to 1, 3 to 1, 4.5 to 1) from the theme's colours (`raised`), so a theme cannot
//   undo what the system asked for, and contrast.css's values, tuned for the brand's backgrounds, are not laid over a
//   theme they were never measured on.
import { contrast, isLight, mix, OPAQUE_HEX } from "./colour";
import { TERM_CUSTOM_KEYS, type TermCustomKey } from "../sessions/term/settings";

export type Kind = "dark" | "light";
export const KINDS: readonly Kind[] = ["dark", "light"];

/** The tokens a theme sets: the colour tokens of tokens.css's first layer that the screens are drawn with. The status
 *  colours (success, danger, warning and their grounds) and the team colours stay the kit's: they say what something is,
 *  and the kit has measured them on both of its grounds. */
export const THEME_TOKENS = [
  "--main",
  "--side",
  "--aui-surface",
  "--aui-overlay",
  "--soft",
  "--aui-subtle",
  "--hov",
  "--aui-border",
  "--aui-border-strong",
  "--aui-ink",
  "--aui-muted",
  "--aui-placeholder",
  "--aui-primary",
  "--aui-on-primary",
  "--aui-focus",
  "--aui-info",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColors = Partial<Record<ThemeToken, string>>;
export type FullColors = Record<ThemeToken, string>;
export type TermColors = Partial<Record<TermCustomKey, string>>;

/** A theme of the person's own is picked by an id of this shape (it is what `manut.look`'s `palette` holds then). */
export type ThemeId = `mine-${string}`;
export const THEME_ID = /^mine-[a-z0-9]{4,24}$/;
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && THEME_ID.test(v);
/** The brand's look, the built-in default. */
export const BRAND_ID = "manut";

export interface UserTheme {
  id: ThemeId;
  /** The person's name for it, shown as it is (never translated). */
  name: string;
  /** Made in Settings from another look, or imported from a VS Code theme file. */
  from: "own" | "vscode";
  /** Each kind the theme has; `--main` is always there. A token left out is worked out from the others (`fullColors`). */
  dark?: ThemeColors;
  light?: ThemeColors;
  /** The terminal's colours, from a VS Code theme's `terminal.*` keys: they stand in for manut's own terminal theme
   *  under the kinds this theme has (sessions/term/appColors.ts). */
  term?: TermColors;
}

/** The brand's values, tokens.css's own (themes.test.ts holds them to the file): what "make your own" copies from the
 *  brand, and what a token a theme cannot say falls back to. */
export const BRAND: Record<Kind, FullColors> = {
  dark: {
    "--main": "#171716",
    "--side": "#111110",
    "--aui-surface": "#1f1f1d",
    "--aui-overlay": "#262624",
    "--soft": "#252523",
    "--aui-subtle": "#222220",
    "--hov": "#2b2b28",
    "--aui-border": "#30302d",
    "--aui-border-strong": "#75746e",
    "--aui-ink": "#f3f2ee",
    "--aui-muted": "#a3a29c",
    "--aui-placeholder": "#8f8e88",
    "--aui-primary": "#f3f2ee",
    "--aui-on-primary": "#111110",
    "--aui-focus": "#8cc4ff",
    "--aui-info": "#8cc4ff",
  },
  light: {
    "--main": "#fbfaf7",
    "--side": "#f3f2ee",
    "--aui-surface": "#ffffff",
    "--aui-overlay": "#ffffff",
    "--soft": "#f4f3ef",
    "--aui-subtle": "#f1f0eb",
    "--hov": "#eceae4",
    "--aui-border": "#e7e5df",
    "--aui-border-strong": "#8a8881",
    "--aui-ink": "#111110",
    "--aui-muted": "#6a6964",
    "--aui-placeholder": "#737269",
    "--aui-primary": "#1a1a19",
    "--aui-on-primary": "#ffffff",
    "--aui-focus": "#2f7fe0",
    "--aui-info": "#1764c0",
  },
};

/** The six main colours a person edits, and the token each one is. */
export const ROLES = ["background", "side", "text", "muted", "accent", "line"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_TOKEN: Record<Role, ThemeToken> = {
  background: "--main",
  side: "--side",
  text: "--aui-ink",
  muted: "--aui-muted",
  accent: "--aui-info",
  line: "--aui-border",
};

/** What is worked out again from a main colour when the person changes it: a card, a menu, a bubble, a grey band and a
 *  hovered row are steps off the background; the placeholder and the strong edge sit between the lines and second-line
 *  text; the focus ring is the accent. Anything else a theme holds (an imported button colour) stays as it is. */
const DEPENDENTS: Partial<Record<ThemeToken, readonly ThemeToken[]>> = {
  "--main": ["--aui-surface", "--aui-overlay", "--soft", "--aui-subtle", "--hov"],
  "--aui-muted": ["--aui-placeholder", "--aui-border-strong"],
  "--aui-border": ["--aui-border-strong"],
  "--aui-info": ["--aui-focus"],
};

/** The grounds text is read on: the page, the side menu, a card or field, a menu, the person's own bubble, a grey band and
 *  a hovered or chosen row. The brand reads at 4.5 to 1 or better on each (themes.test.ts). */
export const BANDS = ["--main", "--side", "--aui-surface", "--aui-overlay", "--soft", "--aui-subtle", "--hov"] as const;
export type Band = (typeof BANDS)[number];
/** The board's rule for text. */
export const TEXT_MIN = 4.5;

/** The second-line text a theme that has none gets: text moved toward the background as far as it can go while it still
 *  reads at 4.5 to 1 on every band (the brand's sits about 38 percent of the way). */
function derivedMuted(ink: string, grounds: readonly string[]): string {
  for (let t = 0.38; t > 0; t -= 0.01) {
    const c = mix(ink, grounds[0]!, t);
    if (grounds.every((g) => contrast(c, g) >= TEXT_MIN)) return c;
  }
  return ink;
}

/** Every token of one kind of a theme: what it holds, and the rest worked out from it the way the kit's own values sit
 *  (each step measured on the brand's: a card is 4 percent of the way from the background to the text in dark, and so
 *  on). With only a background and text a theme is whole. */
export function fullColors(kind: Kind, c: ThemeColors): FullColors {
  const brand = BRAND[kind];
  const bg = c["--main"] ?? brand["--main"];
  const ink = c["--aui-ink"] ?? brand["--aui-ink"];
  const lightBg = isLight(bg);
  const step = (dark: number, light: number) => mix(bg, ink, lightBg ? light : dark);
  const side = c["--side"] ?? (lightBg ? mix(bg, ink, 0.035) : mix(bg, "#000000", 0.26));
  const surface = c["--aui-surface"] ?? (lightBg ? mix(bg, "#ffffff", 0.7) : step(0.04, 0));
  const overlay = c["--aui-overlay"] ?? (lightBg ? surface : step(0.07, 0));
  const soft = c["--soft"] ?? step(0.065, 0.03);
  const subtle = c["--aui-subtle"] ?? step(0.05, 0.042);
  const hov = c["--hov"] ?? step(0.09, 0.065);
  const line = c["--aui-border"] ?? step(0.11, 0.085);
  const muted = c["--aui-muted"] ?? derivedMuted(ink, [bg, side, surface, overlay, soft, subtle, hov]);
  const info = c["--aui-info"] ?? brand["--aui-info"];
  const primary = c["--aui-primary"] ?? ink;
  const onPrimary = c["--aui-on-primary"] ?? (contrast(primary, bg) >= TEXT_MIN ? bg : isLight(primary) ? "#000000" : "#ffffff");
  return {
    "--main": bg,
    "--side": side,
    "--aui-surface": surface,
    "--aui-overlay": overlay,
    "--soft": soft,
    "--aui-subtle": subtle,
    "--hov": hov,
    "--aui-border": line,
    "--aui-border-strong": c["--aui-border-strong"] ?? mix(line, muted, 0.65),
    "--aui-ink": ink,
    "--aui-muted": muted,
    "--aui-placeholder": c["--aui-placeholder"] ?? mix(muted, bg, 0.1),
    "--aui-primary": primary,
    "--aui-on-primary": onPrimary,
    "--aui-focus": c["--aui-focus"] ?? (c["--aui-info"] ? info : brand["--aui-focus"]),
    "--aui-info": info,
  };
}

/** Where a theme's text misses the rule: which text, on which band, at what ratio. */
export interface Shortfall {
  what: "text" | "muted";
  band: Band;
  ratio: number;
}

/** The first miss of the text rule, body text before second-line text, each at its lowest band; null when both read at
 *  4.5 to 1 or better everywhere. */
export function shortfall(full: FullColors): Shortfall | null {
  for (const what of ["text", "muted"] as const) {
    const fg = full[what === "text" ? "--aui-ink" : "--aui-muted"];
    let worst: Shortfall | null = null;
    for (const band of BANDS) {
      const ratio = contrast(fg, full[band]);
      if (ratio < TEXT_MIN && (!worst || ratio < worst.ratio)) worst = { what, band, ratio };
    }
    if (worst) return worst;
  }
  return null;
}

export const kindsOf = (t: Pick<UserTheme, "dark" | "light">): Kind[] => KINDS.filter((k) => !!t[k]);

/** The kind the editor changes: the one in force when the theme has it, else the one it has. */
export const editKind = (t: Pick<UserTheme, "dark" | "light">, mode: Kind): Kind => (t[mode] ? mode : (kindsOf(t)[0] ?? mode));

/** A theme with one main colour changed for one kind, what depends on it worked out again; refused, with where, when its
 *  text would then miss the rule. */
export function withColour(t: UserTheme, kind: Kind, role: Role, value: string): { ok: true; theme: UserTheme } | { ok: false; why: Shortfall } {
  const token = ROLE_TOKEN[role];
  const colors: ThemeColors = { ...t[kind], [token]: value.toLowerCase() };
  for (const d of DEPENDENTS[token] ?? []) delete colors[d];
  const why = shortfall(fullColors(kind, colors));
  if (why) return { ok: false, why };
  return { ok: true, theme: { ...t, [kind]: colors } };
}

/** A copy of a look to make one's own: the brand's (both kinds, every value the kit's) or another theme (all it holds,
 *  terminal colours included). */
export function copyOf(source: UserTheme | null, id: ThemeId, name: string): UserTheme {
  if (!source) return { id, name, from: "own", dark: { ...BRAND.dark }, light: { ...BRAND.light } };
  const out: UserTheme = { id, name, from: "own" };
  for (const k of kindsOf(source)) out[k] = { ...source[k] };
  if (source.term) out.term = { ...source.term };
  return out;
}

/** `colour` moved toward `toward` until it reads at `target` or better on every ground; the farthest point when even that
 *  does not (a "dark" theme whose rows are mid-grey cannot reach 7 to 1 with white). */
function raise(colour: string, toward: string, grounds: readonly string[], target: number): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(colour, toward, Math.min(1, t));
    if (grounds.every((g) => contrast(c, g) >= target)) return c;
  }
  return toward;
}

/** What Increase contrast changes in a theme: contrast.css's promises, kept from the theme's own colours. Second-line text
 *  at 7 to 1 on every band (the placeholder at 4.5), a hairline at 3 to 1, a strong edge at 4.5 to 1, and the focus ring at
 *  4.5 to 1 on the page. */
export function raised(full: FullColors): Partial<FullColors> {
  const grounds = BANDS.map((b) => full[b]);
  const far = isLight(full["--main"]) ? "#000000" : "#ffffff";
  return {
    "--aui-muted": raise(full["--aui-muted"], far, grounds, 7),
    "--aui-placeholder": raise(full["--aui-placeholder"], far, grounds, TEXT_MIN),
    "--aui-border": raise(full["--aui-border"], far, grounds, 3),
    "--aui-border-strong": raise(full["--aui-border-strong"], far, grounds, TEXT_MIN),
    "--aui-focus": raise(full["--aui-focus"], far, [full["--main"]], TEXT_MIN),
  };
}

/** One rule's declarations: only listed tokens, only `#rrggbb` values. */
const decls = (values: Partial<FullColors>): string =>
  THEME_TOKENS.filter((tk) => typeof values[tk] === "string" && OPAQUE_HEX.test(values[tk]!))
    .map((tk) => `  ${tk}: ${values[tk]};`)
    .join("\n");

/** The stylesheet that puts a theme on the page, after tokens.css and contrast.css. `:root[data-theme="dark"]` outranks
 *  tokens.css's `:root` and `[data-theme="light"]` and contrast.css's rules by specificity, so the order the sheets load in
 *  does not matter; a kind the theme does not have is left to the brand. Empty for the brand's look. */
export function themeCss(t: UserTheme | null): string {
  if (!t) return "";
  const out: string[] = [];
  for (const kind of kindsOf(t)) {
    const full = fullColors(kind, t[kind]!);
    const sel = `:root[data-theme="${kind}"]`;
    out.push(`${sel} {\n${decls(full)}\n}`);
    out.push(`@media (prefers-contrast: more) {\n${sel} {\n${decls(raised(full))}\n}\n}`);
  }
  return out.join("\n");
}

const NAME_MAX = 60;
/** A name as it is kept: no control or direction characters, trimmed, at most 60 characters. */
export const cleanName = (v: unknown): string =>
  typeof v === "string"
    ? v
        .replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, "")
        .trim()
        .slice(0, NAME_MAX)
        .trim()
    : "";

function cleanColors<K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  for (const k of keys) {
    const c = o[k];
    if (typeof c === "string" && OPAQUE_HEX.test(c.toLowerCase())) out[k] = c.toLowerCase();
  }
  return out;
}

/** A theme as it is kept, every field checked: an id of the right shape, a name, at least one kind with a background, only
 *  listed tokens with `#rrggbb` values, and text that keeps the rule. Anything else is null, so a theme changed by hand
 *  on disk can never put text under 4.5 to 1 or anything but a colour on the page. */
export function cleanTheme(v: unknown): UserTheme | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = cleanName(o.name);
  if (!isThemeId(o.id) || !name) return null;
  const out: UserTheme = { id: o.id, name, from: o.from === "vscode" ? "vscode" : "own" };
  for (const k of KINDS) {
    const colors = cleanColors(o[k], THEME_TOKENS);
    if (!colors["--main"]) continue;
    if (shortfall(fullColors(k, colors))) return null;
    out[k] = colors;
  }
  if (!kindsOf(out).length) return null;
  const term = cleanColors(o.term, TERM_CUSTOM_KEYS);
  if (Object.keys(term).length) out.term = term;
  return out;
}
