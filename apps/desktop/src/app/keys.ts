// The app-wide shortcuts the person can set (item 99): each action's keys, as defaults for this computer's system and the
// person's own choices, kept on this Mac only (`manut.keys`, never sent). `shortcuts.ts` reads them for every key press, and
// Settings › General's Keyboard list sets them.
//
// A chord is the exact modifiers held and one key, named by where it stands (`KeyboardEvent.code`): a letter is still matched
// by the letter it types on a Latin layout (so Dvorak's ⌘K is the K key), and by where it stands on another script's layout
// (Korean, Thai, Russian); the backquote only by where it stands, as layouts print other characters there; any other key by
// where it stands or by the character it types. Fixed, and never set here: ⌘1 to ⌘9 (team members), Esc (stop), an approval
// card's 1, 2 and 3, and the terminal's and split panes' own keys. Keys macOS or text editing keep (⌘Q, ⌘W, ⌘C and the like)
// are refused, and so are keys another action already has.
//
// Pure but for the small store at the end, so a test reads every rule without a DOM.
import { changes } from "../lib/changes";

export type KeyAction = "search" | "details" | "settings" | "next-ask" | "graph" | "new-session" | "session-next" | "session-prev" | "terminal" | "sidebar";

/** In the order Settings lists them. */
export const KEY_ACTIONS: readonly KeyAction[] = ["search", "details", "settings", "next-ask", "new-session", "session-next", "session-prev", "sidebar", "graph", "terminal"];

export interface Chord {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Where the key stands: `KeyK`, `Digit5`, `Period`, `BracketRight`, `Backquote`, `F5` */
  readonly code: string;
}

export type Keys = Readonly<Record<KeyAction, readonly Chord[]>>;

/** The keys a chord may end in: letters, digits, the punctuation keys, F1 to F12, and a few named keys. */
const CODE = /^(Key[A-Z]|Digit[0-9]|Period|Comma|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote|F([1-9]|1[0-2])|Enter|Space|Arrow(Up|Down|Left|Right))$/;

/** The characters each punctuation and digit key types, for a press that names no key (an engine with no `code`). */
const CHARS: Record<string, readonly string[]> = {
  Period: ["."],
  Comma: [","],
  Slash: ["/", "?"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  Backquote: ["`"],
  Enter: ["Enter"],
  Space: [" "],
  ArrowUp: ["ArrowUp"],
  ArrowDown: ["ArrowDown"],
  ArrowLeft: ["ArrowLeft"],
  ArrowRight: ["ArrowRight"],
};

const chord = (code: string, m: Partial<Omit<Chord, "code">> = {}): Chord => ({ meta: false, ctrl: false, alt: false, shift: false, ...m, code });
/** ⌘ on macOS, Ctrl elsewhere. */
const modOf = (mac: boolean) => (mac ? { meta: true } : { ctrl: true });

/** Each action's keys on this system before the person changes any. */
export function defaultKeys(mac: boolean): Keys {
  const m = modOf(mac);
  return {
    search: [chord("KeyK", m)],
    details: [chord("Period", m)],
    settings: [chord("Comma", m)],
    "next-ask": [chord("KeyJ", m)],
    graph: [chord("KeyG", { ...m, shift: true })],
    // ⌘T too on macOS, like a new tab; Ctrl+T elsewhere stays a terminal program's (transpose)
    "new-session": mac ? [chord("KeyN", m), chord("KeyT", m)] : [chord("KeyN", m)],
    "session-next": [chord("BracketRight", { ...m, shift: true })],
    "session-prev": [chord("BracketLeft", { ...m, shift: true })],
    // Ctrl on macOS too, as in VS Code
    terminal: [chord("Backquote", { ctrl: true })],
    // the side menu, shown or hidden, as ChatGPT's ⌘⇧S (the owner, 27 Nov 2026)
    sidebar: [chord("KeyS", { ...m, shift: true })],
  };
}

export const sameChord = (a: Chord, b: Chord) => a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code;

type Press = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** Whether press `e` is chord `c`: the same modifiers exactly, and its key by the rules above. */
export function matches(c: Chord, e: Press): boolean {
  if (e.metaKey !== c.meta || e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  const letter = /^Key([A-Z])$/.exec(c.code)?.[1]?.toLowerCase();
  if (letter) return e.key.toLowerCase() === letter || (!/^[a-z]$/i.test(e.key) && e.code === c.code);
  if (c.code === "Backquote") return e.code ? e.code === "Backquote" : e.key === "`";
  const digit = /^Digit([0-9])$/.exec(c.code)?.[1];
  if (digit) return e.code ? e.code === c.code : e.key === digit;
  if (/^F([1-9]|1[0-2])$/.test(c.code)) return e.key === c.code || e.code === c.code;
  return e.code === c.code || (CHARS[c.code] ?? []).includes(e.key);
}

/** The chord a press sets, or null: a lone modifier, a key no chord may end in, or no ⌘, Ctrl or ⌥ held (a bare key or
 *  ⇧ with a key would take what the person types), except an F key, which types nothing. */
export function chordFromEvent(e: Press): Chord | null {
  const code = e.code ?? "";
  if (!CODE.test(code)) return null;
  const c = chord(code, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  if (!c.meta && !c.ctrl && !c.alt && !/^F/.test(code)) return null;
  return c;
}

/** Why a chord cannot be set, or null: macOS or the window keep it, text editing does, or it opens a team member. */
export function reservedFor(c: Chord, mac: boolean): "system" | "editing" | "members" | null {
  const mod = mac ? c.meta && !c.ctrl : c.ctrl && !c.meta;
  const only = mod && !c.alt;
  if (only && !c.shift && /^Digit[1-9]$/.test(c.code)) return "members";
  if (mac && only && !c.shift && ["KeyQ", "KeyW", "KeyH", "KeyM"].includes(c.code)) return "system";
  if (mac && c.meta && c.alt && !c.ctrl && !c.shift && c.code === "KeyH") return "system";
  if (!mac && c.alt && !c.ctrl && !c.meta && !c.shift && c.code === "F4") return "system";
  if (!mac && only && c.shift && c.code === "KeyW") return "system";
  if (only && !c.shift && ["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ"].includes(c.code)) return "editing";
  if (only && c.shift && c.code === "KeyZ") return "editing";
  if (!mac && only && !c.shift && c.code === "KeyY") return "editing";
  return null;
}

/** The other action that already has chord `c`, if one does. */
export function takenBy(keys: Keys, action: KeyAction, c: Chord): KeyAction | null {
  return KEY_ACTIONS.find((a) => a !== action && keys[a].some((k) => sameChord(k, c))) ?? null;
}

const KEY_LABEL: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Enter: "↩",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const keyLabel = (code: string) => /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? KEY_LABEL[code] ?? code;

/** A chord as the person reads it: `⌘⇧G` on macOS (⌃⌥⇧⌘ in Apple's order), `Ctrl+Shift+G` elsewhere. */
export function chordText(c: Chord, mac: boolean): string {
  const k = keyLabel(c.code);
  if (mac) return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${k}`;
  return [c.ctrl && "Ctrl", c.meta && "Win", c.alt && "Alt", c.shift && "Shift", k].filter(Boolean).join("+");
}

/** An action's keys as Settings shows them: `⌘N · ⌘T`. */
export const keysText = (cs: readonly Chord[], mac: boolean) => cs.map((c) => chordText(c, mac)).join(" · ");

/** A chord as it is kept: `Meta+Shift+KeyG`. */
export const chordString = (c: Chord) => [c.ctrl && "Ctrl", c.meta && "Meta", c.alt && "Alt", c.shift && "Shift", c.code].filter(Boolean).join("+");

export function parseChord(s: unknown): Chord | null {
  if (typeof s !== "string" || s.length > 40) return null;
  const parts = s.split("+");
  const code = parts.pop() ?? "";
  if (!CODE.test(code)) return null;
  const mods = new Set(parts);
  if (parts.some((p) => !["Ctrl", "Meta", "Alt", "Shift"].includes(p)) || mods.size !== parts.length) return null;
  return chord(code, { ctrl: mods.has("Ctrl"), meta: mods.has("Meta"), alt: mods.has("Alt"), shift: mods.has("Shift") });
}

/** The person's own keys as kept (`{ action: ["Meta+KeyK"] }`, an empty list for none), each checked as it is read: an action
 *  or a chord that cannot be read is left out, and its default stays. */
export function parseKeys(raw: string | null, mac: boolean): Partial<Record<KeyAction, Chord[]>> {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Partial<Record<KeyAction, Chord[]>> = {};
  for (const a of KEY_ACTIONS) {
    const list = (v as Record<string, unknown>)[a];
    if (!Array.isArray(list) || list.length > 4) continue;
    const chords = list.map(parseChord);
    if (chords.some((c) => !c || reservedFor(c, mac))) continue;
    out[a] = chords as Chord[];
  }
  return out;
}

// ---- the person's keys on this Mac ------------------------------------------------------------------------------------

export const KEYS_KEY = "manut.keys";
const isMacHere = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const listeners = changes();
let own: Partial<Record<KeyAction, Chord[]>> | null = null;

function readOwn(): Partial<Record<KeyAction, Chord[]>> {
  if (own) return own;
  try {
    own = parseKeys(typeof localStorage !== "undefined" ? localStorage.getItem(KEYS_KEY) : null, isMacHere());
  } catch {
    own = {};
  }
  return own;
}

function saveOwn(next: Partial<Record<KeyAction, Chord[]>>): void {
  own = next;
  try {
    const kept = Object.fromEntries(Object.entries(next).map(([a, cs]) => [a, (cs ?? []).map(chordString)]));
    if (Object.keys(kept).length) localStorage.setItem(KEYS_KEY, JSON.stringify(kept));
    else localStorage.removeItem(KEYS_KEY);
  } catch {
    /* no storage: the keys hold until the app closes */
  }
  listeners.emitSnapshot();
}

/** Every action's keys now: the person's own, else the default. */
export function currentKeys(mac: boolean = isMacHere()): Keys {
  const d = defaultKeys(mac);
  const o = readOwn();
  return Object.fromEntries(KEY_ACTIONS.map((a) => [a, o[a] ?? d[a]])) as unknown as Keys;
}

/** Sets an action's keys, after the same checks Settings makes: refused (with why) when a chord is kept by the system or
 *  text editing, or another action has it. */
export function setKeys(action: KeyAction, chords: readonly Chord[], mac: boolean = isMacHere()): { ok: true } | { ok: false; why: "system" | "editing" | "members" | "taken"; by?: KeyAction } {
  const keys = currentKeys(mac);
  for (const c of chords) {
    const reserved = reservedFor(c, mac);
    if (reserved) return { ok: false, why: reserved };
    const by = takenBy(keys, action, c);
    if (by) return { ok: false, why: "taken", by };
  }
  saveOwn({ ...readOwn(), [action]: [...chords] });
  return { ok: true };
}

/** An action back to its default keys, or every action when none is named. */
export function resetKeys(action?: KeyAction): void {
  if (!action) return saveOwn({});
  const next = { ...readOwn() };
  delete next[action];
  saveOwn(next);
}

export const onKeysChange = (fn: () => void) => listeners.subscribe(fn);

/** While Settings waits for the person to press an action's new keys, no shortcut acts on what they press (shortcuts.ts). */
let recording = false;
export const keysRecording = () => recording;
export function setKeysRecording(on: boolean): void {
  recording = on;
}
/** For tests: forget what was read, so the next read is from storage. */
export function forgetKeys(): void {
  own = null;
}
