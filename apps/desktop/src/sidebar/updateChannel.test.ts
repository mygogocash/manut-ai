import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANNEL_EVENT, FEEDS, feedFor, parseChannel, setUpdateChannel, updateChannel } from "./updateChannel";
import { tauriHost } from "./updater";

/** A stand-in for the page's storage: the real one is per browser, and the node test has none. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

const shellFile = (name: string) => readFileSync(fileURLToPath(new URL(`../../src-tauri/${name}`, import.meta.url)), "utf8");

describe("the update channel setting", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is Stable until the person chooses Nightly, and Nightly only for the exact word", () => {
    expect(updateChannel()).toBe("stable");
    expect(parseChannel("nightly")).toBe("nightly");
    for (const odd of [null, undefined, "", "Nightly", "beta", "stable", "nightly ", "1"]) expect(parseChannel(odd)).toBe("stable");
  });

  it("keeps the choice on this Mac and Stable is the absence of a choice", () => {
    setUpdateChannel("nightly");
    expect(updateChannel()).toBe("nightly");
    expect((localStorage as unknown as ReturnType<typeof memoryStorage>).data.get("manut.update.channel")).toBe("nightly");
    setUpdateChannel("stable");
    expect(updateChannel()).toBe("stable");
    expect((localStorage as unknown as ReturnType<typeof memoryStorage>).data.size).toBe(0);
  });

  it("tells a watching button when it changes", () => {
    const heard: number[] = [];
    window.addEventListener(CHANNEL_EVENT, () => heard.push(1));
    setUpdateChannel("nightly");
    setUpdateChannel("stable");
    expect(heard).toHaveLength(2);
  });

  it("falls back to Stable when the storage cannot be read or written", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(updateChannel()).toBe("stable");
    expect(() => setUpdateChannel("nightly")).not.toThrow();
  });
});

describe("the feed each channel reads", () => {
  it("is latest.json under the newest published release for Stable, and nightly.json under the fixed nightly release", () => {
    expect(feedFor("stable")).toBe("https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json");
    expect(feedFor("nightly")).toBe("https://github.com/mygogocash/manut-ai/releases/download/nightly/nightly.json");
  });

  it("is the same address the shell reads: tauri.conf.json for Stable and update_channel.rs for each", () => {
    const conf = JSON.parse(shellFile("tauri.conf.json"));
    expect(conf.plugins.updater.endpoints).toEqual([FEEDS.stable]);
    const rust = shellFile("src/update_channel.rs");
    expect(rust).toContain(`pub const STABLE_FEED: &str = "${FEEDS.stable}";`);
    expect(rust).toContain(`pub const NIGHTLY_FEED: &str = "${FEEDS.nightly}";`);
  });

  it("is not offered in the Mac App Store edition, which makes no updater files", () => {
    expect(JSON.parse(shellFile("tauri.appstore.conf.json")).bundle.createUpdaterArtifacts).toBe(false);
    expect(readFileSync(fileURLToPath(new URL("../settings/Settings.slot.tsx", import.meta.url)), "utf8")).toMatch(/isAppStore\(\) \? \([\s\S]*?\) : \([\s\S]*?<UpdateChannelSeg \/>/);
  });
});

describe("a check on each channel", () => {
  const sent: [string, Record<string, unknown>][] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          sent.push([cmd, args]);
          return null;
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Stable asks the plugin's own check, which reads tauri.conf.json's endpoint, and names no channel", async () => {
    expect(await tauriHost().check()).toBeNull();
    expect(sent.map(([cmd]) => cmd)).toEqual(["plugin:updater|check"]);
    expect(sent[0][1]).not.toHaveProperty("channel");
  });

  it("Nightly asks the shell's own command with the channel's name and never an address", async () => {
    setUpdateChannel("nightly");
    expect(await tauriHost().check()).toBeNull();
    expect(sent).toEqual([["check_update_channel", { channel: "nightly", timeout: 30_000 }]]);
    expect(JSON.stringify(sent)).not.toContain("http");
  });

  it("goes back to the plugin's check when the person goes back to Stable", async () => {
    setUpdateChannel("nightly");
    setUpdateChannel("stable");
    await tauriHost().check();
    expect(sent.map(([cmd]) => cmd)).toEqual(["plugin:updater|check"]);
  });

  it("turns the shell's answer into the plugin's own update, so download and install are the plugin's", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push([cmd, args]);
          if (cmd === "check_update_channel") return { rid: 7, currentVersion: "0.1.1", version: "0.1.2-nightly.20261127", rawJson: {} };
          return 8;
        },
        transformCallback: () => 1,
      },
    });
    setUpdateChannel("nightly");
    const pending = await tauriHost().check();
    expect(pending?.version).toBe("0.1.2-nightly.20261127");
    await pending!.install(() => {});
    // the plugin's own command, for the resource the shell stored (tauri-plugin-updater 2.14.1, commands.rs)
    expect(calls.map(([cmd]) => cmd)).toEqual(["check_update_channel", "plugin:updater|download_and_install"]);
    expect(calls[1][1]).toMatchObject({ rid: 7 });
  });
});
