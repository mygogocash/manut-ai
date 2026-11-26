// A drawing in the chat (item 98; docs/security/chat-drawings.md): an agent's HTML or SVG, shown in the chat when the
// person presses Show drawing under its code block. The drawing is a model's markup, possibly steered by a web page or a
// file it read, so it is treated as hostile. THE SAFETY MODEL, which everything below and in Drawing.tsx keeps:
//
// 1. Nothing of a drawing runs. It sits in a box of two nested frames, each `<iframe sandbox="">` with no `allow-*`
//    token at all: no scripts, no same origin, no forms, pop-ups, top navigation, modals, downloads, pointer lock or
//    presentation. A drawing is its HTML, SVG and CSS, drawn still (CSS and SVG animation play; a script never does).
//    Scripts stay off because a script in a sandboxed frame of WebKit (the engine of the macOS web view) still opened
//    connections to a local listener under the CSP below, by WebRTC and by a preconnect link: no CSP directive and no
//    sandbox token closes those, so the safe answer is a picture without its code (`e2e/chat-drawing.ts`, "why").
// 2. Its origin is opaque. Both documents come from `srcdoc` in a sandbox without `allow-same-origin`, so they reach no
//    storage, cookie or IndexedDB of the app's, and Tauri's scripts (the bridge into the app) are put in the main frame
//    only on macOS (docs/code-editor.md, "The page in the pane"); with no script running, nothing could call them anyway.
// 3. No network. The first thing in each document is a `<meta http-equiv="Content-Security-Policy">` (DRAWING_CSP): no
//    script, frame, form, base or connection, and pictures and fonts only as `data:`. A `srcdoc` document also inherits
//    the app's own policy, and both apply.
// 4. It cannot navigate itself out. The app's own `frame-src` lets a frame load `http://localhost` at any port (a lane's
//    preview needs it), and a single sandboxed frame could still move itself there. So the drawing is the inner frame of
//    an outer box whose `frame-src 'none'` covers every navigation of the inner frame: an address set from markup, a
//    refresh, a link.
// 5. Only markup that names nothing outside is kept. The drawing is read with the web view's own parser (an inert
//    DOMParser document: nothing loads or runs) and rebuilt from an allow-list of elements and attributes (KEEP_HTML,
//    KEEP_SVG, keepAttr). Links keep their words and lose where they lead; a picture may only be a `data:image/`; an SVG
//    reference may only name `#id` inside the drawing; `<link>`, `<meta>`, `<base>`, scripts, event handlers, frames,
//    objects, media, forms, MathML and foreignObject go. WebKit connected out for a preconnect link and for a link that
//    opens a new window even in the script-free box, which is why the markup is filtered as well as fenced in. The
//    result is read and filtered a second time; if that would change anything, nothing is shown (fail closed).
// 6. Nothing flows back. No script runs, so the frame can send nothing; the app listens to no message from a drawing and
//    gives the frame nothing but its own document. Its height is read by the app from the drawing's own SVG size and
//    clamped (BOX_MIN to BOX_MAX); any other drawing gets BOX_DEFAULT and scrolls inside its box.
// 7. It cannot pass for the app. It is always inside a card the app draws ("Drawn by <name>" and a line saying it is a
//    closed box), and a frame cannot paint outside its box. Only a finished answer in a chat's timeline offers a drawing:
//    never an ask or an approval card, Needs you, a task, a run, the phone or a notification.
// 8. It costs little. At most DRAWING_MAX_BYTES of source; at most LIVE_MAX live drawings at once (the others are a still
//    card with Show); a frame goes when its card is far out of view or the chat closes, and nothing about a shown drawing
//    is kept, so after a restart it is code again until the person presses Show.
//
// Pure, so the tests are tables (drawingDoc.test.ts); sanitize.ts does the reading with DOMParser, Drawing.tsx the card.

/** The policy at the top of both documents of the box. `script-src 'none'` is what `default-src 'none'` already says,
 *  written out so nobody reads the list as one that forgot scripts. `frame-src 'none'` in the outer document is the
 *  wall that keeps the inner frame from navigating anywhere (point 4). */
export const DRAWING_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Both frames' sandbox: every `allow-*` token left out (point 1). */
export const DRAWING_SANDBOX = "";

/** The largest drawing shown, in bytes of its source as UTF-8. */
export const DRAWING_MAX_BYTES = 256 * 1024;

/** Live drawings at once, across every open chat. */
export const LIVE_MAX = 3;

/** A frame whose card is further than this outside the chat's visible part is taken down (pixels). */
export const FAR_AWAY_PX = 1200;

/** The box's height: an SVG drawing's own shape, clamped; anything else the default, scrolling inside. */
export const BOX_MIN = 80;
export const BOX_MAX = 640;
export const BOX_DEFAULT = 360;

// ---- which code blocks are drawings ----------------------------------------------------------------------------------

/** The fences a drawing may come from: an `html` or an `svg` block. Nothing renders from them by itself (an ordinary
 *  answer is full of HTML); the block only offers Show drawing, and the person presses it. */
export function drawableFence(lang: string | null | undefined): "html" | "svg" | null {
  const l = (lang ?? "").trim().toLowerCase();
  return l === "html" ? "html" : l === "svg" ? "svg" : null;
}

/** The source's size as UTF-8, which is what a cap in bytes means for text in any language. */
export function sourceBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const tooBig = (text: string): boolean => sourceBytes(text) > DRAWING_MAX_BYTES;

// ---- the allow-list (point 5) ------------------------------------------------------------------------------------------

/** HTML elements kept, by their lower-case name. Everything else goes with all it holds. */
export const KEEP_HTML: ReadonlySet<string> = new Set(
  (
    "div span p br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong b em i u s small big tt sub sup mark code pre kbd samp " +
    "var blockquote q cite abbr time figure figcaption section article aside header footer main nav address table caption " +
    "colgroup col thead tbody tfoot tr th td details summary progress meter img a style center font wbr ruby rt rp bdi bdo " +
    "data del ins label"
  ).split(" "),
);

/** SVG elements kept, by their own (mixed-case) name. `foreignObject` (HTML inside SVG), `feImage` and `script` are not. */
export const KEEP_SVG: ReadonlySet<string> = new Set(
  (
    "svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient " +
    "radialGradient stop clipPath mask pattern marker image filter feBlend feColorMatrix feComponentTransfer feComposite " +
    "feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG " +
    "feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile " +
    "feTurbulence animate animateTransform animateMotion mpath set a style"
  ).split(" "),
);

/** SVG animation elements: kept only while they change how something looks (ANIMATABLE), and not under reduced motion. */
export const SMIL: ReadonlySet<string> = new Set(["animate", "animateTransform", "animateMotion", "set", "mpath"]);

/** What SVG animation may change: how a shape looks or where it is, never an address or a link's target. */
export const ANIMATABLE: ReadonlySet<string> = new Set(
  (
    "fill stroke opacity fill-opacity stroke-opacity stroke-width stroke-dasharray stroke-dashoffset transform d points x y " +
    "cx cy r rx ry x1 y1 x2 y2 width height offset stop-color stop-opacity visibility display font-size letter-spacing dx " +
    "dy rotate startOffset viewBox gradientTransform patternTransform stdDeviation flood-color flood-opacity color " +
    "baseFrequency scale"
  ).split(" "),
);

const HTML_ATTRS: ReadonlySet<string> = new Set(
  (
    "class id style title lang dir role hidden translate width height align valign colspan rowspan span scope headers abbr " +
    "alt start reversed value min max low high optimum open datetime border cellpadding cellspacing bgcolor color face size " +
    "nowrap type"
  ).split(" "),
);

const SVG_ATTRS: ReadonlySet<string> = new Set(
  (
    "id class style transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin " +
    "stroke-miterlimit stroke-dasharray stroke-dashoffset opacity d x y x1 y1 x2 y2 cx cy r rx ry fx fy fr width height " +
    "points viewBox preserveAspectRatio xmlns xmlns:xlink xml:space xml:lang version font-size font-family font-weight " +
    "font-style text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing text-decoration " +
    "writing-mode dx dy rotate textLength lengthAdjust startOffset method spacing side offset stop-color stop-opacity " +
    "gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clipPathUnits clip-path " +
    "clip-rule mask maskUnits maskContentUnits marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX " +
    "refY orient filter filterUnits primitiveUnits flood-color flood-opacity lighting-color color-interpolation " +
    "color-interpolation-filters stdDeviation in in2 result mode operator k1 k2 k3 k4 values type tableValues slope " +
    "intercept amplitude exponent kernelMatrix order divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha " +
    "surfaceScale diffuseConstant specularConstant specularExponent azimuth elevation z pointsAtX pointsAtY pointsAtZ " +
    "limitingConeAngle scale xChannelSelector yChannelSelector radius baseFrequency numOctaves seed stitchTiles visibility " +
    "display overflow pathLength vector-effect shape-rendering text-rendering image-rendering paint-order color " +
    "pointer-events role lang attributeName attributeType begin dur end min max restart repeatCount repeatDur calcMode " +
    "keyTimes keySplines keyPoints from to by additive accumulate path"
  ).split(" "),
);

/** SVG elements whose `href` may name an element of the drawing itself (and nothing else). */
const SVG_LOCAL_REF: ReadonlySet<string> = new Set([
  "use",
  "textPath",
  "mpath",
  "linearGradient",
  "radialGradient",
  "pattern",
  "filter",
  "animate",
  "animateTransform",
  "animateMotion",
  "set",
]);

/** `#name`: an element of the drawing itself. */
export const isLocalRef = (v: string): boolean => /^#[A-Za-z_][\w:.-]*$/.test(v.trim());

/** A picture carried in the drawing itself. Any other address is never kept. */
export const isDataImage = (v: string): boolean => /^data:image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(v.trim());

/** A value that names a paint, a marker, a clip or a filter may only name one inside the drawing: `url(#id)`. */
const urlsLocal = (v: string): boolean => {
  const found = v.match(/url\s*\(/gi);
  if (!found) return true;
  const local = v.match(/url\s*\(\s*['"]?\s*#/gi);
  return !!local && local.length === found.length;
};

export type Ns = "html" | "svg" | "other";

/** Whether an element stays. `attr` reads one of its attributes (for SVG animation, which is judged by what it changes). */
export function keepElement(ns: Ns, name: string, attr: (n: string) => string | null, o: { reduceMotion: boolean }): boolean {
  if (ns === "html") return KEEP_HTML.has(name.toLowerCase());
  if (ns !== "svg" || !KEEP_SVG.has(name)) return false;
  if (!SMIL.has(name)) return true;
  if (o.reduceMotion) return false;
  if (name === "mpath" || name === "animateMotion") return true;
  const target = attr("attributeName");
  if (target === null || !ANIMATABLE.has(target.trim())) return false;
  return ["from", "to", "by", "values"].every((k) => urlsLocal(attr(k) ?? ""));
}

/** Whether an attribute stays on an element that stays. Names are as the parser gives them: lower case for HTML,
 *  SVG's own case for SVG (`viewBox`), with their prefix (`xlink:href`). */
export function keepAttr(ns: Ns, el: string, name: string, value: string): boolean {
  if (ns === "html") {
    const n = name.toLowerCase();
    if (n === "src") return el.toLowerCase() === "img" && isDataImage(value);
    if (n.startsWith("on")) return false;
    if (/^(aria|data)-[a-z0-9_.-]+$/.test(n)) return true;
    return HTML_ATTRS.has(n);
  }
  if (ns !== "svg") return false;
  if (name === "href" || name === "xlink:href") {
    if (el === "image") return isDataImage(value);
    return SVG_LOCAL_REF.has(el) && isLocalRef(value);
  }
  if (/^on/i.test(name)) return false;
  if (/^aria-[a-z]+$/.test(name)) return true;
  if (!SVG_ATTRS.has(name)) return false;
  return urlsLocal(value);
}

// ---- the box's two documents ------------------------------------------------------------------------------------------

/** For a value inside a double-quoted attribute: nothing in it can end the attribute or start a tag. */
export const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A drawing as sanitize.ts rebuilt it: its style sheets' text, the body's own class and style, the body's markup, and
 *  what the card says about it. */
export interface DrawingParts {
  styles: string[];
  bodyClass: string | null;
  bodyStyle: string | null;
  body: string;
  /** The body is one `<svg>`: it fills the box, at its own shape. */
  svgRoot: boolean;
  /** Its height over its width, from its own SVG size; null when it has none. */
  ratio: number | null;
  /** It had scripts or event handlers, which never run here: the card says a part drawn by code is missing. */
  hadScripts: boolean;
}

/** The page's own look, before the drawing's: a white page as a browser tab shows one, and no moving under reduced
 *  motion (SVG animation is left out by sanitize.ts then). */
const BASE =
  "html{color-scheme:light;background:#fff}" +
  'body{margin:0;padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;color:#1f2022}' +
  "html.manut-svg,html.manut-svg body{height:100%}html.manut-svg body{padding:0;overflow:hidden}" +
  "html.manut-svg body>svg{display:block;width:100%;height:100%}" +
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}";

const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(DRAWING_CSP)}">`;

/** The drawing's own document, the inner frame's: the policy first, then the page's look, the drawing's sheets, its body. */
export function innerDoc(p: DrawingParts): string {
  for (const s of p.styles) if (/<\/style/i.test(s)) throw new Error("a style sheet that ends itself is never written");
  const attrs = (p.bodyClass !== null ? ` class="${escapeAttr(p.bodyClass)}"` : "") + (p.bodyStyle !== null ? ` style="${escapeAttr(p.bodyStyle)}"` : "");
  return (
    `<!doctype html><html${p.svgRoot ? ' class="manut-svg"' : ""}><head>${cspMeta}` +
    `<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">` +
    `<style>${BASE}</style>${p.styles.map((s) => `<style>${s}</style>`).join("")}</head><body${attrs}>${p.body}</body></html>`
  );
}

/** The outer box: the policy first (its `frame-src 'none'` is what holds the inner frame where it is), and the inner
 *  frame, sandboxed again, with the drawing's document as its `srcdoc`. */
export function outerDoc(inner: string, title: string): string {
  return (
    `<!doctype html><html><head>${cspMeta}<meta name="referrer" content="no-referrer">` +
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>" +
    `</head><body><iframe sandbox="${DRAWING_SANDBOX}" referrerpolicy="no-referrer" title="${escapeAttr(title)}" srcdoc="${escapeAttr(inner)}"></iframe></body></html>`
  );
}

// ---- the box's size ----------------------------------------------------------------------------------------------------

const positive = (s: string | null): number | null => {
  if (s === null) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** An SVG's height over its width: from its viewBox, else from a plain width and height; null when it says neither. */
export function svgRatio(viewBox: string | null, width: string | null, height: string | null): number | null {
  if (viewBox) {
    const v = viewBox.trim().split(/[\s,]+/).map(Number);
    if (v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0) return v[3] / v[2];
  }
  const w = positive(width);
  const h = positive(height);
  return w && h ? h / w : null;
}

/** The box's height at a given width: the drawing's own shape, clamped; the default for one with no shape. */
export function boxHeight(ratio: number | null, width: number): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return BOX_DEFAULT;
  return Math.min(BOX_MAX, Math.max(BOX_MIN, Math.round(width * ratio)));
}

// ---- live drawings (point 8) -------------------------------------------------------------------------------------------

/** The live drawings after `id` is shown: it becomes the newest, and the oldest past `max` go back to a still card. */
export function nextLive(live: readonly string[], id: string, max = LIVE_MAX): { live: string[]; evicted: string[] } {
  const next = live.filter((x) => x !== id).concat(id);
  const evicted = next.length > max ? next.slice(0, next.length - max) : [];
  return { live: next.slice(evicted.length), evicted };
}
