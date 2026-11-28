// Keys shown where their actions are (item 167d, keyHints.ts): the key shown is the one the person set, drawn for the keyboard it
// is on, a key with no binding shows nothing, and a tooltip is then only its words.
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { chordAria, chordCaps, chordText, currentKeys, defaultKeys, forgetKeys, KEYS_KEY, resetKeys, setKeys, type Chord } from "./keys";
import { enterName, keyedProps, keyShown, useKeys, useKeyShown, withKey } from "./keyHints";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  forgetKeys();
  setLang("en");
});
afterEach(() => vi.unstubAllGlobals());

const c = (code: string, m: Partial<Omit<Chord, "code">> = {}): Chord => ({ meta: false, ctrl: false, alt: false, shift: false, ...m, code });
const mac = (on: boolean) => vi.stubGlobal("navigator", { platform: on ? "MacIntel" : "Linux x86_64" });

describe("a chord drawn for this keyboard", () => {
  it("is a cap for each key: ⌃⌥⇧⌘ in Apple's order on a Mac, Ctrl, Alt and Shift by name elsewhere", () => {
    const all = c("KeyG", { meta: true, alt: true, shift: true, ctrl: true });
    expect(chordCaps(all, true)).toEqual(["⌃", "⌥", "⇧", "⌘", "G"]);
    expect(chordCaps(all, false)).toEqual(["Ctrl", "Win", "Alt", "Shift", "G"]);
    expect(chordCaps(c("Slash", { meta: true }), true)).toEqual(["⌘", "/"]);
    expect(chordCaps(c("ArrowUp", { ctrl: true, alt: true }), false)).toEqual(["Ctrl", "Alt", "↑"]);
  });

  it("reads the same as its text, which Settings has always written", () => {
    for (const code of ["KeyK", "Digit5", "Period", "Backquote", "F5", "Enter", "ArrowLeft"]) {
      for (const on of [true, false]) {
        const ch = c(code, { meta: true, shift: true });
        expect(chordText(ch, on), `${code} ${on}`).toBe(chordCaps(ch, on).join(on ? "" : "+"));
      }
    }
    expect(chordText(c("KeyG", { meta: true, shift: true }), true)).toBe("⇧⌘G");
    expect(chordText(c("KeyG", { ctrl: true, shift: true }), false)).toBe("Ctrl+Shift+G");
  });

  it("is written for assistive technology as WAI-ARIA's aria-keyshortcuts does: Control, Alt, Shift and Meta, then the key", () => {
    expect(chordAria(c("KeyK", { meta: true }))).toBe("Meta+K");
    expect(chordAria(c("KeyG", { meta: true, shift: true }))).toBe("Shift+Meta+G");
    expect(chordAria(c("Backquote", { ctrl: true }))).toBe("Control+`");
    expect(chordAria(c("Slash", { ctrl: true }))).toBe("Control+/");
    expect(chordAria(c("Comma", { meta: true }))).toBe("Meta+,");
    expect(chordAria(c("Digit4", { alt: true }))).toBe("Alt+4");
    expect(chordAria(c("BracketRight", { meta: true, shift: true }))).toBe("Shift+Meta+]");
    expect(chordAria(c("ArrowUp", { meta: true, alt: true }))).toBe("Alt+Meta+ArrowUp");
    expect(chordAria(c("F5"))).toBe("F5");
    expect(chordAria(c("Space", { ctrl: true }))).toBe("Control+Space");
  });
});

describe("the key an action is shown with", () => {
  it("is this system's default until the person sets one: ⌘K on a Mac, Ctrl+K elsewhere", () => {
    expect(keyShown(defaultKeys(true), "search", true)).toEqual({ caps: ["⌘", "K"], text: "⌘K", aria: "Meta+K" });
    expect(keyShown(defaultKeys(false), "search", false)).toEqual({ caps: ["Ctrl", "K"], text: "Ctrl+K", aria: "Control+K" });
    // the key sheet's own key is ⌘/ (item 167d)
    expect(keyShown(defaultKeys(true), "key-sheet", true)?.text).toBe("⌘/");
  });

  it("is the first of an action's keys, its main one: ⌘N of ⌘N and ⌘T", () => {
    expect(keyShown(defaultKeys(true), "new-session", true)?.text).toBe("⌘N");
  });

  it("is the one the person set, and follows when they change it and when they put it back", () => {
    setKeys("details", [c("KeyB", { meta: true })], true);
    expect(keyShown(currentKeys(true), "details", true)?.text).toBe("⌘B");
    // read again from this Mac's storage, as after a restart
    forgetKeys();
    expect(keyShown(currentKeys(true), "details", true)?.text).toBe("⌘B");
    expect(keyShown(currentKeys(true), "search", true)?.text).toBe("⌘K");
    resetKeys("details");
    expect(keyShown(currentKeys(true), "details", true)?.text).toBe("⌘.");
  });

  it("is nothing for an action the person gave no key", () => {
    storage.set(KEYS_KEY, JSON.stringify({ search: [] }));
    forgetKeys();
    expect(currentKeys(true).search).toEqual([]);
    expect(keyShown(currentKeys(true), "search", true)).toBeNull();
    // the others are as they were
    expect(keyShown(currentKeys(true), "settings", true)?.text).toBe("⌘,");
  });
});

describe("a button's tooltip", () => {
  it("is its words with the key after them, in the language's own brackets", () => {
    const shown = keyShown(defaultKeys(true), "details", true);
    expect(withKey("Details", shown)).toBe("Details (⌘.)");
    setLang("ja");
    expect(withKey("詳細", shown)).toBe("詳細（⌘.）");
    setLang("zh");
    expect(withKey("详情", shown)).toBe("详情（⌘.）");
    setLang("ko");
    expect(withKey("상세", shown)).toBe("상세 (⌘.)");
  });

  it("is only its words when the action has no key, and then names no key to assistive technology either", () => {
    expect(withKey("Search", null)).toBe("Search");
    expect(keyedProps("Search", null)).toStrictEqual({ title: "Search" });
    expect(keyedProps("Search", keyShown(defaultKeys(false), "search", false))).toEqual({ title: "Search (Ctrl+K)", "aria-keyshortcuts": "Control+K" });
  });

  it("names Return as the keyboard does", () => {
    expect(enterName(true)).toBe("Return");
    expect(enterName(false)).toBe("Enter");
  });
});

describe("what draws a key follows the person's keys", () => {
  function Probe() {
    const keys = useKeys();
    const shown = useKeyShown("sidebar");
    return <p data-n={Object.keys(keys).length}>{shown ? shown.text : "no key"}</p>;
  }
  const html = () => renderToString(<Probe />);

  it("reads the keys of this keyboard, and draws the new one after a change, a reset and a removal", () => {
    mac(true);
    expect(html()).toContain("⇧⌘S");
    setKeys("sidebar", [c("KeyB", { meta: true, alt: true })], true);
    expect(html()).toContain("⌥⌘B");
    resetKeys("sidebar");
    expect(html()).toContain("⇧⌘S");
    storage.set(KEYS_KEY, JSON.stringify({ sidebar: [] }));
    forgetKeys();
    expect(html()).toContain("no key");
    mac(false);
    storage.clear();
    forgetKeys();
    expect(html()).toContain("Ctrl+Shift+S");
  });
});
