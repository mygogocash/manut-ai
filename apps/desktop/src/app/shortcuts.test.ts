// Ctrl+` (the bottom terminal panel) on every OS, by the physical key, and never while an input method composes.
import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";
import { defaultKeys } from "./keys";
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
    // a chat on screen behind the setup (item 150): ⌘F must not open its bar there either
    const { registerFindHost } = await import("../chat/find/host");
    const chat = { opened: 0, holds: () => true, shown: () => true, open() { this.opened += 1; }, close() {}, isOpen: () => false };
    const leave = registerFindHost(chat);
    const before = store.getState();
    press(k("k", "KeyK", mod)); // the command palette
    press(k(",", "Comma", mod)); // Settings
    press(k("2", "Digit2", mod)); // the second member's chat
    press(k("`", "Backquote", { ctrlKey: true })); // the terminal panel
    press(k("f", "KeyF", mod)); // find in the chat
    expect(store.getState()).toBe(before);
    expect(getTermPanel().open).toBe(false);
    expect(paletteOpen()).toBe(false);
    expect(chat.opened).toBe(0);
    store.actions.firstRunEnd();
    press(k("f", "KeyF", mod));
    expect(chat.opened).toBe(1);
    leave();
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

describe("⌘F and the chat's find (item 150)", () => {
  const mod = (mac: boolean) => (mac ? { metaKey: true } : { ctrlKey: true });
  const fakeHost = () => {
    const h = { opened: 0, holds: () => true, shown: () => true, open() { this.opened += 1; }, close() {}, isOpen: () => false };
    return h;
  };
  /** Press ⌘F (Ctrl+F off macOS) at `target`; true when the page's own handling of the key was stopped. */
  const press = async (target: unknown = null, e: Partial<K> = {}, defaultPrevented = false) => {
    const { isMac, onShortcutKey } = await import("./shortcuts");
    let prevented = false;
    const ev = { ...k("f", "KeyF", { ...mod(isMac()), ...e }), target, repeat: false, defaultPrevented, preventDefault() { prevented = true; }, stopPropagation() {} };
    onShortcutKey(ev as unknown as KeyboardEvent);
    return prevented;
  };
  const ready = async () => {
    const { getStore } = await import("../state/store");
    const store = getStore();
    await store.actions.init();
    store.actions.firstRunEnd();
    closePalette({ restore: false });
  };
  const inside = (...kept: string[]) => ({ closest: (sel: string) => (sel.split(/\s*,\s*/).some((s) => kept.includes(s)) ? {} : null) });

  it("is ⌘F on macOS and Ctrl+F elsewhere, by the letter or, on another script's layout, by where F stands", () => {
    expect(shortcutFor(k("f", "KeyF", { metaKey: true }), true)).toEqual({ kind: "find" });
    expect(shortcutFor(k("f", "KeyF", { ctrlKey: true }), false)).toEqual({ kind: "find" });
    // Korean 2-set, Thai Kedmanee and a Dvorak F: the key is where F stands, or the letter F is
    expect(shortcutFor(k("ㄹ", "KeyF", { metaKey: true }), true)).toEqual({ kind: "find" });
    expect(shortcutFor(k("ด", "KeyF", { ctrlKey: true }), false)).toEqual({ kind: "find" });
    expect(shortcutFor(k("f", "KeyY", { metaKey: true }), true)).toEqual({ kind: "find" });
  });

  it("is a later default than any key a person set: ⌘F they gave to another action stays that action's", () => {
    const own = { ...defaultKeys(true), details: [{ meta: true, ctrl: false, alt: false, shift: false, code: "KeyF" }] };
    expect(shortcutFor(k("f", "KeyF", { metaKey: true }), true, own)).toEqual({ kind: "details" });
    expect(shortcutFor(k("f", "KeyF", { metaKey: true }), true, defaultKeys(true))).toEqual({ kind: "find" });
  });

  it("is not ⌘⇧F, ⌘⌥F, Ctrl+F on a Mac or ⌘F elsewhere, and not while an input method composes", () => {
    expect(shortcutFor(k("F", "KeyF", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(k("ƒ", "KeyF", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(shortcutFor(k("f", "KeyF", { ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(k("f", "KeyF", { metaKey: true }), false)).toBeNull();
    expect(shortcutFor(k("f", "KeyF", { metaKey: true, isComposing: true }), true)).toBeNull();
  });

  it("opens the bar of a chat that is on screen, from its box or from anywhere, and the key stops there", async () => {
    await ready();
    const { registerFindHost } = await import("../chat/find/host");
    const chat = fakeHost();
    const off = registerFindHost(chat);
    expect(await press(inside())).toBe(true);
    expect(await press(null)).toBe(true);
    expect(chat.opened).toBe(2);
    off();
  });

  it("does nothing, and leaves the key alone, with no chat on screen", async () => {
    await ready();
    expect(await press(null)).toBe(false);
    expect(await press(inside())).toBe(false);
  });

  it("is a terminal's, and the terminal's find bar's: the chat's bar does not open over either", async () => {
    await ready();
    const { registerFindHost } = await import("../chat/find/host");
    const chat = fakeHost();
    const off = registerFindHost(chat);
    expect(await press(inside(".xterm"))).toBe(false);
    expect(await press(inside(".tfind"))).toBe(false);
    // a terminal that took the key for its own find says so with preventDefault, wherever the key went
    expect(await press(null, {}, true)).toBe(false);
    expect(chat.opened).toBe(0);
    off();
  });

  it("is a field's or a pane's that has a find of its own, and an open menu's, list's or dialog's", async () => {
    await ready();
    const { registerFindHost } = await import("../chat/find/host");
    const chat = fakeHost();
    const off = registerFindHost(chat);
    // the pane beside a lane (code/LanePane.tsx) marks itself; so will the files pane and its editor
    for (const own of ["[data-own-find]", ".cfind", "[role=dialog]", "[role=menu]", "[role=listbox]"]) expect(await press(inside(own)), own).toBe(false);
    expect(chat.opened).toBe(0);
    off();
  });

  it("is not the chat's while the palette is open or while an input method composes", async () => {
    await ready();
    const { registerFindHost } = await import("../chat/find/host");
    const chat = fakeHost();
    const off = registerFindHost(chat);
    openPalette(null);
    expect(await press(null)).toBe(false);
    closePalette({ restore: false });
    expect(await press(null, { isComposing: true })).toBe(false);
    expect(chat.opened).toBe(0);
    off();
  });
});
