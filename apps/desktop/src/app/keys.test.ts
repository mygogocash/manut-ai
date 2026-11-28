// The shortcuts the person can set (item 99, keys.ts): this system's defaults, how a press is matched on any layout, which
// presses can become keys, which keys are refused and why, how they are kept on this Mac and read back, and that the app's
// shortcuts follow them.
import { beforeEach, describe, expect, it } from "vitest";
import { chordFromEvent, chordString, chordText, currentKeys, defaultKeys, forgetKeys, keysText, KEYS_KEY, matches, parseChord, parseKeys, reservedFor, resetKeys, setKeys, takenBy, type Chord } from "./keys";
import { shortcutFor } from "./shortcuts";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  forgetKeys();
});

type P = Parameters<typeof matches>[1];
const press = (key: string, code: string | undefined, m: Partial<P> = {}): P => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
const c = (code: string, m: Partial<Omit<Chord, "code">> = {}): Chord => ({ meta: false, ctrl: false, alt: false, shift: false, ...m, code });

describe("the defaults", () => {
  it("are ⌘ on macOS and Ctrl elsewhere, ⌘T only on macOS, and Ctrl+` on both", () => {
    expect(keysText(defaultKeys(true).search, true)).toBe("⌘K");
    expect(keysText(defaultKeys(false).search, false)).toBe("Ctrl+K");
    expect(keysText(defaultKeys(true)["new-session"], true)).toBe("⌘N · ⌘T");
    expect(keysText(defaultKeys(false)["new-session"], false)).toBe("Ctrl+N");
    expect(keysText(defaultKeys(true).terminal, true)).toBe("⌃`");
    expect(keysText(defaultKeys(true).graph, true)).toBe("⇧⌘G");
    expect(keysText(defaultKeys(false)["session-next"], false)).toBe("Ctrl+Shift+]");
    // find in the chat in view (item 150): the key a terminal's own find has, which the terminal keeps while it has the keyboard
    expect(keysText(defaultKeys(true).find, true)).toBe("⌘F");
    expect(keysText(defaultKeys(false).find, false)).toBe("Ctrl+F");
    // the side menu, as ChatGPT's
    expect(keysText(defaultKeys(true).sidebar, true)).toBe("⇧⌘S");
    expect(keysText(defaultKeys(false).sidebar, false)).toBe("Ctrl+Shift+S");
  });
});

describe("a press matches a chord", () => {
  it("with the same modifiers only", () => {
    expect(matches(c("KeyK", { meta: true }), press("k", "KeyK", { metaKey: true }))).toBe(true);
    expect(matches(c("KeyK", { meta: true }), press("k", "KeyK", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(matches(c("KeyK", { meta: true }), press("k", "KeyK", { ctrlKey: true }))).toBe(false);
  });
  it("by the letter on a Latin layout (Dvorak's K is ⌘K), and by where it stands on another script's layout", () => {
    expect(matches(c("KeyK", { meta: true }), press("k", "KeyV", { metaKey: true }))).toBe(true);
    expect(matches(c("KeyT", { meta: true }), press("ㅅ", "KeyT", { metaKey: true }))).toBe(true);
    expect(matches(c("KeyT", { meta: true }), press("ㅅ", "KeyS", { metaKey: true }))).toBe(false);
  });
  it("the backquote only where it stands, whatever it prints; other keys where they stand or by their character", () => {
    expect(matches(c("Backquote", { ctrl: true }), press("₩", "Backquote", { ctrlKey: true }))).toBe(true);
    expect(matches(c("Backquote", { ctrl: true }), press("`", "Equal", { ctrlKey: true }))).toBe(false);
    expect(matches(c("Backquote", { ctrl: true }), press("`", undefined, { ctrlKey: true }))).toBe(true);
    expect(matches(c("BracketRight", { meta: true, shift: true }), press("}", "BracketRight", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(matches(c("Period", { meta: true }), press(".", undefined, { metaKey: true }))).toBe(true);
    expect(matches(c("F5"), press("F5", "F5"))).toBe(true);
  });
});

describe("a press that sets keys", () => {
  it("needs ⌘, Ctrl or ⌥ with a key, or an F key alone; a lone modifier or a bare key is none", () => {
    expect(chordFromEvent(press("p", "KeyP", { metaKey: true }))).toEqual(c("KeyP", { meta: true }));
    expect(chordFromEvent(press("F6", "F6"))).toEqual(c("F6"));
    expect(chordFromEvent(press("p", "KeyP"))).toBeNull();
    expect(chordFromEvent(press("P", "KeyP", { shiftKey: true }))).toBeNull();
    expect(chordFromEvent(press("Meta", "MetaLeft", { metaKey: true }))).toBeNull();
    expect(chordFromEvent(press("PageUp", "PageUp", { metaKey: true }))).toBeNull();
  });
  it("is refused when macOS or the window keep it, text editing does, or it opens a team member", () => {
    expect(reservedFor(c("KeyQ", { meta: true }), true)).toBe("system");
    expect(reservedFor(c("KeyW", { meta: true }), true)).toBe("system");
    expect(reservedFor(c("KeyC", { meta: true }), true)).toBe("editing");
    expect(reservedFor(c("KeyZ", { meta: true, shift: true }), true)).toBe("editing");
    expect(reservedFor(c("Digit3", { meta: true }), true)).toBe("members");
    expect(reservedFor(c("KeyY", { ctrl: true }), false)).toBe("editing");
    expect(reservedFor(c("F4", { alt: true }), false)).toBe("system");
    expect(reservedFor(c("KeyP", { meta: true }), true)).toBeNull();
    expect(reservedFor(c("KeyC", { meta: true, alt: true }), true)).toBeNull();
  });
  it("names the action that already has it", () => {
    expect(takenBy(defaultKeys(true), "details", c("KeyK", { meta: true }))).toBe("search");
    expect(takenBy(defaultKeys(true), "search", c("KeyK", { meta: true }))).toBeNull();
    expect(takenBy(defaultKeys(true), "details", c("KeyF", { meta: true }))).toBe("find");
  });
});

describe("the person's keys on this Mac", () => {
  it("are kept as text, read back checked, and an action or chord that cannot be read keeps its default", () => {
    expect(parseChord(chordString(c("KeyG", { meta: true, shift: true })))).toEqual(c("KeyG", { meta: true, shift: true }));
    expect(parseChord("Hyper+KeyG")).toBeNull();
    expect(parseChord("Meta+Meta+KeyG")).toBeNull();
    expect(parseChord("Meta+PageUp")).toBeNull();
    expect(parseKeys(JSON.stringify({ search: ["Meta+KeyP"], details: ["Meta+KeyC"], nope: ["Meta+KeyX"], settings: "x" }), true)).toEqual({ search: [c("KeyP", { meta: true })] });
    expect(parseKeys("{not json", true)).toEqual({});
  });

  it("set, kept, followed by the shortcuts, refused when taken or reserved, and reset", () => {
    expect(setKeys("search", [c("KeyP", { meta: true })], true)).toEqual({ ok: true });
    expect(JSON.parse(storage.get(KEYS_KEY)!)).toEqual({ search: ["Meta+KeyP"] });
    expect(shortcutFor(press("p", "KeyP", { metaKey: true }), true)).toEqual({ kind: "search" });
    expect(shortcutFor(press("k", "KeyK", { metaKey: true }), true)).toBeNull();
    // read again from storage, as after a restart
    forgetKeys();
    expect(keysText(currentKeys(true).search, true)).toBe("⌘P");
    expect(setKeys("details", [c("KeyP", { meta: true })], true)).toEqual({ ok: false, why: "taken", by: "search" });
    expect(setKeys("details", [c("KeyQ", { meta: true })], true)).toEqual({ ok: false, why: "system" });
    resetKeys("search");
    expect(keysText(currentKeys(true).search, true)).toBe("⌘K");
    expect(storage.has(KEYS_KEY)).toBe(false);
    setKeys("graph", [c("KeyG", { meta: true, alt: true })], true);
    setKeys("settings", [c("F2")], true);
    resetKeys();
    expect(currentKeys(true)).toEqual(defaultKeys(true));
  });

  it("a setting is written as macOS shows keys, and as Windows and Linux do", () => {
    expect(chordText(c("KeyG", { meta: true, alt: true, shift: true, ctrl: true }), true)).toBe("⌃⌥⇧⌘G");
    expect(chordText(c("ArrowUp", { ctrl: true, alt: true }), false)).toBe("Ctrl+Alt+↑");
  });
});
