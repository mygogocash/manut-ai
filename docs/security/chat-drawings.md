# A drawing in the chat (item 98)

An agent's answer often carries HTML or SVG: a chart, a diagram, a small page. Under a finished answer's `html` or `svg`
code block the chat offers **Show drawing**; pressing it draws that markup in a card under the block, and **Open larger**
shows the same box in a sheet of the app's own. The code stays as it was, with Copy.

The markup is a model's, possibly steered by a web page or a file the agent read, so the app treats it as hostile. The
rules below are the feature; the code keeps them in `apps/desktop/src/chat/drawing/` (the same list heads
`drawingDoc.ts`).

## The safety model

1. **Nothing of a drawing runs.** The box is two nested frames, each `<iframe sandbox="">` with no `allow-*` token: no
   scripts, no same origin, no forms, pop-ups, top navigation, modals, downloads, pointer lock or presentation. A drawing
   is its HTML, SVG and CSS drawn still; CSS and SVG animation play, a script never does. When a drawing had scripts the
   card says that a part drawn by code is missing.

   Why not `allow-scripts`, as first planned: in WebKit, the engine of the macOS web view, a script in a sandboxed frame
   with an opaque origin still opened connections to a listener on this computer while the policy in rule 3 applied, by
   WebRTC (a STUN packet over UDP, a TURN connection over TCP) and by a preconnect link it added. No CSP directive and
   no sandbox token covers either, and a script can always add elements after any filter has run. So a drawing's
   scripts cannot be fenced in, and the feature shows the picture without them. Chromium sent nothing in the same test.
   Two more reasons came out of the tests: the app's own `script-src 'self'`, which a `srcdoc` frame inherits, refuses
   a drawing's inline script by itself (in this Mac's web view too), so running one would have meant adding a nonce to
   the app's own policy; and a script that loops forever froze the app's page in both engines.
2. **Its origin is opaque.** Both documents come from `srcdoc` in a sandbox without `allow-same-origin`: the app's
   storage, cookies and IndexedDB are another origin's to it, and the top window throws `SecurityError`. Tauri puts its
   scripts, the bridge into the app among them, in the main frame only on macOS and Linux (`docs/code-editor.md`, "The
   page in the pane"), and no script of the drawing runs to look for them.
3. **No network.** The first element of each document is a `<meta http-equiv="Content-Security-Policy">`:
   `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none';
   form-action 'none'; base-uri 'none'`. A `srcdoc` document also inherits the app's own policy (`tauri.conf.json`), and
   both apply.
4. **It cannot navigate itself out.** The app's `frame-src` lets a frame load `http://localhost` at any port, because a
   lane's preview needs it, and a single sandboxed frame could still move itself there by an address, a refresh or a
   link: that reached a listener in both engines. So the drawing is the inner frame of an outer box whose own
   `frame-src 'none'` governs every navigation of the inner frame. The outer box has no content but the inner frame.
5. **Only markup that names nothing outside is kept.** The drawing is read with the web view's own parser (an inert
   `DOMParser` document, in which nothing loads or runs) and rebuilt from an allow-list of elements and attributes.
   Links keep their words and lose where they lead (`href`, `target`, `ping`, `download`); a picture may only be a
   `data:image/` one; an SVG reference may only name an `#id` inside the drawing; SVG animation may only change how
   something looks, never an address. `<link>`, `<meta>`, `<base>`, scripts, event handlers, frames, objects, embeds,
   video and audio, forms and their fields, MathML, `foreignObject` and anything the list does not know go, with what is
   inside them. In WebKit the script-free, CSP-bound box still connected out for a preconnect link and for a click on a
   link that opens a new window, which is why the markup is filtered as well as fenced in. The rebuilt drawing is read
   and filtered a second time; if that pass would change anything, the card shows nothing but a line saying it could
   not be shown safely.
6. **Nothing flows back.** No script runs, so the frame can send nothing. The app listens to no `message` from a drawing
   and gives the frame nothing but its own document. The box's height comes from the drawing's own SVG size, read by the
   app from the text, clamped to 80 to 640 pixels; any other drawing is 360 pixels high and scrolls inside its box.
7. **It cannot pass for the app.** A drawing is always inside a card the app draws: a grey band with "Drawn by <name>"
   and Open larger, and a line saying it is a closed box with no scripts, no network and no access to your files or the
   app. A frame cannot paint outside its box. Only a finished answer in a chat's timeline offers a drawing: never an ask
   or an approval card, Needs you, a task, a run's drawer, the phone or a notification.
8. **It costs little.** At most 256 KiB of source; a bigger block says it is too large instead of offering Show. At most
   three drawings are live at once across the app; showing a fourth puts the oldest back to a still card with Show. A
   frame goes when its card is more than 1200 pixels out of the chat's view, or when the chat closes. Nothing about a
   shown drawing is kept, so after a restart it is code again until the person presses Show.

## On by default

Show drawing is offered without a setting (`docs/decisions.md`, 26 Nov 2026). For on: nothing is drawn until the person
presses Show on that one block, and what is drawn runs no code, reaches no network and reads nothing of the app's. For
off: it is new. A switch would ask an owner to judge a risk the rules above already close, and the button is the
choice.

## Where each rule is checked

- `apps/desktop/src/chat/drawing/drawingDoc.test.ts`: the policy and the empty sandbox, both documents with the policy
  first, hostile bodies that stay inside the one `srcdoc`, which blocks offer a drawing, the 256 KiB cap in bytes, the
  allow-list against hostile element names, attribute names and values (handlers, addresses, targets, loaders, SVG
  references to other documents, animation of an address), the box's height and the live limit.
- `apps/desktop/src/chat/drawing/Drawing.test.tsx`: Show drawing under an html or svg block of an answer and nowhere
  else, the size cap's words, ko, ja and zh, that only the timeline and a finished answer's bubble pass the drawing's
  author on (so asks, cards, Needs you, tasks, runs and the phone never offer one), and that the drawing's code listens
  to no message and touches no frame's window.
- `apps/desktop/e2e/chat-drawing.ts`, run by `chat-drawing.spec.ts` (Chromium) and `chat-drawing-webkit.spec.ts`
  (WebKit): every way out of the box, each against a listener the spec starts on 127.0.0.1 that must receive nothing,
  on a page served with the app's production policy and built by the app's own modules. Navigation by an address, a
  refresh and a link; fetch, XHR, WebSocket, EventSource, sendBeacon, fetchLater, a worker, a module import and WebRTC
  from a script; image beacons in eight forms; CSS in eleven; links in the head in nine; preconnect; DNS prefetch;
  frames, objects, embeds and media; SVG references and animation; MathML and HTML hidden in SVG; and twelve kinds of
  press (links to the frame itself, a new window, the whole window and the frame around it, a base, an SVG link, an
  image map, two forms, a ping, a download, a script address, a script on a press). Each runs as the app builds the box
  and again with the markup unfiltered, to show what the box holds alone. The frames' origin is opaque and they reach
  no bridge, storage, cookie, IndexedDB or top window. "Why" cases keep the reasons on record (one frame navigates
  itself to `localhost`; in WebKit an unfiltered preconnect, and a script given a nonce, connect out). In the app
  itself: the chart card, Open larger, Hide, an svg block, a hostile drawing through the chat, the live limit, far out
  of view, the chat closing, the app's message listeners unchanged, reduced motion, pictures in both themes at 1280 and
  900 (`DRAWING_SHOTS=<dir>` keeps them), and ko, ja and zh. Chromium runs with its Local Network Access check off, so
  only the box stands between the drawing and the listener, as in the app's window.

## Measured

- The simplest box, one sandboxed frame with the markup unfiltered, reached the listener by a pressed link to its own
  address and a download link in both engines, and in WebKit also by a preconnect, a link to a new window and an image
  map's area. The app's box reached it by nothing.
- A script that loops forever, in a frame with `allow-scripts`, left the page itself unable to answer for 4 seconds in
  both engines; with the empty sandbox the page answered in 4 ms. No script of a drawing runs, so none can spin. Heavy
  CSS or a very large SVG is still the web view's own work on its main thread; the 256 KiB cap bounds it, and nothing
  else was measured.

## In this Mac's own web view

A scratch program (not in the repository) drew the box in a WKWebView without a window, the engine Tauri uses on macOS
(macOS 27.2), with the app's page served from a `tauri://` scheme with the production policy as a header and a stand-in
for Tauri's bridge added to the main frame only, as Tauri adds it. It used the app's own modules, bundled. The eleven
hostile drawings of `chat-drawing.ts` that need no press were drawn, each one inner frame with an empty sandbox, and a
listener on 127.0.0.1 received nothing. An unfiltered preconnect in the script-free box did reach a second listener,
so the WebKit finding is the system engine's too. With scripts allowed and no nonce, an inline script in the box did not
run: the app's inherited `script-src 'self'` refused it. The bridge was in the main frame only, and `RTCPeerConnection`
exists in that web view (it was not called).

Not checked in the real web view, only in browsers: every press inside a drawing (a windowless web view takes no
input); the frames' opaque origin and their reach to storage and the top window, read from inside them; the card, the
sheet and the limits in the app itself; Tauri's own pieces around the frame (wry's `ipc` handler and the window's
navigation hook, `app_window_guard`, which lets `about:srcdoc` load); and macOS 11, which this Mac cannot run.
