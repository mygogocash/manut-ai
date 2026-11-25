// Ctrl+` (the bottom terminal panel) on every OS, by the physical key, and never while an input method composes.
import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";
import { closePalette, openPalette, paletteOpen } from "../palette/state";

type K = Parameters<typeof shortcutFor>[0];
const k = (key: string, code: string | undefined, m: Partial<K> = {}): K => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });

describe("Ctrl+` opens the terminal panel", () => {
  it("is Ctrl+` on macOS and on Windows/Linux alike", () => {
    for (const mac of [true, false]) {
      expect(shortcutFor(k("`", "Backquote", { ctrlKey: true }), mac)).toEqual({ kind: "terminal" });
    }
  });

  it("goes by the key's place, so non-US layouts work (Korean, German, French, Japanese)", () => {
    for (const mac of [true, false]) {
      // Korean 2-set: the same key, but the layout may report ₩ or ` ; German: ^ ; French AZERTY: ²
      for (const key of ["`", "₩", "^", "²", "Dead", "半角/全角"]) {
        expect(shortcutFor(k(key, "Backquote", { ctrlKey: true }), mac), `${key} mac=${mac}`).toEqual({ kind: "terminal" });
      }
    }
    // an engine with no `code`: the character decides
    expect(shortcutFor(k("`", undefined, { ctrlKey: true }), false)).toEqual({ kind: "terminal" });
  });

  it("is not ⌘`, Ctrl+Shift+`, Ctrl+Alt+` or a plain `", () => {
    expect(shortcutFor(k("`", "Backquote", { metaKey: true }), true)).toBeNull();
    expect(shortcutFor(k("~", "Backquote", { ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(k("`", "Backquote", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutFor(k("`", "Backquote", { ctrlKey: true, metaKey: true }), true)).toBeNull();
    expect(shortcutFor(k("`", "Backquote"), true)).toBeNull();
    // another key that prints ` on some layout is not the shortcut
    expect(shortcutFor(k("`", "Equal", { ctrlKey: true }), false)).toBeNull();
  });

  it("does nothing while an input method is composing", () => {
    expect(shortcutFor(k("`", "Backquote", { ctrlKey: true, isComposing: true }), true)).toBeNull();
    expect(shortcutFor(k("Process", "Backquote", { ctrlKey: true, keyCode: 229 }), false)).toBeNull();
  });

  it("leaves ⌘J as next-ask (not the terminal)", () => {
    expect(shortcutFor(k("j", "KeyJ", { metaKey: true }), true)).toEqual({ kind: "next-ask" });
    expect(shortcutFor(k("j", "KeyJ", { ctrlKey: true }), false)).toEqual({ kind: "next-ask" });
  });
});

describe("⌘⇧[ ] step order", () => {
  it("follows the sidebar: one folder spelled with and without a trailing slash is one group", async () => {
    const { terminalOrder } = await import("./shortcuts");
    const rows = [
      { id: "a", cwd: "/w/app/" },
      { id: "b", cwd: "/w/other" },
      { id: "c", cwd: "/w/app" },
    ];
    expect(terminalOrder(rows, [])).toEqual(["a", "c", "b"]);
    expect(terminalOrder(rows, ["/w/other"])).toEqual(["b", "a", "c"]);
  });
});

describe("the shortcuts while the first-run setup fills the window", () => {
  it("change nothing behind it, the terminal included, and work again once it ends", async () => {
    const { getStore } = await import("../state/store");
    const { getTermPanel } = await import("../terminal/state");
    const { isMac, onShortcutKey, onTerminalKey } = await import("./shortcuts");
    const store = getStore();
    await store.actions.init();
    // the test node keeps nothing, so this is a first run
    expect(store.getState().ui.firstRun?.screen).toBe("welcome");
    const mod = isMac() ? { metaKey: true } : { ctrlKey: true };
    const press = (e: K) => {
      const ev = { ...e, target: null, repeat: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent;
      onTerminalKey(ev);
      onShortcutKey(ev);
    };
    const before = store.getState();
    press(k("k", "KeyK", mod)); // the command palette
    press(k(",", "Comma", mod)); // Settings
    press(k("2", "Digit2", mod)); // the second member's chat
    press(k("`", "Backquote", { ctrlKey: true })); // the terminal panel
    expect(store.getState()).toBe(before);
    expect(getTermPanel().open).toBe(false);
    expect(paletteOpen()).toBe(false);
    store.actions.firstRunEnd();
    press(k("k", "KeyK", mod));
    // the palette opens over the page; it does not move to History any more
    expect(paletteOpen()).toBe(true);
    expect(store.getState().ui.view).not.toBe("history");
    closePalette();
  });
});

describe("⌘K and the command palette", () => {
  const mod = (isMac: boolean) => (isMac ? { metaKey: true } : { ctrlKey: true });
  const press = async (e: K, target: unknown = null) => {
    const { onShortcutKey } = await import("./shortcuts");
    onShortcutKey({ ...e, target, repeat: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
  };
  const ready = async () => {
    const { getStore } = await import("../state/store");
    const store = getStore();
    await store.actions.init();
    store.actions.firstRunEnd();
    closePalette({ restore: false });
    return store;
  };

  it("opens on ⌘K and closes on a second ⌘K, with the focus given back", async () => {
    await ready();
    const { isMac } = await import("./shortcuts");
    const focus = { calls: 0, isConnected: true, focus() { this.calls += 1; } };
    openPalette(focus);
    expect(paletteOpen()).toBe(true);
    await press(k("k", "KeyK", mod(isMac())));
    expect(paletteOpen()).toBe(false);
    expect(focus.calls).toBe(1);
  });

  it("is not opened by ⌘K while an input method composes", async () => {
    const { isMac } = await import("./shortcuts");
    await ready();
    await press(k("k", "KeyK", { ...mod(isMac()), isComposing: true }));
    await press(k("Process", "KeyK", { ...mod(isMac()), keyCode: 229 }));
    expect(paletteOpen()).toBe(false);
  });

  it("is not opened from a terminal, which keeps the key", async () => {
    const { isMac } = await import("./shortcuts");
    await ready();
    const inXterm = { closest: (sel: string) => (sel === ".xterm" ? {} : null) };
    await press(k("k", "KeyK", mod(isMac())), inXterm);
    expect(paletteOpen()).toBe(false);
  });

  it("leaves every other shortcut to the palette's field while it is open", async () => {
    const { isMac } = await import("./shortcuts");
    const store = await ready();
    openPalette(null);
    const view = store.getState().ui.view;
    await press(k(",", "Comma", mod(isMac())));
    await press(k("2", "Digit2", mod(isMac())));
    expect(store.getState().ui.view).toBe(view);
    closePalette({ restore: false });
  });
});
