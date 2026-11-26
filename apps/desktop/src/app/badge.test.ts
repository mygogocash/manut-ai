// The number on the Dock icon is the requests waiting on the person, and nothing else (the canvas: "The number on the Dock
// icon is the number of requests waiting"). On macOS it is set with Tauri's window badge count; a count of 0 removes the
// badge, which on macOS means sending no count at all (the runtime draws Some(0) as the label "0"). The capability the page
// needs for it, and for bringing the window forward from a notification, is granted in src-tauri/capabilities.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeCount, dockArg, dockRequests, setDockBadge } from "./badge";

const h = vi.hoisted(() => ({ calls: [] as (number | undefined)[] }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: async (n?: number) => void h.calls.push(n) }) }));

const host = () => {
  const counts: number[] = [];
  return { counts, badge: async (n: number) => void counts.push(n) };
};

afterEach(() => {
  h.calls.length = 0;
  vi.unstubAllGlobals();
});

describe("what the Dock counts", () => {
  it("is every request waiting on the person: approvals and questions in any chat, and a bot's request to type into a terminal", () => {
    expect(dockRequests([], [])).toBe(0);
    expect(dockRequests([{ id: "a" }, { id: "b" }], [])).toBe(2);
    expect(dockRequests([{ id: "a" }], [{ id: "t" }, { id: "u" }])).toBe(3);
  });

  it("never counts anything else: an answer nobody has read yet is not a request", () => {
    // the function takes the requests and nothing but them: there is no argument for unread answers
    expect(dockRequests.length).toBe(2);
  });

  it("stops at 99, as the Dock cuts longer labels, and a count never goes below 0", () => {
    expect(dockRequests(new Array(150).fill({}), [])).toBe(99);
    expect([0, 3, 99, 150, -1].map(badgeCount)).toEqual([0, 3, 99, 99, 0]);
  });
});

describe("what is sent to remove or set the badge", () => {
  it("is no count at all for 0, because macOS would draw the count 0 as the label 0", () => {
    expect(dockArg(0)).toBeUndefined();
    expect(dockArg(-2)).toBeUndefined();
    expect(dockArg(4)).toBe(4);
  });
});

describe("setting the badge", () => {
  it("on macOS in the desktop app uses the window's badge count, and nothing else", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const shell = host();
    await setDockBadge(4, shell);
    await setDockBadge(0, shell);
    await setDockBadge(12, shell);
    expect(h.calls).toEqual([4, undefined, 12]);
    expect(shell.counts).toEqual([]);
  });

  it("on another system keeps the shell's own command: Windows' dot, Linux's count", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { platform: "Win32" });
    const shell = host();
    await setDockBadge(2, shell);
    await setDockBadge(0, shell);
    expect(shell.counts).toEqual([2, 0]);
    expect(h.calls).toEqual([]);
  });

  it("in a plain browser (the demo, the Playwright suite) goes to the host as before", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const shell = host();
    await setDockBadge(3, shell);
    expect(shell.counts).toEqual([3]);
    expect(h.calls).toEqual([]);
  });
});

describe("the capability the page needs", () => {
  const caps = JSON.parse(readFileSync(join(__dirname, "../../src-tauri/capabilities/default.json"), "utf8")) as { permissions: string[] };
  it("lets the page set the window's badge count (not in core:window:default)", () => {
    expect(caps.permissions).toContain("core:window:allow-set-badge-count");
  });
  it("lets the page bring the window forward from a notification's Look first", () => {
    for (const p of ["core:window:allow-unminimize", "core:window:allow-show", "core:window:allow-set-focus"]) expect(caps.permissions).toContain(p);
  });
  it("lets the page listen to a notification's buttons and register them", () => {
    // notification:default carries register-action-types, register-listener and remove-listener
    expect(caps.permissions).toContain("notification:default");
  });
});
