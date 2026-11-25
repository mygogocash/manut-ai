// The preview's page drawn in the pane beside a lane (docs/code-editor.md, "The page in the pane"; the design canvas's Code board,
// Preview): which address the frame may show, and why it shows none. Pure, so the tests are tables; LanePreview.tsx draws it.
//
// The frame shows one address only: the one its own lane's preview printed and runs at, while it runs. It must pass the rule the
// shell's `preview_open` keeps (src-tauri/src/preview.rs `loopback_url`; both are tested on __fixtures__/loopback.json, so the page
// and the shell cannot drift apart), and the shell checks again what the app's window loads (`app_window_may_load`). What the frame
// cannot do is the sandbox's and the app's CSP's (tauri.conf.json `frame-src`), which docs/code-editor.md lists.

/** The address `preview_open` takes, as preview.rs writes the rule: `http` or `https`, then `localhost`, `127.0.0.1` or `[::1]`, a
 *  port or none, and a closing `/` with nothing after it. Read the same way as the Rust, character by character, never through the
 *  browser's URL parser, which would forgive what the shell refuses. */
export function loopbackUrl(url: string): boolean {
  const rest = url.startsWith("http://") ? url.slice(7) : url.startsWith("https://") ? url.slice(8) : null;
  if (rest === null || !rest.endsWith("/")) return false;
  const authority = rest.slice(0, -1);
  let host: string;
  let port: string;
  if (authority.startsWith("[::1]")) {
    host = "[::1]";
    port = authority.slice(5);
  } else {
    const colon = authority.indexOf(":");
    const end = colon < 0 ? authority.length : colon;
    host = authority.slice(0, end);
    port = authority.slice(end);
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return false;
  if (port === "") return true;
  if (!port.startsWith(":") || !/^[0-9]{1,5}$/.test(port.slice(1))) return false;
  const n = Number(port.slice(1));
  return n >= 1 && n <= 65535;
}

/** The frame's sandbox, token by token (docs/decisions.md, 25 Nov 2026). In: `allow-scripts`, since a dev server's page is a
 *  script app; `allow-same-origin`, so the page keeps its own origin, which its module scripts, its reload socket and its storage
 *  need (an opaque origin fails the dev server's own CORS and WebSocket checks), and which is never the app's (`framePlan` refuses
 *  the app's own address); `allow-forms`, so a form posts to the page's own server. Out: every `allow-top-navigation*`, so the
 *  page cannot move the app's window; `allow-popups` and `allow-popups-to-escape-sandbox`, so nothing opens a window of the app;
 *  `allow-modals`, so no dialog of the page's stands over the app; `allow-downloads`, `allow-pointer-lock`, `allow-presentation`,
 *  `allow-orientation-lock` and `allow-storage-access-by-user-activation`, which a preview does not need. */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

/** The one host the app's CSP lets a frame load (tauri.conf.json `frame-src`: http and https on `localhost`, any port). A CSP
 *  source cannot name `[::1]` (WebKit refuses the frame even when `http://[::1]:*` is written), and a preview's address is never
 *  `127.0.0.1` (`@manut/dev-url` shows it as `localhost`). */
const FRAMED_HOST = "localhost";

/** Why the page is not drawn in the pane though the preview runs at an address. */
export type NoFrame =
  /** Not an address `preview_open` would take. `@manut/dev-url` never answers one; this is the page's own second look. */
  | "not_loopback"
  /** Windows' webview puts every one of Tauri's scripts in every frame, so a framed page there would hold the key the app's own
   *  calls carry. The preview does not run on Windows yet; the frame stays off there until that is settled. */
  | "windows"
  /** An address of this computer the app's CSP cannot name (`[::1]`): Open in browser shows it. */
  | "unnamed"
  /** The app's own origin (a debug build's dev server): framed with its own origin, the page could reach the app's. */
  | "own";

export type FramePlan = { src: string } | { no: NoFrame };

/** Where the page runs: the app page's own origin, and whether this is Windows. */
export interface FrameHere {
  origin: string;
  windows: boolean;
}

/** What the frame beside a lane shows for the address its preview runs at: that very address, or why none. */
export function framePlan(url: string, here: FrameHere): FramePlan {
  if (!loopbackUrl(url)) return { no: "not_loopback" };
  if (here.windows) return { no: "windows" };
  const address = new URL(url);
  if (address.hostname !== FRAMED_HOST) return { no: "unnamed" };
  if (address.origin === here.origin) return { no: "own" };
  return { src: url };
}

/** Where this page runs, read from the browser (the pane reads it once). */
export function frameHere(): FrameHere {
  if (typeof window === "undefined") return { origin: "", windows: false };
  return { origin: window.location.origin, windows: typeof navigator !== "undefined" && /^Win/.test(navigator.platform) };
}
