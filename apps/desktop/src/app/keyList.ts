// Every key the app has, by group, for the key sheet (item 167d, src/keysheet) and for Settings › General › Keyboard's fixed rows:
// the keys the person can set (keys.ts), as they set them, and the keys that are fixed because the terminal, its panes and an
// approval card take them themselves (⌘1 to ⌘9, Esc, a card's 1, 2 and 3 and the terminal's own). Paradev's keyboard page groups
// its 90 actions as Navigation, Workspace, Layout, Terminal, Chat, Window and Help (`R/hotkeys/registry.ts`, MIT); this app has far
// fewer keys, so five groups hold them.
//
// Pure, so a test reads the whole list for either platform without a DOM.
import { t, type Key } from "../i18n";
import { matches } from "../palette/filter";
import { ACTION_WORDS } from "../settings/KeysRows";
import { chordText, KEY_ACTIONS, type KeyAction, type Keys } from "./keys";

export type KeyGroup = "go" | "chat" | "panels" | "terminals" | "help";

/** In the order the sheet lists them: where to go, the chat, the panels and menu, the terminals, and the sheet's own help. */
export const KEY_GROUPS: readonly KeyGroup[] = ["go", "chat", "panels", "terminals", "help"];

export const GROUP_WORDS: Record<KeyGroup, Key> = {
  go: "keysheet.group.go",
  chat: "keysheet.group.chat",
  panels: "keysheet.group.panels",
  terminals: "keysheet.group.terminals",
  help: "keysheet.group.help",
};

/** The group each settable action is listed under. A `Record` over every action, so one added to keys.ts without a group does not
 *  type-check, and the sheet never lacks one. */
export const GROUP_OF: Record<KeyAction, KeyGroup> = {
  search: "go",
  settings: "go",
  "next-ask": "go",
  find: "chat",
  details: "panels",
  sidebar: "panels",
  graph: "panels",
  terminal: "panels",
  "new-session": "terminals",
  "session-next": "terminals",
  "session-prev": "terminals",
  "key-sheet": "help",
};

/** A key the app takes itself, written as Settings has always written it. */
export interface FixedKey {
  readonly keys: string;
  readonly what: Key;
  readonly group: KeyGroup;
}

/** ⌘1 to ⌘9, which open the Team page's first nine members: Settings lists it before the keys the person can set. */
export const membersKey = (mac: boolean): FixedKey => ({ keys: mac ? "⌘1 … ⌘9" : "Ctrl+1 … Ctrl+9", what: "key.openBot", group: "go" });

/** The other fixed keys, in the order Settings lists them after the ones the person can set: the terminal panel's pane keys and its
 *  text keys (macOS and the others differ, as the terminal does), an approval card's own 1, 2 and 3, and Esc. */
export function fixedKeys(mac: boolean): FixedKey[] {
  const f = (keys: string, what: Key, group: KeyGroup = "terminals"): FixedKey => ({ keys, what, group });
  return [
    f(mac ? "⌘D · ⌘⇧D" : "Ctrl+Shift+D · Alt+Shift+D", "key.splitPane"),
    f(mac ? "⌘W" : "Ctrl+Shift+W", "key.closePane"),
    f(mac ? "⌘⌥ ←↑↓→" : "Ctrl+Alt+ ←↑↓→", "key.focusPane"),
    f(mac ? "⌘] · ⌘[" : "Ctrl+Tab · Ctrl+Shift+Tab", "key.stepPane"),
    f(mac ? "⌘⇧⌥ ←↑↓→" : "Ctrl+Alt+Shift+ ←↑↓→", "key.movePane"),
    f(mac ? "⌘⇧↩" : "Ctrl+Shift+Enter", "key.zoomPane"),
    f(mac ? "⌘⌃=" : "Ctrl+Alt+=", "key.equalizePanes"),
    f(mac ? "⌘= · ⌘- · ⌘0" : "Ctrl+= · Ctrl+- · Ctrl+0", "key.termFont"),
    ...(mac
      ? [f("⌘← · ⌘→ · ⌘⌫ · ⌘⌦", "key.termLine"), f("⌥← · ⌥→", "key.termWord"), f("⌘K", "key.termClear")]
      : [f("Ctrl+Shift+C · Ctrl+Shift+V · Ctrl+Insert · Shift+Insert", "key.termCopyPaste")]),
    f(mac ? "⌘Home · ⌘End" : "Ctrl+Home · Ctrl+End", "key.termScroll"),
    f(mac ? "⌘⇧C" : "Alt+Shift+C", "key.copyLink"),
    // the card's own keys, taken by the focused card (src/chat/cards) and never by the app: the sheet only says so
    f("1 · 2 · 3", "key.cardKeys", "chat"),
    f("Esc", "key.stop", "chat"),
  ];
}

export interface SheetRow {
  readonly id: string;
  readonly label: string;
  /** the text of each key the row has, as Settings writes it; none for a key the person gave no key */
  readonly keys: readonly string[];
  /** set for a key the person can set: the sheet offers Change, which opens its row in Settings › General › Keyboard */
  readonly action?: KeyAction;
}

export interface SheetGroup {
  readonly group: KeyGroup;
  readonly heading: Key;
  readonly rows: readonly SheetRow[];
}

/** The sheet for what is typed: every key the app has under its group, the settable ones first (as they are now, the person's own
 *  or the default) and then the fixed ones. A search keeps the rows whose words or keys hold every word typed, and a group with no
 *  row left is left out. */
export function sheetGroups(keys: Keys, mac: boolean, query = ""): SheetGroup[] {
  const settable = KEY_ACTIONS.map((a): [KeyGroup, SheetRow] => [GROUP_OF[a], { id: `key:${a}`, label: t(ACTION_WORDS[a]), keys: keys[a].map((c) => chordText(c, mac)), action: a }]);
  const fixed = [membersKey(mac), ...fixedKeys(mac)].map((k): [KeyGroup, SheetRow] => [k.group, { id: `fixed:${k.what}`, label: t(k.what), keys: [k.keys] }]);
  const all = [...settable, ...fixed];
  return KEY_GROUPS.map((group) => ({
    group,
    heading: GROUP_WORDS[group],
    rows: all.filter(([g, row]) => g === group && matches(`${row.label} ${row.keys.join(" ")}`, query)).map(([, row]) => row),
  })).filter((g) => g.rows.length > 0);
}
