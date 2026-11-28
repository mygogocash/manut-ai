// The key sheet's list (item 167d, keyList.ts): every registered action by group as the person has set it, then the fixed keys,
// searched by the words and by the keys shown, and the fixed keys as Settings › General › Keyboard has always listed them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { currentKeys, defaultKeys, forgetKeys, KEYS_KEY, KEY_ACTIONS, setKeys, type Chord } from "./keys";
import { fixedKeys, GROUP_OF, GROUP_WORDS, KEY_GROUPS, membersKey, sheetGroups } from "./keyList";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  forgetKeys();
  setLang("en");
});
afterEach(() => setLang("en"));

const c = (code: string, m: Partial<Omit<Chord, "code">> = {}): Chord => ({ meta: false, ctrl: false, alt: false, shift: false, ...m, code });
const rowsOf = (groups: ReturnType<typeof sheetGroups>) => groups.flatMap((g) => g.rows);

describe("the groups", () => {
  it("name a group for every action keys.ts registers, so none is missing from the sheet", () => {
    expect(Object.keys(GROUP_OF).sort()).toEqual([...KEY_ACTIONS].sort());
    for (const a of KEY_ACTIONS) expect(KEY_GROUPS, a).toContain(GROUP_OF[a]);
    for (const g of KEY_GROUPS) expect(GROUP_WORDS[g], g).toMatch(/^keysheet\.group\./);
  });
});

describe("the sheet lists every key", () => {
  it("each registered action once, under its group, in the groups' order, with the keys the person has", () => {
    const groups = sheetGroups(defaultKeys(true), true);
    expect(groups.map((g) => g.group)).toEqual([...KEY_GROUPS]);
    const settable = rowsOf(groups).filter((r) => r.action);
    expect(settable.map((r) => r.action).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([...KEY_ACTIONS].sort((a, b) => a.localeCompare(b)));
    for (const g of groups) for (const r of g.rows) if (r.action) expect(GROUP_OF[r.action], r.id).toBe(g.group);
    const row = (a: string) => settable.find((r) => r.action === a)!;
    expect(row("search").keys).toEqual(["⌘K"]);
    // ⌘N and ⌘T both open the + menu, and both are listed
    expect(row("new-session").keys).toEqual(["⌘N", "⌘T"]);
    expect(row("key-sheet").keys).toEqual(["⌘/"]);
    expect(row("key-sheet").label).toBe("Show every shortcut");
  });

  it("is drawn for the keyboard: Ctrl+K and Ctrl+Shift+S off a Mac", () => {
    const rows = rowsOf(sheetGroups(defaultKeys(false), false));
    expect(rows.find((r) => r.action === "search")!.keys).toEqual(["Ctrl+K"]);
    expect(rows.find((r) => r.action === "sidebar")!.keys).toEqual(["Ctrl+Shift+S"]);
  });

  it("lists the key the person set, not the default, and None for an action they gave no key", () => {
    setKeys("details", [c("KeyB", { meta: true })], true);
    storage.set(KEYS_KEY, JSON.stringify({ ...JSON.parse(storage.get(KEYS_KEY)!), find: [] }));
    forgetKeys();
    const rows = rowsOf(sheetGroups(currentKeys(true), true));
    expect(rows.find((r) => r.action === "details")!.keys).toEqual(["⌘B"]);
    expect(rows.find((r) => r.action === "find")!.keys).toEqual([]);
  });

  it("lists the fixed keys after the settable ones of their group, with no action to change", () => {
    const groups = sheetGroups(defaultKeys(true), true);
    const fixed = rowsOf(groups).filter((r) => !r.action);
    // ⌘1 to ⌘9, Esc, a card's 1, 2 and 3, and the terminal's own: all of Settings' fixed rows
    expect(fixed.map((r) => r.keys[0]).sort()).toEqual([membersKey(true).keys, ...fixedKeys(true).map((k) => k.keys)].sort());
    const chat = groups.find((g) => g.group === "chat")!.rows;
    expect(chat.map((r) => r.keys[0])).toContain("1 · 2 · 3");
    expect(chat.map((r) => r.keys[0])).toContain("Esc");
    // a group lists what is settable first
    for (const g of groups) {
      const firstFixed = g.rows.findIndex((r) => !r.action);
      if (firstFixed >= 0) expect(g.rows.slice(firstFixed).every((r) => !r.action), g.group).toBe(true);
    }
    const terminals = groups.find((g) => g.group === "terminals")!.rows;
    expect(terminals.find((r) => r.id === "fixed:key.splitPane")!.keys).toEqual(["⌘D · ⌘⇧D"]);
  });

  it("has a row id for each key that is its own", () => {
    const ids = rowsOf(sheetGroups(defaultKeys(true), true)).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("speaks the app's language", () => {
    setLang("ja");
    const groups = sheetGroups(defaultKeys(true), true);
    expect(rowsOf(groups).find((r) => r.action === "settings")!.label).toBe("設定");
  });
});

describe("the sheet's search", () => {
  const all = sheetGroups(defaultKeys(true), true);
  const ids = (q: string) => rowsOf(sheetGroups(defaultKeys(true), true, q)).map((r) => r.id);

  it("keeps every row for nothing typed, and drops the groups with no row left", () => {
    expect(rowsOf(sheetGroups(defaultKeys(true), true, "  ")).length).toBe(rowsOf(all).length);
    const found = sheetGroups(defaultKeys(true), true, "find in a chat");
    expect(found.map((g) => g.group)).toEqual(["chat"]);
    expect(found[0]!.rows.map((r) => r.action)).toEqual(["find"]);
  });

  it("finds by the words shown, every word in any order and in any case", () => {
    expect(ids("TERMINAL panel bottom")).toEqual(["key:terminal"]);
    expect(ids("shortcut every")).toEqual(["key:key-sheet"]);
    const terminal = ids("terminal");
    expect(terminal).toContain("key:terminal");
    expect(terminal).toContain("fixed:key.splitPane");
    expect(terminal).not.toContain("key:search");
  });

  it("finds by the keys shown, as the person reads them", () => {
    expect(ids("⇧⌘S")).toEqual(["key:sidebar"]);
    // ⌘K is the palette's, and the terminal's own Clear
    expect(ids("⌘K").sort()).toEqual(["fixed:key.termClear", "key:search"]);
  });

  it("says nothing is found with no group at all", () => {
    expect(sheetGroups(defaultKeys(true), true, "zzzzzz")).toEqual([]);
  });
});

describe("the fixed keys, as Settings › General › Keyboard listed them before the sheet", () => {
  it("are the same strings, in the same order, for a Mac and for the others", () => {
    expect(fixedKeys(true).map((k) => [k.keys, k.what])).toEqual([
      ["⌘D · ⌘⇧D", "key.splitPane"],
      ["⌘W", "key.closePane"],
      ["⌘⌥ ←↑↓→", "key.focusPane"],
      ["⌘] · ⌘[", "key.stepPane"],
      ["⌘⇧⌥ ←↑↓→", "key.movePane"],
      ["⌘⇧↩", "key.zoomPane"],
      ["⌘⌃=", "key.equalizePanes"],
      ["⌘= · ⌘- · ⌘0", "key.termFont"],
      ["⌘← · ⌘→ · ⌘⌫ · ⌘⌦", "key.termLine"],
      ["⌥← · ⌥→", "key.termWord"],
      ["⌘K", "key.termClear"],
      ["⌘Home · ⌘End", "key.termScroll"],
      ["⌘⇧C", "key.copyLink"],
      ["1 · 2 · 3", "key.cardKeys"],
      ["Esc", "key.stop"],
    ]);
    expect(fixedKeys(false).map((k) => [k.keys, k.what])).toEqual([
      ["Ctrl+Shift+D · Alt+Shift+D", "key.splitPane"],
      ["Ctrl+Shift+W", "key.closePane"],
      ["Ctrl+Alt+ ←↑↓→", "key.focusPane"],
      ["Ctrl+Tab · Ctrl+Shift+Tab", "key.stepPane"],
      ["Ctrl+Alt+Shift+ ←↑↓→", "key.movePane"],
      ["Ctrl+Shift+Enter", "key.zoomPane"],
      ["Ctrl+Alt+=", "key.equalizePanes"],
      ["Ctrl+= · Ctrl+- · Ctrl+0", "key.termFont"],
      ["Ctrl+Shift+C · Ctrl+Shift+V · Ctrl+Insert · Shift+Insert", "key.termCopyPaste"],
      ["Ctrl+Home · Ctrl+End", "key.termScroll"],
      ["Alt+Shift+C", "key.copyLink"],
      ["1 · 2 · 3", "key.cardKeys"],
      ["Esc", "key.stop"],
    ]);
    expect(membersKey(true).keys).toBe("⌘1 … ⌘9");
    expect(membersKey(false).keys).toBe("Ctrl+1 … Ctrl+9");
  });

  it("leave an approval card's 1, 2 and 3 to the card: listed, never an action the app can take", () => {
    expect(fixedKeys(true).find((k) => k.what === "key.cardKeys")!.group).toBe("chat");
    // the digits are not in the registry of keys the app takes for itself
    for (const a of KEY_ACTIONS) for (const ch of defaultKeys(true)[a]) expect(ch.code, a).not.toMatch(/^Digit[123]$/);
  });
});
