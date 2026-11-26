// Reading a drawing (point 5 of the safety model in drawingDoc.ts): the web view's own HTML parser, in an inert DOMParser
// document where nothing loads and nothing runs, then the allow-list, element by element and attribute by attribute,
// then the same again on the result. A drawing whose second reading would differ from its first is never shown: a
// parser that reads markup one way the first time and another the second is exactly how filtered markup comes back to
// life, and the app does not try to guess which reading the frame would make (fail closed).
//
// Then what the drawing would draw is counted, every reference followed (item 121): a drawing of under 2 KB whose groups
// of `<use>` named each other drew ten million rectangles and froze the app's page, which the size cap does not bound.
import { innerDoc, escapeAttr, keepAttr, keepElement, svgRatio, tooBig, type DrawingParts, type Ns } from "./drawingDoc";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** What the card can show: the drawing rebuilt, or why not. `removed` names what the filter took out (for the tests). */
export type Prepared =
  | { ok: true; parts: DrawingParts; removed: string[] }
  | { ok: false; why: "too_big" | "too_many" | "unsafe" | "empty" };

const nsOf = (el: Element): Ns => (el.namespaceURI === HTML_NS ? "html" : el.namespaceURI === SVG_NS ? "svg" : "other");

/** Code that would have run elsewhere: a script, a handler, a `javascript:` address. Here it never does, and the card
 *  says a part drawn by code is missing. */
const scripty = (name: string, value: string) => /^on/i.test(name) || /^\s*javascript:/i.test(value);

interface Pass {
  parts: Omit<DrawingParts, "hadScripts">;
  removed: string[];
  scripts: boolean;
  /** How many more shapes it would draw than it writes out (`drawnBy`), or null when that could not be read. */
  extra: number | null;
}

// ---- what a drawing would draw (item 121) ------------------------------------------------------------------------------

/** The most a drawing may draw beyond the elements it writes out, each `<use>`, marker, pattern, mask, clip, filter and
 *  SVG picture drawn where it is named, along every chain of them. Past it the card says the drawing is too large to draw.
 *  The written elements themselves are bounded by the size cap; what multiplies them is bounded here. */
export const DRAWN_MAX_EXTRA = 5_000;

/** Something the count cannot read: the drawing is not shown. */
class Unreadable extends Error {}

/** Elements that draw nothing where they stand: what names them draws their content. */
const UNDRAWN: ReadonlySet<string> = new Set(
  "defs symbol marker pattern clipPath mask linearGradient radialGradient filter title desc style stop animate animateTransform animateMotion set mpath metadata script head template".split(" "),
);
/** The shapes markers are drawn on, at their vertices. */
const MARKED: ReadonlySet<string> = new Set(["path", "line", "polyline", "polygon"]);
/** Paints that draw no shape of their own: a gradient, and the chain of gradients it inherits from. */
const PAINTS: ReadonlySet<string> = new Set(["linearGradient", "radialGradient"]);
/** Presentation attributes that may name another element of the drawing. */
const NAMING = ["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"];
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** CSS text with its escapes read, as the style engine reads it (`\23 ` is `#`). */
const cssUnescape = (s: string): string =>
  s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : (ch ?? ""),
  );

/** What each `url()` of a CSS value holds, its escapes read. An SVG picture named anywhere but in a `url()` this can read
 *  is not counted, so the drawing is not shown. */
function urls(value: string): string[] {
  const out: string[] = [];
  const rest = value.replace(/url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)"'\s]*))\s*\)/gi, (_m, a?: string, b?: string, c?: string) => {
    out.push(cssUnescape(a ?? b ?? c ?? "").trim());
    return "";
  });
  if (/data:\s*image\/svg/i.test(cssUnescape(rest))) throw new Unreadable();
  return out;
}

/** An element's `href`, or its older `xlink:href`. */
const href = (el: Element): string | null => el.getAttribute("href") ?? el.getAttribute("xlink:href");

/** A bound on a marked shape's vertices, so on the markers drawn along it: two, and every number and every close its
 *  geometry names, its animation's and its style's (`d: path(…)`) too. */
function vertices(el: Element, css: readonly [string, string][]): number {
  const texts = [el.getAttribute("d"), el.getAttribute("points"), ...css.filter(([p]) => p === "d").map(([, v]) => v)];
  for (const a of Array.from(el.children)) for (const k of ["values", "from", "to", "by"]) texts.push(a.getAttribute(k));
  let n = 2;
  for (const t of texts) if (t) n += (t.match(NUMBER)?.length ?? 0) + (t.match(/[zZ]/g)?.length ?? 0);
  return n;
}

/** What `doc` would draw from `root` down: every element in its flow once, and where an element names another (a `<use>`,
 *  a marker at each vertex, a pattern, mask, clip or filter, an SVG picture) that one's content again, along every chain.
 *  A reference back into a chain being drawn draws nothing, as the engines draw it. Style sheets are read by the engine's
 *  own CSS parser and given to the elements their selectors match (every element, for a selector with a state such as
 *  `:hover`, or one this cannot match). `depth` counts SVG pictures inside SVG pictures. Throws `Unreadable`. */
function drawnBy(doc: Document, root: Element, sheets: readonly string[], depth: number): number {
  if (depth > 3) throw new Unreadable();
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  const css = new Map<Element, [string, string][]>();
  const give = (els: readonly Element[], style: CSSStyleDeclaration) => {
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      const value = style.getPropertyValue(prop);
      if (prop !== "d" && !/url\(|data:/i.test(value)) continue;
      for (const el of els) {
        let got = css.get(el);
        if (!got) css.set(el, (got = []));
        got.push([prop, value]);
      }
    }
  };
  const matched = (selector: string): Element[] => {
    if (selector.includes(":")) return all;
    try {
      return all.filter((el) => el.matches(selector));
    } catch {
      return all;
    }
  };
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if ("style" in r && r.style instanceof CSSStyleDeclaration) give("selectorText" in r && typeof r.selectorText === "string" ? matched(r.selectorText) : all, r.style);
      if ("cssRules" in r && r.cssRules) walk(r.cssRules as CSSRuleList);
    }
  };
  for (const text of sheets) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(text);
    } catch {
      throw new Unreadable();
    }
    walk(sheet.cssRules);
  }
  for (const el of all) {
    const style = (el as Element & { style?: CSSStyleDeclaration }).style;
    if (style instanceof CSSStyleDeclaration) give([el], style);
  }

  const drawn = new Map<Element, number>();
  const inner = new Map<Element, number>();
  const busy = new Set<Element>();
  const named = (ref: string): Element | null => (/^#[^\s]+$/.test(ref) ? doc.getElementById(ref.slice(1)) : null);
  const picture = (src: string): number => {
    const m = /^\s*data:image\/svg\+xml([^,]*),([\s\S]*)$/i.exec(src);
    if (!m) return 0;
    let text: string;
    try {
      text = /;\s*base64\s*$/i.test(m[1]) ? atob(m[2].replace(/\s+/g, "")) : decodeURIComponent(m[2]);
    } catch {
      throw new Unreadable();
    }
    const svg = new DOMParser().parseFromString(text, "image/svg+xml");
    return drawnBy(svg, svg.documentElement, Array.from(svg.getElementsByTagName("style")).map((st) => st.textContent ?? ""), depth + 1);
  };
  // what `el` draws for the url()s of one of its properties
  const through = (el: Element, prop: string, value: string): number => {
    let w = 0;
    for (const u of urls(value)) {
      if (/^data:/i.test(u)) {
        w += picture(u);
        continue;
      }
      const t = named(u);
      if (!t || PAINTS.has(t.localName)) continue;
      if (t.localName !== "marker") w += content(t);
      else if (MARKED.has(el.localName) && prop.startsWith("marker")) w += (prop === "marker-mid" ? vertices(el, css.get(el) ?? []) : 1) * content(t);
    }
    return w;
  };
  // what an element draws where it is named: a symbol, marker, pattern, mask, clip or filter its content (a pattern with
  // none, the one it names); anything else itself
  const content = (t: Element): number => {
    if (!UNDRAWN.has(t.localName)) return weight(t);
    const known = inner.get(t);
    if (known !== undefined) return known;
    if (busy.has(t)) return 0;
    busy.add(t);
    let w = 0;
    for (const c of Array.from(t.children)) if (!UNDRAWN.has(c.localName)) w += weight(c);
    if (t.localName === "pattern" && t.children.length === 0) {
      const from = named(href(t) ?? "");
      if (from) w += content(from);
    }
    busy.delete(t);
    inner.set(t, w);
    return w;
  };
  // what an element draws where it stands, itself included
  const weight = (el: Element): number => {
    const known = drawn.get(el);
    if (known !== undefined) return known;
    if (busy.has(el)) return 0;
    busy.add(el);
    let w = 1;
    for (const c of Array.from(el.children)) if (!UNDRAWN.has(c.localName)) w += weight(c);
    if (el.localName === "use") {
      const t = named((href(el) ?? "").trim());
      if (t) w += content(t);
    }
    if (el.localName === "image") w += picture(href(el) ?? "");
    if (el.localName === "img") w += picture(el.getAttribute("src") ?? "");
    for (const p of NAMING) {
      const v = el.getAttribute(p);
      if (v) w += through(el, p, v);
    }
    for (const [p, v] of css.get(el) ?? []) w += through(el, p, v);
    busy.delete(el);
    drawn.set(el, w);
    return w;
  };
  return weight(root);
}

/** One reading: parse, keep what the list allows, and say what went. */
function read(source: string, reduceMotion: boolean): Pass {
  const removed: string[] = [];
  let scripts = false;
  // standards mode always, so the first reading and the second (which writes a doctype) parse alike
  const doc = new DOMParser().parseFromString(`<!doctype html>${source}`, "text/html");

  const clean = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        // comments, processing instructions: nothing a picture needs
        removed.push(node.nodeName);
        node.parentNode?.removeChild(node);
        continue;
      }
      const el = node as Element;
      const ns = nsOf(el);
      const name = el.localName;
      if (!keepElement(ns, name, (n) => el.getAttribute(n), { reduceMotion })) {
        if (name.toLowerCase() === "script") scripts = true;
        removed.push(`<${name}>`);
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        if (keepAttr(ns, name, a.name, a.value)) continue;
        if (scripty(a.name, a.value)) scripts = true;
        removed.push(`${name}@${a.name}`);
        el.removeAttributeNode(a);
      }
      clean(el);
    }
  };

  // the head gives only its style sheets; anything else there (a title, a meta, a link, a base, a script) goes
  const styles: string[] = [];
  for (const el of Array.from(doc.head?.children ?? [])) {
    if (nsOf(el) === "html" && el.localName === "style") styles.push(el.textContent ?? "");
    else {
      if (el.localName === "script") scripts = true;
      removed.push(`<${el.localName}>`);
    }
  }

  // a frameset document has no body to draw
  const body = doc.body && doc.body.localName === "body" ? doc.body : null;
  if (!body && doc.body) removed.push(`<${doc.body.localName}>`);
  let bodyClass: string | null = null;
  let bodyStyle: string | null = null;
  let markup = "";
  let svgRoot = false;
  let ratio: number | null = null;
  if (body) {
    for (const a of Array.from(body.attributes)) {
      if (a.name === "class") bodyClass = a.value;
      else if (a.name === "style") bodyStyle = a.value;
      else {
        if (scripty(a.name, a.value)) scripts = true;
        removed.push(`body@${a.name}`);
      }
    }
    clean(body);
    // one SVG and nothing else: it fills the box at its own shape, given a viewBox when it has only a width and height
    const kids = Array.from(body.children);
    const svg = kids.length === 1 && nsOf(kids[0]) === "svg" && kids[0].localName === "svg" ? kids[0] : null;
    if (svg && Array.from(body.childNodes).every((n) => n === svg || (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim()))) {
      svgRoot = true;
      const vb = svg.getAttribute("viewBox");
      ratio = svgRatio(vb, svg.getAttribute("width"), svg.getAttribute("height"));
      if (ratio !== null && svgRatio(vb, null, null) === null) {
        svg.setAttribute("viewBox", `0 0 ${parseFloat(svg.getAttribute("width")!)} ${parseFloat(svg.getAttribute("height")!)}`);
      }
    }
    markup = body.innerHTML;
  }
  // what it would draw beyond what it writes out, every reference followed (item 121)
  let extra: number | null = 0;
  if (body) {
    try {
      const sheets = [...styles, ...Array.from(body.getElementsByTagName("style")).map((st) => st.textContent ?? "")];
      extra = drawnBy(doc, body, sheets, 0) - body.getElementsByTagName("*").length - 1;
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      extra = null;
    }
  }
  return { parts: { styles, bodyClass, bodyStyle, body: markup, svgRoot, ratio }, removed, scripts, extra };
}

/** The markup a reading leaves, written back as a document, for the second reading. */
const writeBack = (p: Pass["parts"]) =>
  `<html><head>${p.styles.map((s) => `<style>${s}</style>`).join("")}</head><body` +
  (p.bodyClass !== null ? ` class="${escapeAttr(p.bodyClass)}"` : "") +
  (p.bodyStyle !== null ? ` style="${escapeAttr(p.bodyStyle)}"` : "") +
  `>${p.body}</body></html>`;

/** A drawing ready for its box, or why it is not shown. `reduceMotion` leaves SVG animation out (CSS animation is
 *  stopped by the document's own reduced-motion rule). */
export function prepareDrawing(source: string, o: { reduceMotion: boolean }): Prepared {
  if (tooBig(source)) return { ok: false, why: "too_big" };
  const first = read(source, o.reduceMotion);
  const second = read(writeBack(first.parts), o.reduceMotion);
  const same =
    second.removed.length === 0 &&
    second.parts.body === first.parts.body &&
    second.parts.bodyClass === first.parts.bodyClass &&
    second.parts.bodyStyle === first.parts.bodyStyle &&
    second.parts.styles.length === first.parts.styles.length &&
    second.parts.styles.every((s, i) => s === first.parts.styles[i]);
  if (!same) return { ok: false, why: "unsafe" };
  // one whose references would draw past what the box draws, or whose references could not be read, is not drawn
  if (first.extra === null) return { ok: false, why: "unsafe" };
  if (!(first.extra <= DRAWN_MAX_EXTRA)) return { ok: false, why: "too_many" };
  const parts: DrawingParts = { ...first.parts, hadScripts: first.scripts };
  try {
    innerDoc(parts);
  } catch {
    return { ok: false, why: "unsafe" };
  }
  if (!parts.body.trim() && parts.styles.length === 0) return { ok: false, why: "empty" };
  return { ok: true, parts, removed: first.removed };
}
