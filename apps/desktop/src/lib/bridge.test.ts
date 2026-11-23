// A runtime that died and came back listens on a new port with a new token: the WebSocket adapter asks for the URL
// again before every dial instead of retrying the one it had. (Oh My Hermes also asked its shell's `bridge_url`
// command here; Manut AI's shell starts no bridge, so that path and its test are gone.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeClient, bridgeUrlConfigured, resolveBridgeUrl } from "./bridge";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const OLD = "ws://127.0.0.1:51001/?token=aaa";
const NEW = "ws://127.0.0.1:51002/?token=bbb";
const win = globalThis as unknown as { window?: Record<string, unknown> };

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});

afterEach(() => {
  vi.useRealTimers();
  delete win.window;
});

const client = () => new BridgeClient({ WebSocketImpl: FakeSocket as unknown as typeof WebSocket, minDelay: 10, maxDelay: 40 });

describe("reconnect after the bridge comes back", () => {
  it("with no URL configured nothing is dialled: the app is on its in-process runtime", async () => {
    expect(bridgeUrlConfigured()).toBe(false);
    await expect(resolveBridgeUrl()).rejects.toThrow("no WebSocket runtime is configured");
    // inside the desktop shell too: there is no shell command to ask for a URL any more
    win.window = { __TAURI_INTERNALS__: {} };
    expect(bridgeUrlConfigured()).toBe(false);
    win.window = { __MANUT_BRIDGE_URL__: async () => OLD };
    expect(bridgeUrlConfigured()).toBe(true);
    await expect(resolveBridgeUrl()).resolves.toBe(OLD);
  });

  it("in the e2e page: asks the __MANUT_BRIDGE_URL__ stand-in again", async () => {
    let url = OLD;
    const standIn = vi.fn(async () => url);
    win.window = { __MANUT_BRIDGE_URL__: standIn };
    const b = client();
    const opened = b.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0].open();
    await opened;
    url = NEW;
    FakeSocket.all[0].drop();
    await vi.advanceTimersByTimeAsync(50);
    expect(standIn).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all.map((s) => s.url)).toEqual([OLD, NEW]);
    b.close();
  });

  it("a fixed URL option stays fixed (peers, tests)", async () => {
    const b = new BridgeClient({ url: OLD, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, minDelay: 10, maxDelay: 40 });
    const opened = b.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0].open();
    await opened;
    FakeSocket.all[0].drop();
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.all.map((s) => s.url)).toEqual([OLD, OLD]);
    b.close();
  });
});
