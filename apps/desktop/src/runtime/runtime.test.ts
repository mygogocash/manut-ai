// Which runtime the app picks: the in-process one unless a WebSocket URL was configured on purpose.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../lib/bridge";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "./adapter";
import { can, createRuntime, runtimeCapabilities, runtimeKind } from "./index";
import { MockRuntime } from "./mock";

const win = globalThis as unknown as { window?: Record<string, unknown> };

afterEach(() => {
  delete win.window;
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
    expect(runtimeCapabilities()).toEqual(NO_CAPABILITIES);
    for (const f of ["elsewhere", "automations", "plugins", "restart", "accounts"] as const) expect(can(f), f).toBe(false);
    win.window = { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=x" };
    expect(runtimeCapabilities()).toEqual(ALL_CAPABILITIES);
    expect(can("plugins")).toBe(true);
  });
});
