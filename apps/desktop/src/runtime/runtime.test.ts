// Which runtime the app picks: the in-process one (Practice) unless this computer chose Connected in Settings ›
// Developer, or a WebSocket URL was configured on purpose.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../lib/bridge";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "./adapter";
import { HTTP_CAPABILITIES, HttpRuntime, sharedHttpHost } from "./http";
import { can, createRuntime, forgetStartedRuntime, runtimeCapabilities, runtimeKind, startedRuntime } from "./index";
import { MockRuntime } from "./mock";
import { RUNTIME_KEY } from "./setting";

const win = globalThis as unknown as { window?: Record<string, unknown> };
const CONNECTED = { mode: "connected", origin: "https://dev.manut.xyz" } as const;

afterEach(() => {
  delete win.window;
  vi.unstubAllGlobals();
  forgetStartedRuntime();
});

describe("the runtime this computer chose", () => {
  it("is the connected runtime for Connected, one host per origin, dialling nothing until connect", () => {
    expect(runtimeKind(CONNECTED)).toBe("http");
    const a = createRuntime(CONNECTED);
    const b = createRuntime(CONNECTED);
    expect(a).toBeInstanceOf(HttpRuntime);
    expect(a).not.toBe(b);
    expect(a.kind).toBe("http");
    expect(a.status).toBe("closed");
    expect(sharedHttpHost(CONNECTED.origin)).toBe(sharedHttpHost(CONNECTED.origin));
    expect(runtimeCapabilities(CONNECTED)).toEqual(HTTP_CAPABILITIES);
  });

  it("shows the shop's schedules when connected, and none of the groups only a runtime on this computer has", () => {
    expect(HTTP_CAPABILITIES).toEqual({ elsewhere: false, automations: true, plugins: false, restart: false, accounts: false, models: false });
  });

  it("is still the WebSocket adapter when the page names a URL (the e2e suite), whatever was chosen", () => {
    win.window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:5308/?token=e2e" };
    expect(runtimeKind(CONNECTED)).toBe("websocket");
    expect(createRuntime(CONNECTED)).toBeInstanceOf(BridgeClient);
  });

  it("reads the choice once: one saved later waits for the next start, as the store keeps the runtime it was built with", () => {
    const saved = new Map<string, string>([[RUNTIME_KEY, JSON.stringify(CONNECTED)]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    expect(startedRuntime()).toEqual(CONNECTED);
    expect(runtimeKind()).toBe("http");
    expect(can("automations")).toBe(true);
    saved.set(RUNTIME_KEY, JSON.stringify({ mode: "practice" }));
    expect(runtimeKind()).toBe("http");
    forgetStartedRuntime();
    expect(runtimeKind()).toBe("mock");
  });
});

describe("createRuntime", () => {
  it("is the in-process runtime by default, in a browser and inside the desktop shell alike", () => {
    expect(runtimeKind()).toBe("mock");
    expect(createRuntime()).toBeInstanceOf(MockRuntime);
    win.window = { __TAURI_INTERNALS__: {} };
    expect(runtimeKind()).toBe("mock");
    expect(createRuntime()).toBeInstanceOf(MockRuntime);
  });

  it("hands each caller its own client", () => {
    expect(createRuntime()).not.toBe(createRuntime());
  });

  it("is the WebSocket adapter only when the page names a URL (the e2e suite's stand-in)", () => {
    win.window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:5308/?token=e2e" };
    expect(runtimeKind()).toBe("websocket");
    const rt = createRuntime();
    expect(rt).toBeInstanceOf(BridgeClient);
    expect(rt.kind).toBe("websocket");
    expect(rt.status).toBe("closed"); // nothing is dialled until connect()
  });

  it("hides the feature groups the in-process runtime does not have, and shows them for a full runtime", () => {
    expect(runtimeCapabilities()).toEqual({ ...NO_CAPABILITIES, models: true });
    for (const f of ["elsewhere", "automations", "plugins", "restart", "accounts"] as const) expect(can(f), f).toBe(false);
    // the demo names models for its members, so its chat box has the model menu
    expect(can("models")).toBe(true);
    win.window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=x" };
    expect(runtimeCapabilities()).toEqual(ALL_CAPABILITIES);
    expect(can("plugins")).toBe(true);
  });
});
