// A snapshot of any app (item 104, docs/computer-use.md, "A snapshot of any app"). The key the person set in Settings ›
// Computer, pressed in any app, has the shell read that app's front window with computer use's own reader and rules, and
// mask what looks like a key, before anything reaches this page (src-tauri/src/computer/snap.rs). Here the page opens a
// new chat with Home's member (Buddy) whose box holds what was taken as a block the person reads, edits and sends, or
// not: nothing here sends. Without Accessibility, or for a window computer use never reads, one short line says why
// instead (SnapshotNotice.tsx), with the Open button Settings › Computer has.
//
// In a plain browser (dev, e2e) `window.__manutAppSnapshot(payload)` stands in for the shell's event, and with
// `window.__manutSnapshotMock` set, `window.__manutSnapshot` stands in for its two Settings commands.
import { useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { inTauri } from "../lib/tauri";
import { changes } from "../lib/changes";
import { getDraft, setDraft } from "../app/drafts";
import { handLoose, joinDraft, stashDraft } from "../app/stash";
import { getStore, selectSidebarBots, type Store } from "../state/store";
import { homeBot } from "../sidebar/menu";
import { threadKey } from "../threads/types";

/** A window as the shell took it: masked, cut and counted there. */
export interface AppSnapshot {
  kind: "snapshot";
  app: string;
  bundle: string;
  window: string;
  /** The window's elements, one a line, indented by depth. */
  text: string;
  elements: number;
  /** The window holds more than this. */
  cut: boolean;
  /** Token-like strings the shell masked as `••••`. */
  masked: number;
  /** Approval links whose token the shell took out. */
  links: number;
  /** Password fields named and never read. */
  secure: number;
  /** A PNG of the window in base64, when the person asked for pictures and Screen capture is on. */
  picture?: string;
  /** A picture was asked for and none was taken. */
  noPicture: boolean;
}

/** Why nothing was read. */
export type NothingWhy = "own" | "noFront" | "noWindow" | "locked" | "unread";

/** What a press of the key took. */
export type Taken =
  | AppSnapshot
  | { kind: "needs"; what: "accessibility" }
  | { kind: "refused"; app: string; ownPage: boolean }
  | { kind: "nothing"; why: NothingWhy };

/** The longest text this page takes from the shell (which cuts at 8,000), and the largest picture (base64 of the shell's
 *  picture cap, 6 MB of PNG). */
const TEXT_MAX = 10_000;
const PICTURE_CHARS = 8_400_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NOTHING: readonly NothingWhy[] = ["own", "noFront", "noWindow", "locked", "unread"];

/** Invisible format characters (Unicode's Cf): the shell takes them out, and the page again, so the block reads as it is. */
const clean = (v: string) => v.replace(/\p{Cf}/gu, "");
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** `v` as what the shell took, or null when it is not one this page can show whole. */
export function readTaken(v: unknown): Taken | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? clean(x) : null);
  if (c.kind === "needs") return c.what === "accessibility" ? { kind: "needs", what: "accessibility" } : null;
  if (c.kind === "nothing") return NOTHING.includes(c.why as NothingWhy) ? { kind: "nothing", why: c.why as NothingWhy } : null;
  if (c.kind === "refused") {
    const app = str(c.app);
    return app ? { kind: "refused", app, ownPage: c.ownPage === true } : null;
  }
  if (c.kind !== "snapshot") return null;
  const app = str(c.app);
  const text = str(c.text);
  if (!app || text === null || text.length > TEXT_MAX) return null;
  const picture = typeof c.picture === "string" && c.picture.length <= PICTURE_CHARS && BASE64.test(c.picture) ? c.picture : undefined;
  return {
    kind: "snapshot",
    app,
    bundle: str(c.bundle) ?? "",
    window: str(c.window) ?? "",
    text,
    elements: count(c.elements),
    cut: c.cut === true,
    masked: count(c.masked),
    links: count(c.links),
    secure: count(c.secure),
    ...(picture ? { picture } : {}),
    noPicture: c.noPicture === true,
  };
}

/** A fence longer than any run of backticks in `text`, so the window's own text can never close the block. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The block a snapshot puts in the new chat's box, in the person's language: where it is from, that the app copied it and
 * that it is not the person speaking and gives no permission (as another chat's context says, chat/box/threadContext.ts),
 * what was hidden and whether it was cut, the window's lines in a fence, and a line that ends it. The person reads and
 * edits all of it, and types their ask after it.
 */
export function snapshotDraft(s: AppSnapshot): string {
  const lines = [t("snap.head", { app: s.app, window: s.window }), t("snap.fence")];
  if (s.masked > 0) lines.push(t("snap.masked", { n: s.masked }));
  if (s.links > 0) lines.push(t("snap.links", { n: s.links }));
  if (s.secure > 0) lines.push(t("snap.secure", { n: s.secure }));
  if (s.cut) lines.push(t("snap.cut"));
  if (s.picture) lines.push(t("snap.withPicture"));
  else if (s.noPicture) lines.push(t("snap.noPicture"));
  const body = s.text.trim() ? s.text : t("snap.empty");
  const fence = fenceFor(body);
  return [...lines, fence, body, fence, t("snap.end", { app: s.app })].join("\n");
}

/** The picture as a file the box holds, named for its app. */
export function pictureFile(s: AppSnapshot): File | null {
  if (!s.picture) return null;
  const bin = atob(s.picture);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const name = `${s.app.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "window"}.png`;
  return new File([bytes], name, { type: "image/png" });
}

// ---- the line shown when nothing was read -----------------------------------------------------------------------------

/** What the notice says: Accessibility is needed, a window that is never read, nothing to read, or kept in Drafts. */
export type Notice = Exclude<Taken, AppSnapshot> | { kind: "kept" };

let notice: Notice | null = null;
const noticeFns = changes();

export function showNotice(n: Notice | null): void {
  notice = n;
  noticeFns.emitSnapshot();
}

export function useSnapshotNotice(): Notice | null {
  return useSyncExternalStore(
    (l) => noticeFns.subscribe(l),
    () => notice,
    () => notice,
  );
}

/** The notice's words. */
export function noticeText(n: Notice): string {
  switch (n.kind) {
    case "needs":
      return t("snap.needAccess");
    case "refused":
      return n.ownPage ? t("snap.ownPage", { app: n.app }) : t("snap.refused", { app: n.app });
    case "nothing":
      return t(`snap.nothing.${n.why}` as Key);
    case "kept":
      return t("snap.kept");
  }
}

// ---- opening it ---------------------------------------------------------------------------------------------------

/** What opening a snapshot needs from the app, handed in so a test can stand in for it. Nothing here sends. */
export interface Opening {
  /** Home's member, whose new chat the snapshot opens in; null with no team. */
  home(): string | null;
  /** A new, empty chat with `bot`, opened; null when it could not be made. */
  newThread(bot: string): Promise<string | null>;
  /** Put `text` and `files` in chat `key`'s box as its unsent draft. */
  draft(key: string, text: string, files: File[]): void;
  /** Keep `text` in Drafts on Home, and show Home. */
  keep(text: string): Promise<void>;
  notice(n: Notice | null): void;
}

/** Where a snapshot went: a new chat's box, Drafts on Home, or a notice. */
export type Opened = { to: "chat"; key: string } | { to: "drafts" } | { to: "notice" };

/** Opens what the shell took: a snapshot goes into a new chat's box as its draft, never sent; anything else is a notice. */
export async function openSnapshot(taken: Taken, o: Opening): Promise<Opened> {
  if (taken.kind !== "snapshot") {
    o.notice(taken);
    return { to: "notice" };
  }
  o.notice(null);
  const text = snapshotDraft(taken);
  const picture = pictureFile(taken);
  const bot = o.home();
  const thread = bot ? await o.newThread(bot) : null;
  if (bot && thread) {
    const key = threadKey(bot, thread);
    o.draft(key, text, picture ? [picture] : []);
    return { to: "chat", key };
  }
  // no chat could be made (no team yet, the runtime away): what was read is kept, never lost and never sent
  await o.keep(text);
  o.notice({ kind: "kept" });
  return { to: "drafts" };
}

/** The app's own way of opening a snapshot: Home's member, the store's new chat, the box's draft (`store`: the app's,
 *  or a test's). */
export function appOpening(store: Store = getStore()): Opening {
  return {
    home() {
      const s = store.getState();
      return homeBot(s.bots, selectSidebarBots(s).map((b) => b.name));
    },
    newThread: (bot) => store.actions.newThread(bot),
    draft(key, text, files) {
      // after anything the box already held, as a draft taken from Drafts goes (app/stash.ts `intoChat`)
      const all = joinDraft(getDraft(key), `${text}\n\n`);
      setDraft(key, all);
      handLoose(key, files);
      store.dispatch({ type: "ui.draft", bot: key, text: all });
    },
    async keep(text) {
      await stashDraft({ text, from: "home" }).catch(() => undefined);
      store.actions.openPage("home");
    },
    notice: showNotice,
  };
}

let started = false;

/** Once per page load: hear the shell's snapshots (in a browser, the stand-in `window.__manutAppSnapshot`). */
export function startSnapshots(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const open = (payload: unknown) => {
    const taken = readTaken(payload);
    return taken ? openSnapshot(taken, appOpening()) : Promise.resolve(null);
  };
  if (!inTauri()) {
    (window as unknown as { __manutAppSnapshot?: (p: unknown) => Promise<Opened | null> }).__manutAppSnapshot = open;
    return;
  }
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen("app-snapshot", (e) => void open(e.payload)))
    .catch(() => {
      started = false;
    });
}

// ---- Settings' key ------------------------------------------------------------------------------------------------

/** Where the key stands, as the shell says (snap.rs `Shown`). */
export interface SnapState {
  on: boolean;
  keys: string;
  /** The keys as a Mac menu shows them (`⌃⌥⌘M`). */
  shown: string;
  picture: boolean;
  status: "off" | "on" | "taken" | "invalid" | "elsewhere";
  why?: "format" | "key" | "modifiers" | "macos";
  suggested: string;
  suggestedShown: string;
}

export interface SnapShell {
  settings(): Promise<SnapState>;
  set(s: { on: boolean; keys: string; picture: boolean }): Promise<SnapState>;
}

/** The browser stand-in's state, the keys it treats as another app's, and each change asked of it (e2e). */
export interface SnapMock {
  state: SnapState;
  taken: string[];
  sets: { on: boolean; keys: string; picture: boolean }[];
}

type MockGlobals = { __manutSnapshotMock?: boolean; __manutSnapshot?: SnapMock };
const mockOn = () => typeof window !== "undefined" && !!(window as unknown as MockGlobals).__manutSnapshotMock;

/** The keys as a Mac menu shows them, from the form the shell keeps (`Control+Option+Command+M` is `⌃⌥⌘M`). */
export function shownKeys(keys: string): string {
  const sym: Record<string, string> = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
  const parts = keys.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => sym[p.toLowerCase()]);
  return mods.every(Boolean) ? `${["⌃", "⌥", "⇧", "⌘"].filter((s) => mods.includes(s)).join("")}${key.toUpperCase()}` : keys;
}

/** The keys a key press names, in the form the shell keeps: two or more modifiers and a letter or a digit, by the key's
 *  place (`KeyM`, `Digit1`), as macOS registers a hot key. Null until a letter or a digit is pressed. */
export function keysFromEvent(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
  if (!m) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Option", e.shiftKey && "Shift", e.metaKey && "Command"].filter(Boolean);
  return [...mods, m[1] ?? m[2]].join("+");
}

function mockShell(): SnapShell {
  const g = window as unknown as MockGlobals;
  const m: SnapMock = (g.__manutSnapshot ??= {
    state: { on: false, keys: "Control+Option+Command+M", shown: "⌃⌥⌘M", picture: false, status: "off", suggested: "Control+Option+Command+M", suggestedShown: "⌃⌥⌘M" },
    taken: [],
    sets: [],
  });
  return {
    async settings() {
      return { ...m.state };
    },
    async set(s) {
      m.sets.push(s);
      const status = !s.on ? "off" : m.taken.includes(s.keys) ? "taken" : "on";
      m.state = { ...m.state, ...s, shown: shownKeys(s.keys), status };
      return { ...m.state };
    },
  };
}

function tauriShell(): SnapShell {
  return {
    async settings() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<SnapState>("snapshot_settings");
    },
    async set(s) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<SnapState>("snapshot_set", s);
    },
  };
}

let shell: SnapShell | null = null;
/** The shell Settings uses, made once. */
export function getSnapShell(): SnapShell {
  shell ??= mockOn() && !inTauri() ? mockShell() : tauriShell();
  return shell;
}
