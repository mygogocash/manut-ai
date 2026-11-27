// What this computer keeps for the view model (the look, the theme, the pinned bots and the roster), read
// tolerantly, and the first state built from it. Split out of store.ts (item 125d), which re-exports what it
// exported before.
import { readLang } from "../i18n";
import { firstRunEntry, ONBOARDED_KEY, startFlow } from "../onboarding/flow";
import { parseShop, SHOP_KEY } from "../onboarding/shop";
import type { Bot } from "../lib/protocol";
import { isThemeId } from "../theme/themes";
import { BUBBLE_STYLES, CHAT_WIDTHS, PALETTES, type Theme, type Palette, type BubbleStyle, type ChatWidth, type Look, type AppState } from "./types";

/** The Chat board's look (item 85f): an answer on the page with only the person's message in a bubble ("open"), at
 *  the board's sizes ("medium": a 17px answer, a 15px message), in the brand's colours and the board's 696px column. */
export const DEFAULT_LOOK: Look = { palette: "manut", bubbles: "open", text: "medium", width: "medium" };
/** Saved looks carry this from item 85f on. A look saved before it held the old defaults (soft bubbles, small text)
 *  whenever the person changed anything else, since the whole look is saved at once: those two values meant "as the
 *  app draws it" and read as today's defaults. A choice made since is kept as it is. */
export const LOOK_VERSION = 2;

/** A saved look (`manut.look`), read tolerantly: an unknown value falls back to the default. The colours are the brand's
 *  or a theme id of the person's own (whether that theme is still kept is the theme's business: src/theme/apply.ts draws
 *  the brand's for one that is gone); a colour set the old picker saved is neither. The chat width was added without a
 *  new version: a look saved before it has none and reads as the medium it always drew. */
export function parseLook(raw: string | null): Look {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Look> & { v?: unknown }) : {};
    const before = v.v !== LOOK_VERSION;
    const bubbles = BUBBLE_STYLES.includes(v.bubbles as BubbleStyle) && !(before && v.bubbles === "soft") ? (v.bubbles as BubbleStyle) : DEFAULT_LOOK.bubbles;
    const text = v.text === "small" || v.text === "medium" || v.text === "large" ? (before && v.text === "small" ? DEFAULT_LOOK.text : v.text) : DEFAULT_LOOK.text;
    return {
      palette: PALETTES.includes(v.palette as Palette) || isThemeId(v.palette) ? (v.palette as Palette) : DEFAULT_LOOK.palette,
      bubbles,
      text,
      width: CHAT_WIDTHS.includes(v.width as ChatWidth) ? (v.width as ChatWidth) : DEFAULT_LOOK.width,
    };
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

/** What `manut.look` holds: the look and the version it was saved under. */
export const savedLook = (look: Look): string => JSON.stringify({ ...look, v: LOOK_VERSION });

function readLook(): Look {
  try {
    return parseLook(typeof localStorage !== "undefined" ? localStorage.getItem("manut.look") : null);
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

export function readList(key: string): string[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The saved roster, or null when this computer has none yet (a fresh install, or manut before the roster). */
function readRoster(): string[] | null {
  try {
    if (typeof localStorage === "undefined" || localStorage.getItem(ROSTER_KEY) === null) return null;
  } catch {
    return null;
  }
  return readList(ROSTER_KEY);
}

export const ROSTER_KEY = "manut.roster";

/** The first roster (no `manut.roster` yet): the bot saved for resume, then the pinned bots that still exist; with
 *  neither, the default profile (else the first bot). Bots the person hid from the old sidebar never enter it.
 *  `all`: with nothing saved, every bot joins, the default one first (`StoreOptions.firstRoster`). */
export function seedRoster(bots: readonly Bot[], resumeBot: string | null, pinned: readonly string[], hidden: readonly string[], all = false): string[] {
  const ok = (n: string | null): n is string => !!n && !hidden.includes(n) && bots.some((b) => b.name === n);
  const out: string[] = [];
  for (const n of [resumeBot, ...pinned]) if (ok(n) && !out.includes(n)) out.push(n);
  if (out.length) return out;
  const shown = bots.filter((b) => !hidden.includes(b.name));
  const first = shown.find((b) => b.is_default) ?? shown.find((b) => b.name === "default") ?? shown[0] ?? bots[0];
  if (!first) return [];
  return all ? [first.name, ...shown.filter((b) => b.name !== first.name).map((b) => b.name)] : [first.name];
}

export function saveList(key: string, v: string[]): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* no storage */
  }
}

export function readTheme(): Theme {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem("manut.theme") : null;
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* no storage */
  }
  return "system";
}

/** What this computer keeps under `key`, or null when it keeps nothing there or has no storage to read. */
function readStored(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* no storage, or full: the state still holds it for this run */
  }
}

export function initialState(): AppState {
  const shop = parseShop(readStored(SHOP_KEY));
  // A first run opens on the setup's Welcome, holding whatever an earlier run kept before it was quit halfway.
  const entry = firstRunEntry(readStored(ONBOARDED_KEY));
  return {
    conn: "closed",
    hello: null,
    lastError: null,
    bots: [],
    selectedBot: null,
    chats: {},
    unread: {},
    elsewhere: {},
    peeks: {},
    routines: {},
    automations: null,
    models: {},
    agentBox: {},
    replyTo: {},
    threads: {},
    shops: { list: [], current: null, left: [], dismissed: [], loaded: false },
    ui: {
      panelOpen: false,
      panelTab: "details",
      runId: null,
      panelMax: false,
      draft: null,
      theme: readTheme(),
      look: readLook(),
      view: "chat",
      back: "chat",
      findSeq: 0,
      findQuery: "",
      settingsPage: "general",
      pinned: readList("manut.pinned"),
      roster: readRoster(),
      focusAsk: null,
      session: null,
      thread: null,
      automation: null,
      job: null,
      pluginsBot: null,
      lang: readLang(),
      shop,
      firstRun: entry ? startFlow(entry, shop) : null,
    },
  };
}
