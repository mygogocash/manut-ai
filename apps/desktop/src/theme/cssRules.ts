// A small reader of the app's stylesheets for the tests that hold them to the design system (motion.test.ts,
// motionRule.test.ts): rules with their at-rule context and declarations, and keyframes with their bodies. It reads
// plain CSS as this repository writes it (no nesting, no strings holding braces), which is all those tests need; a
// stylesheet it cannot read makes them fail loudly rather than pass quietly.

export interface CssRule {
  /** The at-rules around the rule, outermost first, e.g. `@media (prefers-reduced-motion: reduce)`. */
  at: string[];
  selector: string;
  decls: { prop: string; value: string }[];
}

export interface CssKeyframes {
  name: string;
  at: string[];
  body: string;
}

export interface CssSheet {
  rules: CssRule[];
  keyframes: CssKeyframes[];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The index of the brace that closes the one at `open`. */
function closing(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`unclosed brace at ${open}`);
}

function declarations(body: string): CssRule["decls"] {
  const out: CssRule["decls"] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const d = body.slice(start, end);
    const colon = d.indexOf(":");
    if (colon > 0) out.push({ prop: squash(d.slice(0, colon)).toLowerCase(), value: squash(d.slice(colon + 1)) });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

function walk(src: string, at: string[], out: CssSheet) {
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === ";") start = i + 1; // an @import or @charset line
    if (c !== "{") continue;
    const prelude = squash(src.slice(start, i));
    const end = closing(src, i);
    const body = src.slice(i + 1, end);
    const kf = /^@(?:-webkit-)?keyframes\s+(\S+)$/.exec(prelude);
    if (kf) out.keyframes.push({ name: kf[1], at, body: squash(body) });
    else if (prelude.startsWith("@")) walk(body, [...at, prelude], out);
    else out.rules.push({ at, selector: prelude, decls: declarations(body) });
    i = end;
    start = end + 1;
  }
}

/** Read a stylesheet's text. Comments are dropped first. */
export function parseCss(css: string): CssSheet {
  const out: CssSheet = { rules: [], keyframes: [] };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), [], out);
  return out;
}

/** Split a value at its top-level commas (a transition list, an animation list). */
export function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}
