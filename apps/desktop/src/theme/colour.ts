// The colour arithmetic the themes need (item 99b): reading the three ways a theme file writes a colour, mixing two,
// laying a see-through colour over the one under it, and the contrast between two, by the WCAG 2 formula the design
// board's contrast rule is written in (4.5 to 1 for text). Pure and small, so the theme model, the VS Code import and
// their tests share one reading. `sessions/term/themes.ts` keeps its own copy of the luminance for the terminal, which
// loads lazily; this one is on the app's first page and should not pull the terminal's 36 palettes in with it.

/** A colour as red, green and blue from 0 to 255, and how opaque it is from 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The only spellings a theme may use: `#rgb`, `#rrggbb` and `#rrggbbaa`. Anything else (a name, `rgb()`, `var()`, a
 *  url) is not a colour here, so nothing but a colour can reach a stylesheet. */
export const HEX_COLOUR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** What a theme keeps: opaque, six digits, lower case. */
export const OPAQUE_HEX = /^#[0-9a-f]{6}$/;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as channels; null for anything else. */
export function parseHex(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const m = HEX_COLOUR.exec(value.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const byte = (v: number) => Math.round(Math.min(255, Math.max(0, v)))
  .toString(16)
  .padStart(2, "0");

/** Channels as `#rrggbb` (opacity dropped: lay the colour over its ground first). */
export const toHex = (c: Pick<Rgba, "r" | "g" | "b">): string => `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;

/** A colour laid over `ground`, as the eye sees it: an opaque colour is itself, a see-through one is mixed with what is
 *  under it by its opacity. `ground` must be opaque. Null when either is not a colour. */
export function over(value: unknown, ground: string): string | null {
  const c = parseHex(value);
  const g = parseHex(ground);
  if (!c || !g) return null;
  return toHex({ r: c.r * c.a + g.r * (1 - c.a), g: c.g * c.a + g.g * (1 - c.a), b: c.b * c.a + g.b * (1 - c.a) });
}

/** `a` moved toward `b` by `t` (0 is `a`, 1 is `b`), both opaque. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a)!;
  const y = parseHex(b)!;
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = parseHex(hex)!;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** The contrast ratio of two opaque colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A ratio as the refusals say it: one decimal, never rounded up past the line it missed (4.46 reads 4.4, not 4.5). */
export const ratioText = (r: number): string => (Math.floor(r * 10) / 10).toFixed(1);

/** A light ground is one black text reads on at least as well as white text does. */
export const isLight = (hex: string): boolean => contrast(hex, "#000000") >= contrast(hex, "#ffffff");
