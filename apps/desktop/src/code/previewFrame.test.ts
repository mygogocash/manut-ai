// The preview's page in the pane beside a lane (src/code/previewFrame.ts): the one address the frame may show and why it shows
// none, the frame's sandbox, and the app's CSP that bounds every frame. Pure functions, so the tests are tables; the loopback table is
// the one the shell's `loopback_url` is tested on too (src-tauri/src/preview.rs), so the page and the shell keep the same rule.
import { describe, expect, it } from "vitest";
import confText from "../../src-tauri/tauri.conf.json?raw";
import previewFrameSource from "./previewFrame.ts?raw";
import table from "./__fixtures__/loopback.json";
import { FRAME_SANDBOX, framePlan, loopbackUrl, type FrameHere } from "./previewFrame";

const APP: FrameHere = { origin: "tauri://localhost", windows: false };
const conf = JSON.parse(confText) as { app: { security: { csp: Record<string, string>; devCsp: Record<string, string> } } };

describe("the loopback rule", () => {
  it("takes every address of the shared table the shell takes, and none it refuses", () => {
    expect(table.ok.length).toBeGreaterThan(10);
    expect(table.bad.length).toBeGreaterThan(40);
    for (const url of table.ok) expect(loopbackUrl(url), url).toBe(true);
    for (const url of table.bad) expect(loopbackUrl(url), JSON.stringify(url)).toBe(false);
  });
});

describe("what the frame shows", () => {
  it("is the preview's own address, as it was printed, on localhost over http or https at any port", () => {
    for (const url of ["http://localhost:5173/", "https://localhost:3000/", "http://localhost/", "https://localhost:443/", "http://localhost:80/"]) {
      expect(framePlan(url, APP), url).toEqual({ src: url });
    }
  });

  it("is nothing for an address the shell would not open: another computer's, a look-alike, a path, a sign-in part", () => {
    for (const url of table.bad) expect(framePlan(url, APP), JSON.stringify(url)).toEqual({ no: "not_loopback" });
    for (const url of ["http://192.168.1.5:5173/", "http://localhost.evil.example:5173/", "http://localhost:5173/admin", "http://you@localhost:5173/", "https://example.com/"]) {
      expect(framePlan(url, APP), url).toEqual({ no: "not_loopback" });
    }
  });

  it("is nothing for an address of this computer the app's CSP cannot name: [::1], and 127.0.0.1 which a preview never prints", () => {
    expect(framePlan("http://[::1]:5173/", APP)).toEqual({ no: "unnamed" });
    expect(framePlan("http://[::1]/", APP)).toEqual({ no: "unnamed" });
    expect(framePlan("http://127.0.0.1:8080/", APP)).toEqual({ no: "unnamed" });
  });

  it("is never the app's own origin, which a debug build's dev server is", () => {
    const dev: FrameHere = { origin: "http://localhost:5207", windows: false };
    expect(framePlan("http://localhost:5207/", dev)).toEqual({ no: "own" });
    // another port of the same name is another origin
    expect(framePlan("http://localhost:5173/", dev)).toEqual({ src: "http://localhost:5173/" });
    expect(framePlan("https://localhost:5207/", dev)).toEqual({ src: "https://localhost:5207/" });
  });

  it("is nothing on Windows, whatever the address", () => {
    const windows: FrameHere = { origin: "http://tauri.localhost", windows: true };
    expect(framePlan("http://localhost:5173/", windows)).toEqual({ no: "windows" });
    expect(framePlan("http://[::1]:5173/", windows)).toEqual({ no: "windows" });
    // an address the shell would not open says so first
    expect(framePlan("http://evil.example/", windows)).toEqual({ no: "not_loopback" });
  });
});

describe("the frame's sandbox", () => {
  const tokens = FRAME_SANDBOX.split(" ");

  it("lets the page run its scripts, keep its own origin and post its forms", () => {
    expect(tokens).toEqual(["allow-scripts", "allow-same-origin", "allow-forms"]);
  });

  it("gives it no way to the app's window, no pop-up, no dialog and no download", () => {
    for (const out of [
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-top-navigation-to-custom-protocols",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-modals",
      "allow-downloads",
      "allow-pointer-lock",
      "allow-presentation",
      "allow-orientation-lock",
      "allow-storage-access-by-user-activation",
    ]) {
      expect(tokens, out).not.toContain(out);
    }
  });
});

describe("the app's CSP", () => {
  // Item 53's CSP, every directive as it was but frame-src: a change to any of them is a decision of its own.
  const BEFORE = {
    "default-src": "'self'",
    "script-src": "'self' 'wasm-unsafe-eval'",
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' data: blob:",
    "media-src": "'self' data: blob:",
    "font-src": "'self' data:",
    "connect-src": "'self' ipc: http://ipc.localhost data: blob:",
    "worker-src": "'self' blob:",
    "object-src": "'none'",
    "base-uri": "'self'",
    "form-action": "'none'",
  };
  const DEV_BEFORE = {
    ...BEFORE,
    "script-src": "'self' 'unsafe-inline' 'wasm-unsafe-eval' http://localhost:5207",
    "style-src": "'self' 'unsafe-inline' http://localhost:5207",
    "img-src": "'self' data: blob: http://localhost:5207",
    "font-src": "'self' data: http://localhost:5207",
    "connect-src": "'self' ipc: http://ipc.localhost data: blob: http://localhost:5207 ws://localhost:5207 ws://127.0.0.1:*",
  };

  it("lets frames load http and https on localhost at any port, and nothing else, in both entries", () => {
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) expect(csp["frame-src"]).toBe("http://localhost:* https://localhost:*");
  });

  it("keeps every other directive as it was", () => {
    const { "frame-src": _f, ...csp } = conf.app.security.csp;
    const { "frame-src": _d, ...dev } = conf.app.security.devCsp;
    expect(csp).toEqual(BEFORE);
    expect(dev).toEqual(DEV_BEFORE);
  });

  it("names every address the page frames, so no frame the page draws is one the CSP refuses", () => {
    const sources = conf.app.security.csp["frame-src"].split(" ").map((s) => /^(https?):\/\/([^:]+):\*$/.exec(s));
    for (const url of table.ok) {
      const plan = framePlan(url, APP);
      if (!("src" in plan)) continue;
      const { protocol, hostname } = new URL(plan.src);
      expect(sources.some((m) => m && `${m[1]}:` === protocol && m[2] === hostname), url).toBe(true);
    }
  });
});

describe("the module", () => {
  it("calls nothing macOS 11's Safari lacks: no Object.hasOwn, Array.at, findLast, structuredClone or a regex lookbehind", () => {
    const code = previewFrameSource.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Object\.hasOwn\(|\.at\(|\.findLast(Index)?\(|structuredClone\(|\(\?<[=!]/);
  });
});
