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
