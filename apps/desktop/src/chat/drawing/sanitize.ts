// Reading a drawing (point 5 of the safety model in drawingDoc.ts): the web view's own HTML parser, in an inert DOMParser
// document where nothing loads and nothing runs, then the allow-list, element by element and attribute by attribute,
// then the same again on the result. A drawing whose second reading would differ from its first is never shown: a
// parser that reads markup one way the first time and another the second is exactly how filtered markup comes back to
// life, and the app does not try to guess which reading the frame would make (fail closed).
import { innerDoc, escapeAttr, keepAttr, keepElement, svgRatio, tooBig, type DrawingParts, type Ns } from "./drawingDoc";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** What the card can show: the drawing rebuilt, or why not. `removed` names what the filter took out (for the tests). */
export type Prepared =
  | { ok: true; parts: DrawingParts; removed: string[] }
  | { ok: false; why: "too_big" | "unsafe" | "empty" };

const nsOf = (el: Element): Ns => (el.namespaceURI === HTML_NS ? "html" : el.namespaceURI === SVG_NS ? "svg" : "other");

/** Code that would have run elsewhere: a script, a handler, a `javascript:` address. Here it never does, and the card
 *  says a part drawn by code is missing. */
const scripty = (name: string, value: string) => /^on/i.test(name) || /^\s*javascript:/i.test(value);

interface Pass {
  parts: Omit<DrawingParts, "hadScripts">;
  removed: string[];
  scripts: boolean;
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
  return { parts: { styles, bodyClass, bodyStyle, body: markup, svgRoot, ratio }, removed, scripts };
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
  const parts: DrawingParts = { ...first.parts, hadScripts: first.scripts };
  try {
    innerDoc(parts);
  } catch {
    return { ok: false, why: "unsafe" };
  }
  if (!parts.body.trim() && parts.styles.length === 0) return { ok: false, why: "empty" };
  return { ok: true, parts, removed: first.removed };
}
