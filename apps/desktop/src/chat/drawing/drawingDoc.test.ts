// The drawing's box as tables (drawingDoc.ts): the policy and the sandbox, the two documents, the allow-list against
// hostile names and values, the size cap, the box's height and the live limit. What the web view's own parser makes of
// hostile markup, and every way out of the box, are the browser's to show: e2e/chat-drawing.ts, in Chromium and WebKit.
import { describe, expect, it } from "vitest";
import {
  BOX_DEFAULT,
  BOX_MAX,
  BOX_MIN,
  DRAWING_CSP,
  DRAWING_MAX_BYTES,
  DRAWING_SANDBOX,
  LIVE_MAX,
  boxHeight,
  drawableFence,
  escapeAttr,
  innerDoc,
  isDataImage,
  isLocalRef,
  keepAttr,
  keepElement,
  nextLive,
  outerDoc,
  sourceBytes,
  svgRatio,
  tooBig,
  type DrawingParts,
} from "./drawingDoc";

const parts = (o: Partial<DrawingParts> = {}): DrawingParts => ({
  styles: [],
  bodyClass: null,
  bodyStyle: null,
  body: "<p>hi</p>",
  svgRoot: false,
  ratio: null,
  hadScripts: false,
  ...o,
});
/** The value of the one `srcdoc` attribute in the outer document, read back as a browser would. */
const srcdocOf = (outer: string) => {
  const all = [...outer.matchAll(/ srcdoc="([^"]*)"/g)];
  expect(all).toHaveLength(1);
  return all[0][1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
};

describe("the policy and the sandbox", () => {
  it("allows no script, connection, frame, form or base, and pictures and fonts only as data", () => {
    expect(DRAWING_CSP).toBe(
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'",
    );
    const dirs = Object.fromEntries(DRAWING_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
    expect(dirs["default-src"]).toBe("'none'");
    expect(dirs["script-src"]).toBe("'none'");
    // nothing that would let a connection, a worker, a frame or a plug-in through on its own
    for (const d of ["connect-src", "worker-src", "child-src", "object-src", "media-src", "manifest-src", "prefetch-src"]) expect(dirs[d], d).toBeUndefined();
    expect(DRAWING_CSP).not.toMatch(/unsafe-eval|https?:|\*|blob:|'self'/);
  });
  it("has no allow token at all", () => {
    expect(DRAWING_SANDBOX).toBe("");
  });
});

describe("the two documents", () => {
  it("puts the policy first in the drawing's document, before the page's look and the drawing's own sheets", () => {
    const doc = innerDoc(parts({ styles: ["p{color:red}"] }));
    expect(doc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttr(DRAWING_CSP)}">`)).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style>"));
    expect(doc.indexOf("p{color:red}")).toBeGreaterThan(doc.indexOf("<style>"));
    expect(doc).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
    expect(doc.endsWith("<body><p>hi</p></body></html>")).toBe(true);
  });
  it("puts the policy first in the outer box too, and holds the drawing in one frame with an empty sandbox", () => {
    const inner = innerDoc(parts());
    const outer = outerDoc(inner, "A drawing by Kami");
    expect(outer.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttr(DRAWING_CSP)}">`)).toBe(true);
    expect(outer.match(/<iframe /g)).toHaveLength(1);
    expect(outer).toContain('<iframe sandbox="" referrerpolicy="no-referrer" title="A drawing by Kami" srcdoc="');
    expect(srcdocOf(outer)).toBe(inner);
  });
  it("an SVG drawing fills the box at its own shape; the body's own class and style are kept, quoted", () => {
    const doc = innerDoc(parts({ svgRoot: true, bodyClass: 'a" onload="x', bodyStyle: "color:#333" }));
    expect(doc.startsWith('<!doctype html><html class="manut-svg"><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).toContain('<body class="a&quot; onload=&quot;x" style="color:#333">');
  });
  it("never writes a style sheet that would end itself", () => {
    expect(() => innerDoc(parts({ styles: ["p{}</style><p>out"] }))).toThrow();
    expect(() => innerDoc(parts({ styles: ["p{}</STYLE "] }))).toThrow();
  });

  // hostile drawings: whatever the body holds, it stays the inner frame's document, and the outer box holds one frame
  const hostile = [
    '"><script>alert(1)</script>',
    "</iframe><script>top.x=1</script><iframe>",
    '&quot; onload=&quot;alert(1)',
    "&amp;quot; &lt;script&gt;",
    '" sandbox="allow-scripts allow-same-origin',
    "<iframe srcdoc=\"<script>parent.x=1</script>\"></iframe>",
    "\u0000  <!-- --!> -->",
    "'\"`<>&",
  ];
  for (const body of hostile)
    it(`a body of ${JSON.stringify(body)} stays inside the one srcdoc`, () => {
      const inner = innerDoc(parts({ body }));
      const outer = outerDoc(inner, '"><b>title</b>');
      expect(srcdocOf(outer)).toBe(inner);
      expect(outer.match(/<iframe /g)).toHaveLength(1);
      expect(outer.match(/ sandbox="/g)).toHaveLength(1);
      expect(outer).toContain('title="&quot;&gt;&lt;b&gt;title&lt;/b&gt;"');
      // the attribute's value has no raw quote, tag or ampersand that is not an entity
      const raw = /srcdoc="([^"]*)"/.exec(outer)![1];
      expect(raw).not.toMatch(/[<>]/);
      expect(raw).not.toMatch(/&(?!amp;|quot;|lt;|gt;)/);
    });
});

describe("which blocks offer a drawing", () => {
  it("an html or an svg block, never any other", () => {
    expect(drawableFence("html")).toBe("html");
    expect(drawableFence("HTML")).toBe("html");
    expect(drawableFence(" svg ")).toBe("svg");
    for (const l of ["", null, undefined, "xml", "js", "javascript", "jsx", "tsx", "vue", "htm", "xhtml", "md", "html2", "text/html"]) expect(drawableFence(l), String(l)).toBeNull();
  });
});

describe("the size cap", () => {
  it("counts bytes of UTF-8, so Thai, Japanese and emoji-sized characters count as they weigh", () => {
    expect(sourceBytes("abc")).toBe(3);
    expect(sourceBytes("ก")).toBe(3);
    expect(sourceBytes("日本")).toBe(6);
    expect(sourceBytes("\u{1F600}")).toBe(4);
  });
  it("shows up to 256 KiB and not a byte more", () => {
    expect(DRAWING_MAX_BYTES).toBe(262144);
    expect(tooBig("a".repeat(DRAWING_MAX_BYTES))).toBe(false);
    expect(tooBig("a".repeat(DRAWING_MAX_BYTES + 1))).toBe(true);
    // one three-byte character over the line
    expect(tooBig("a".repeat(DRAWING_MAX_BYTES - 2) + "ก")).toBe(true);
    expect(tooBig("a".repeat(DRAWING_MAX_BYTES - 3) + "ก")).toBe(false);
  });
});

describe("the allow-list: elements", () => {
  const no = () => null;
  const still = { reduceMotion: false };
  it("keeps what draws, and drops what loads, runs, navigates or hides HTML inside SVG", () => {
    for (const n of ["div", "P", "table", "td", "details", "summary", "img", "a", "style"]) expect(keepElement("html", n, no, still), n).toBe(true);
    for (const n of ["svg", "g", "path", "linearGradient", "textPath", "feGaussianBlur", "use", "image", "a", "style", "title"]) expect(keepElement("svg", n, no, still), n).toBe(true);
    for (const n of [
      "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base",
      "title", "video", "audio", "source", "track", "picture", "canvas", "form", "input", "button", "select", "textarea",
      "portal", "fencedframe", "dialog", "slot", "math", "svg", "my-chart", "isindex", "keygen", "plaintext", "xmp", "noembed",
      "noframes", "marquee", "head", "body", "html",
    ])
      expect(keepElement("html", n, no, still), n).toBe(false);
    for (const n of ["script", "foreignObject", "feImage", "switch", "view", "metadata", "cursor", "font-face", "handler", "listener", "discard", "LinearGradient"])
      expect(keepElement("svg", n, no, still), n).toBe(false);
    for (const n of ["math", "mi", "annotation-xml", "mglyph"]) expect(keepElement("other", n, no, still), n).toBe(false);
  });
  it("keeps SVG animation only while it changes how something looks, and none under reduced motion", () => {
    const a = (o: Record<string, string>) => (k: string) => o[k] ?? null;
    expect(keepElement("svg", "animate", a({ attributeName: "opacity", from: "0", to: "1" }), still)).toBe(true);
    expect(keepElement("svg", "animateTransform", a({ attributeName: "transform", type: "rotate" }), still)).toBe(true);
    expect(keepElement("svg", "set", a({ attributeName: "fill", to: "url(#g)" }), still)).toBe(true);
    expect(keepElement("svg", "animateMotion", a({ path: "M0 0L10 10" }), still)).toBe(true);
    for (const target of ["href", "xlink:href", "target", "src", "style", "onclick", "begin", "class", "", " href"])
      expect(keepElement("svg", "set", a({ attributeName: target, to: "http://127.0.0.1/" }), still), target).toBe(false);
    expect(keepElement("svg", "set", a({}), still)).toBe(false);
    expect(keepElement("svg", "animate", a({ attributeName: "fill", values: "red;url(http://127.0.0.1/p.svg#g)" }), still)).toBe(false);
    expect(keepElement("svg", "set", a({ attributeName: "fill", to: "url( 'http://127.0.0.1/x#a' )" }), still)).toBe(false);
    for (const n of ["animate", "animateTransform", "animateMotion", "set", "mpath"])
      expect(keepElement("svg", n, a({ attributeName: "opacity" }), { reduceMotion: true }), n).toBe(false);
  });
});

describe("the allow-list: attributes", () => {
  it("drops every handler, address, target and loader of HTML; keeps the look", () => {
    for (const [el, n, v] of [
      ["div", "onclick", "x()"],
      ["div", "ONMOUSEOVER", "x()"],
      ["a", "href", "http://127.0.0.1:1/"],
      ["a", "href", "#top"],
      ["a", "href", "javascript:x()"],
      ["a", "target", "_blank"],
      ["a", "ping", "http://127.0.0.1:1/"],
      ["a", "download", ""],
      ["a", "rel", "preconnect"],
      ["img", "src", "http://127.0.0.1:1/a.png"],
      ["img", "src", "//127.0.0.1:1/a.png"],
      ["img", "src", "data:text/html,<script>x</script>"],
      ["img", "src", " javascript:x()"],
      ["img", "srcset", "data:image/png;base64,AA 1x"],
      ["img", "usemap", "#m"],
      ["img", "longdesc", "http://127.0.0.1:1/"],
      ["div", "src", "data:image/png;base64,AA"],
      ["table", "background", "http://127.0.0.1:1/bg.png"],
      ["form", "action", "http://127.0.0.1:1/"],
      ["div", "formaction", "http://127.0.0.1:1/"],
      ["div", "srcdoc", "<p>"],
      ["div", "poster", "http://127.0.0.1:1/"],
      ["div", "data", "http://127.0.0.1:1/"],
      ["div", "manifest", "http://127.0.0.1:1/"],
      ["div", "itemtype", "http://127.0.0.1:1/"],
      ["div", "is", "x-y"],
      ["div", "contenteditable", "true"],
      ["div", "autofocus", ""],
      ["div", "tabindex", "0"],
      ["div", "nonce", "1"],
      ["div", "slot", "a"],
      ["div", "popover", ""],
      ["div", "http-equiv", "refresh"],
      ["div", "content", "0;url=http://127.0.0.1:1/"],
      ["div", "xmlns", "http://www.w3.org/1999/xhtml"],
    ] as const)
      expect(keepAttr("html", el, n, v), `${el} ${n}=${v}`).toBe(false);
    for (const [el, n, v] of [
      ["div", "class", "a b"],
      ["div", "style", "color:red"],
      ["td", "colspan", "2"],
      ["img", "src", "data:image/png;base64,iVBORw0KGgo="],
      ["img", "src", "DATA:image/svg+xml,<svg/>"],
      ["img", "alt", "a chart"],
      ["div", "aria-label", "x"],
      ["div", "data-n", "1"],
      ["details", "open", ""],
      ["meter", "value", "0.5"],
    ] as const)
      expect(keepAttr("html", el, n, v), `${el} ${n}=${v}`).toBe(true);
  });
  it("lets an SVG reference name only an element of the drawing, and a picture only one it carries", () => {
    for (const [el, n, v] of [
      ["use", "href", "#a"],
      ["use", "xlink:href", "#icon.1"],
      ["linearGradient", "href", "#g"],
      ["textPath", "href", "#p"],
      ["image", "href", "data:image/png;base64,AA"],
      ["image", "xlink:href", "data:image/jpeg;base64,AA"],
      ["rect", "fill", "url(#g)"],
      ["rect", "fill", "url( '#g' )"],
      ["rect", "filter", 'url("#f")'],
      ["path", "marker-end", "url(#m)"],
      ["svg", "viewBox", "0 0 10 10"],
      ["text", "font-family", "serif"],
    ] as const)
      expect(keepAttr("svg", el, n, v), `${el} ${n}=${v}`).toBe(true);
    for (const [el, n, v] of [
      ["use", "href", "http://127.0.0.1:1/s.svg#a"],
      ["use", "href", "data:image/svg+xml,<svg id='a'/>#a"],
      ["use", "href", "s.svg#a"],
      ["use", "href", "#"],
      ["use", "href", "#a b"],
      ["use", "href", "javascript:x()"],
      ["image", "href", "http://127.0.0.1:1/a.png"],
      ["image", "href", "#a"],
      ["a", "href", "#a"],
      ["a", "xlink:href", "http://127.0.0.1:1/"],
      ["a", "target", "_blank"],
      ["rect", "href", "#a"],
      ["feImage", "href", "#a"],
      ["rect", "fill", "url(http://127.0.0.1:1/p.svg#g)"],
      ["rect", "fill", "url(#g) url(http://127.0.0.1:1/)"],
      ["rect", "mask", "url(//127.0.0.1:1/m.svg#m)"],
      ["rect", "clip-path", "URL(data:image/svg+xml,x)"],
      ["path", "marker-start", "url( 'http://127.0.0.1:1/m.svg#m' )"],
      ["rect", "onload", "x()"],
      ["svg", "onLoad", "x()"],
      ["rect", "cursor", "url(http://127.0.0.1:1/c.png),auto"],
      ["set", "href", "http://127.0.0.1:1/"],
      ["rect", "requiredExtensions", "http://127.0.0.1:1/"],
      ["rect", "externalResourcesRequired", "true"],
      ["svg", "contentScriptType", "text/javascript"],
    ] as const)
      expect(keepAttr("svg", el, n, v), `${el} ${n}=${v}`).toBe(false);
  });
  it("an element the list does not know is not judged by its attributes at all: it never stays", () => {
    expect(keepAttr("other", "mi", "class", "x")).toBe(false);
  });
  it("names a local reference and a carried picture strictly", () => {
    expect(isLocalRef("#a-1_b.c:d")).toBe(true);
    for (const v of ["#", "#1a", "a#b", "#a b", "#a\nb", "# a"]) expect(isLocalRef(v), v).toBe(false);
    expect(isDataImage("data:image/png;base64,AA")).toBe(true);
    for (const v of ["data:image/png", "data:text/html,x", "data:,x", "data:image/x-icon;base64,AA", "blob:x", "http://x/a.png"]) expect(isDataImage(v), v).toBe(false);
  });
});

describe("the box's size", () => {
  it("reads an SVG's shape from its viewBox, else from a plain width and height", () => {
    expect(svgRatio("0 0 400 200", null, null)).toBe(0.5);
    expect(svgRatio("0,0,100,300", "10", "10")).toBe(3);
    expect(svgRatio(null, "400", "300")).toBe(0.75);
    expect(svgRatio(null, "400px", "100px")).toBe(0.25);
    for (const [vb, w, h] of [
      [null, null, null],
      ["0 0 0 10", null, null],
      ["0 0 -1 10", null, null],
      ["x", null, null],
      [null, "100%", "50%"],
      [null, "10em", "5em"],
      [null, "0", "10"],
      [null, "400", null],
    ] as const)
      expect(svgRatio(vb, w, h), JSON.stringify([vb, w, h])).toBeNull();
    expect(svgRatio("0 0 0 10", "200", "100")).toBe(0.5);
  });
  it("is the drawing's shape at the card's width, clamped to 80 and 640; the default for one with none", () => {
    expect([BOX_MIN, BOX_DEFAULT, BOX_MAX]).toEqual([80, 360, 640]);
    expect(boxHeight(0.5, 600)).toBe(300);
    expect(boxHeight(0.01, 600)).toBe(80);
    expect(boxHeight(5, 600)).toBe(640);
    expect(boxHeight(null, 600)).toBe(360);
    expect(boxHeight(NaN, 600)).toBe(360);
    expect(boxHeight(-1, 600)).toBe(360);
    expect(boxHeight(Infinity, 600)).toBe(360);
  });
});

describe("live drawings", () => {
  it("keeps at most three; a fourth sends the oldest back to a still card", () => {
    expect(LIVE_MAX).toBe(3);
    let live: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const n = nextLive(live, id);
      expect(n.evicted).toEqual([]);
      live = n.live;
    }
    expect(live).toEqual(["a", "b", "c"]);
    const fourth = nextLive(live, "d");
    expect(fourth).toEqual({ live: ["b", "c", "d"], evicted: ["a"] });
    // showing one again makes it the newest and sends nothing away
    expect(nextLive(fourth.live, "b")).toEqual({ live: ["c", "d", "b"], evicted: [] });
    expect(nextLive(["a", "b", "c", "d", "e"], "f", 2)).toEqual({ live: ["e", "f"], evicted: ["a", "b", "c", "d"] });
  });
});
