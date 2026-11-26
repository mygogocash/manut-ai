// The Mac App Store edition (docs/app-store.md): the page's own reading of the flag, and the shell's entitlements file read
// as it is, so what the sandbox grants cannot drift unseen from what the docs and the App Review notes say.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAppStore, sandboxSaid, TERMINAL_REFUSED } from "./appStore";

const shellText = (name: string) => readFileSync(fileURLToPath(new URL(`../src-tauri/${name}`, import.meta.url)), "utf8");

/** The plist's top-level keys with their value: true, a string, or the strings of an array. Comments are dropped. */
function entitlements(): Record<string, true | string | string[]> {
  const xml = shellText("AppStore.entitlements").replace(/<!--[\s\S]*?-->/g, "");
  const out: Record<string, true | string | string[]> = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*(<true\/>|<string>([^<]*)<\/string>|<array>([\s\S]*?)<\/array>)/g)) {
    out[m[1]] = m[2] === "<true/>" ? true : m[3] !== undefined ? m[3] : [...m[4].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]);
  }
  return out;
}

const EXC = "com.apple.security.temporary-exception.files.";

describe("the Mac App Store edition", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off in every build but the App Store one; e2e's stand-in can turn it on, never off", () => {
    expect(isAppStore()).toBe(false);
    vi.stubGlobal("__manutAppStore", true);
    expect(isAppStore()).toBe(true);
    vi.stubGlobal("__manutAppStore", "yes");
    expect(isAppStore()).toBe(false);
  });

  it("says a terminal the sandbox refused in plain words, and any other start error as it came", () => {
    const say = (k: string) => `said:${k}`;
    expect(sandboxSaid(TERMINAL_REFUSED, say)).toBe("said:ss.sandboxTerminal");
    expect(sandboxSaid("not a folder: /x", say)).toBe("not a folder: /x");
    // the shell's code (app_store.rs TERMINAL_REFUSED) and the page's are the same string
    expect(shellText("src/app_store.rs")).toContain(`pub const TERMINAL_REFUSED: &str = "${TERMINAL_REFUSED}";`);
  });

  it("is sandboxed as the listing's app, connects out and listens nowhere", () => {
    const e = entitlements();
    const overlay = JSON.parse(shellText("tauri.appstore.conf.json"));
    expect(e["com.apple.security.app-sandbox"]).toBe(true);
    expect(e["com.apple.application-identifier"]).toBe(`N66J8AA6TA.${overlay.identifier}`);
    expect(e["com.apple.developer.team-identifier"]).toBe("N66J8AA6TA");
    for (const k of ["network.client", "files.user-selected.read-write", "files.bookmarks.app-scope", "device.audio-input"]) {
      expect(e[`com.apple.security.${k}`], k).toBe(true);
    }
    // nothing the brief did not ask for: no listening socket, no Apple events, no camera
    for (const k of ["network.server", "automation.apple-events", "device.camera", "temporary-exception.apple-events"]) {
      expect(e[`com.apple.security.${k}`], k).toBeUndefined();
    }
    expect(Object.keys(e).sort()).toEqual(
      [
        "com.apple.application-identifier",
        "com.apple.developer.team-identifier",
        "com.apple.security.app-sandbox",
        "com.apple.security.device.audio-input",
        "com.apple.security.files.bookmarks.app-scope",
        "com.apple.security.files.user-selected.read-write",
        "com.apple.security.network.client",
        `${EXC}absolute-path.read-only`,
        `${EXC}home-relative-path.read-only`,
        `${EXC}home-relative-path.read-write`,
      ].sort(),
    );
  });

  it("names each place the agents need, relative to the real home, and writes only where an agent keeps its own state", () => {
    const e = entitlements();
    const rw = e[`${EXC}home-relative-path.read-write`] as string[];
    const ro = e[`${EXC}home-relative-path.read-only`] as string[];
    for (const p of ["/.manut/", "/.claude/", "/.claude.json", "/.codex/", "/.config/opencode/", "/.local/share/opencode/", "/.grok/", "/.pi/", "/.omo/"]) {
      expect(rw, p).toContain(p);
    }
    for (const p of ["/.local/bin/", "/.gitconfig", "/.ssh/", "/.config/git/"]) expect(ro, p).toContain(p);
    expect(e[`${EXC}absolute-path.read-only`]).toEqual(["/opt/homebrew/", "/usr/local/"]);
    // every entry starts at the home folder; folders end with a slash; nothing is granted twice or both ways
    for (const p of [...rw, ...ro]) expect(p, p).toMatch(/^\/[^~]/);
    expect(new Set([...rw, ...ro]).size).toBe(rw.length + ro.length);
    // never the whole home, Library or a folder of the person's documents
    for (const p of [...rw, ...ro]) expect(p, p).not.toMatch(/^\/$|^\/Library\/$|^\/(Documents|Desktop|Downloads)\//);
    // the program folders and the person's keys are read, never written
    for (const p of ["/.local/bin/", "/.ssh/", "/.gitconfig"]) expect(rw, p).not.toContain(p);
  });
});
