// Bringing over the person's own Claude Code and Codex work (item 101e): the rules the offer draws (ImportPast.tsx) and the
// small record this computer keeps of it (localStorage `manut.importPast`).
//
// The shell finds the folders those agents worked in on this Mac and counts each one's conversations
// (src-tauri/src/import_past.rs, read-only, with past_chats.rs's readers). Bringing a folder over adds it to the Code page's
// project list (sessions/folders.ts `addFolder`, the list New folder… and New project add to) and keeps it in this record, and
// History lists the newest conversations of the folders kept there, which open and continue as the + menu's past conversations
// do (sessions.ts `continuePast`). Nothing else is written: the agents' own files are never copied, moved, changed or deleted,
// and nothing leaves this computer.
//
// Everything here is pure but the record's store at the end, which only reads and writes this computer's storage.
import { useSyncExternalStore } from "react";
import { addedFolders, addFolder, pathKey, type FolderPrefs } from "../sessions/folders";

/** What the shell found (import_past.rs `Found`): the folders still on this Mac, newest first, and what it skipped. */
export interface ImportProject {
  cwd: string;
  claude: number;
  codex: number;
  /** the newest conversation's last change, seconds since the epoch */
  at: number;
}
export interface ImportSkipped {
  /** folders that are no longer on this Mac */
  gone: number;
  /** Codex conversations written compressed (`.jsonl.zst`) that could not be unpacked: corrupt or cut short (item 106b); the rest are read like plain ones */
  compressed: number;
  /** files that could not be read: a link, a file that cannot be opened, one that is not JSON lines */
  unreadable: number;
  /** older conversations past the look's bounds */
  over_limit: number;
}
export interface ImportFound {
  projects: ImportProject[];
  skipped: ImportSkipped;
  partial: boolean;
}

export const NO_SKIPS: ImportSkipped = { gone: 0, compressed: 0, unreadable: 0, over_limit: 0 };

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** The shell's answer, checked: a project whose folder is not an absolute path, or that has no conversation, is left out. */
export function readFound(v: unknown): ImportFound | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.projects)) return null;
  const s = (o.skipped && typeof o.skipped === "object" ? o.skipped : {}) as Record<string, unknown>;
  const projects = o.projects.flatMap((p): ImportProject[] => {
    if (!p || typeof p !== "object") return [];
    const x = p as Record<string, unknown>;
    const cwd = typeof x.cwd === "string" ? x.cwd : "";
    const claude = count(x.claude);
    const codex = count(x.codex);
    if (!(cwd.startsWith("/") || /^[A-Za-z]:[\\/]|^\\\\/.test(cwd)) || claude + codex === 0) return [];
    return [{ cwd, claude, codex, at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : 0 }];
  });
  return {
    projects,
    skipped: { gone: count(s.gone), compressed: count(s.compressed), unreadable: count(s.unreadable), over_limit: count(s.over_limit) },
    partial: o.partial === true,
  };
}

/** A found folder as the offer lists it. `here`: it is on the Code page's list already, so bringing it over adds nothing. */
export interface OfferRow extends ImportProject {
  /** its conversations, both agents together */
  total: number;
  here: boolean;
}

/** The found folders, newest first, each marked when it is listed already (`listed`: the Code page's folders, by `pathKey`).
 *  A folder found twice under two spellings is one row. */
export function offerRows(found: ImportFound, listed: readonly string[]): OfferRow[] {
  const have = new Set(listed.map(pathKey));
  const seen = new Set<string>();
  return [...found.projects]
    .sort((a, b) => b.at - a.at)
    .flatMap((p) => {
      const cwd = pathKey(p.cwd);
      if (seen.has(cwd)) return [];
      seen.add(cwd);
      return [{ ...p, cwd, total: p.claude + p.codex, here: have.has(cwd) }];
    });
}

/** Whether the offer has anything to bring: a found folder that is not listed yet. */
export const hasNew = (rows: readonly OfferRow[]): boolean => rows.some((r) => !r.here);

/** The offer's steps: looking (by hand only; on a first launch the offer opens only once something was found), what was found
 *  with the person's picks, the confirmation of those picks, and what was brought over. */
export type ImportStep =
  | { at: "looking" }
  | { at: "failed"; why: string }
  | { at: "pick"; rows: OfferRow[]; skipped: ImportSkipped; partial: boolean; picked: string[] }
  | { at: "confirm"; rows: OfferRow[]; skipped: ImportSkipped; partial: boolean; picked: string[] }
  | { at: "done"; brought: string[]; conversations: number };

export type ImportEvent =
  | { type: "found"; found: ImportFound; listed: readonly string[] }
  | { type: "failed"; why: string }
  | { type: "toggle"; cwd: string }
  | { type: "all"; on: boolean }
  | { type: "next" }
  | { type: "back" }
  | { type: "brought"; brought: string[]; conversations: number };

/** The picks in the order the list shows them, so the confirmation and the result name them as the list did. */
const inOrder = (rows: readonly OfferRow[], picked: readonly string[]) => rows.filter((r) => !r.here && picked.includes(r.cwd)).map((r) => r.cwd);

/** One move of the offer. Nothing is picked until the person picks: the list starts with every box empty. A folder listed
 *  already cannot be picked. A move that changes nothing returns the same step. */
export function importReduce(s: ImportStep, e: ImportEvent): ImportStep {
  switch (e.type) {
    case "found": {
      const rows = offerRows(e.found, e.listed);
      return { at: "pick", rows, skipped: e.found.skipped, partial: e.found.partial, picked: [] };
    }
    case "failed":
      return { at: "failed", why: e.why };
    case "toggle": {
      if (s.at !== "pick") return s;
      const row = s.rows.find((r) => r.cwd === pathKey(e.cwd));
      if (!row || row.here) return s;
      const on = s.picked.includes(row.cwd);
      return { ...s, picked: inOrder(s.rows, on ? s.picked.filter((c) => c !== row.cwd) : [...s.picked, row.cwd]) };
    }
    case "all":
      if (s.at !== "pick") return s;
      return { ...s, picked: e.on ? inOrder(s.rows, s.rows.map((r) => r.cwd)) : [] };
    case "next":
      return s.at === "pick" && s.picked.length ? { ...s, at: "confirm" } : s;
    case "back":
      return s.at === "confirm" ? { ...s, at: "pick" } : s;
    case "brought":
      return s.at === "confirm" ? { at: "done", brought: e.brought, conversations: e.conversations } : s;
  }
}

/** The conversations of the picked folders, both agents together. */
export function pickedConversations(rows: readonly OfferRow[], picked: readonly string[]): number {
  return rows.filter((r) => picked.includes(r.cwd)).reduce((n, r) => n + r.total, 0);
}

/** What the skipped line names, in this order, each only when there is one. */
export type SkipPart = "gone" | "compressed" | "unreadable" | "over_limit";
export function skipParts(s: ImportSkipped): { part: SkipPart; n: number }[] {
  return (["gone", "compressed", "unreadable", "over_limit"] as const).flatMap((part) => (s[part] > 0 ? [{ part, n: s[part] }] : []));
}

// ---- what this computer keeps -----------------------------------------------------------------------------------------

export const IMPORT_KEY = "manut.importPast";
/** Folders the record keeps at most. */
const FOLDERS_MAX = 200;

export interface ImportRecord {
  /** The offer was made on this computer: it opened on a launch and was closed, or the look found nothing new. It does not
   *  open by itself again; History's Bring over… opens it by hand. */
  offered: boolean;
  /** The folders brought over, newest first, spelled by `pathKey`: History lists their conversations while each is still on
   *  the Code page's list. */
  folders: string[];
}

const EMPTY: ImportRecord = { offered: false, folders: [] };

export function parseRecord(raw: string | null): ImportRecord {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ImportRecord> | null;
    if (!v || typeof v !== "object") return EMPTY;
    const folders = Array.isArray(v.folders) ? [...new Set(v.folders.filter((f): f is string => typeof f === "string" && f !== "").map(pathKey))].slice(0, FOLDERS_MAX) : [];
    return { offered: v.offered === true, folders };
  } catch {
    return EMPTY;
  }
}

/** Whether a launch looks for work to offer: the host can look, the first-run setup is not filling the window, and the offer was
 *  not made on this computer yet. */
export function shouldLook(rec: ImportRecord, o: { can: boolean; firstRun: boolean }): boolean {
  return o.can && !o.firstRun && !rec.offered;
}

/** Bring `picked` over: each becomes an added folder on the Code page's list (`addFolder`, which adds a folder that is added
 *  already only once, so a second run adds nothing twice), the newest at the top as the offer listed them, and the record keeps
 *  them for History. `listed`: the Code page's folders now, which keep their places under the new ones. A pick that a session
 *  lists meanwhile (sessions come back after a launch's look) is still added, so History lists it as it lists the rest. The
 *  offer counts as made. */
export function bringOver(rec: ImportRecord, prefs: FolderPrefs, picked: readonly string[], listed: readonly string[]): { rec: ImportRecord; prefs: FolderPrefs } {
  const cwds = [...new Set(picked.map(pathKey))].filter((c) => c !== "");
  let next = prefs;
  // addFolder puts each new folder on top: the oldest first, so the newest ends on top
  for (const cwd of [...cwds].reverse()) next = addFolder(next, cwd, [...listed.filter((l) => pathKey(l) !== cwd), ...addedFolders(next)]);
  const folders = [...new Set([...cwds, ...rec.folders])].slice(0, FOLDERS_MAX);
  return { rec: { offered: true, folders }, prefs: next };
}

/** The folders History lists conversations of: those brought over that are still added folders on the Code page's list. One the
 *  person removed from that list (Remove from list) is no longer a project, so its conversations leave History too. */
export function historyFolders(rec: ImportRecord, prefs: FolderPrefs): string[] {
  const added = new Set(addedFolders(prefs).map(pathKey));
  return rec.folders.filter((f) => added.has(f));
}

let record: ImportRecord = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load(): ImportRecord {
  if (!loaded) {
    loaded = true;
    try {
      record = parseRecord(localStorage.getItem(IMPORT_KEY));
    } catch {
      record = EMPTY;
    }
  }
  return record;
}

export function getImportRecord(): ImportRecord {
  return load();
}

export function setImportRecord(next: ImportRecord): void {
  load();
  if (next === record) return;
  record = next;
  try {
    localStorage.setItem(IMPORT_KEY, JSON.stringify(record));
  } catch {
    /* no storage: the offer may open again on the next launch */
  }
  for (const fn of listeners) fn();
}

/** The offer was made: it does not open by itself again. */
export function markOffered(): void {
  const r = load();
  if (!r.offered) setImportRecord({ ...r, offered: true });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function useImportRecord(): ImportRecord {
  return useSyncExternalStore(subscribe, getImportRecord, getImportRecord);
}

/** For tests: forget what was read, so the next read is from storage again. */
export function resetImportRecordForTests(): void {
  loaded = false;
  record = EMPTY;
}

// ---- whether the offer is open ------------------------------------------------------------------------------------------

/** The offer while it is open: `found` when it opened on what a launch's look found (no second look), null when opened by hand
 *  (it looks first). `seq` tells one opening from the next. */
export interface ImportOpen {
  seq: number;
  found: ImportFound | null;
}

let opened: ImportOpen | null = null;
let openSeq = 0;
const openListeners = new Set<() => void>();
const emitOpen = () => {
  for (const fn of openListeners) fn();
};

/** Open the offer. One already open stays as it is. */
export function openImport(found: ImportFound | null = null): void {
  if (opened) return;
  opened = { seq: ++openSeq, found };
  emitOpen();
}

export function closeImport(): void {
  if (!opened) return;
  opened = null;
  emitOpen();
}

export const importOpen = (): ImportOpen | null => opened;

export function useImportOpen(): ImportOpen | null {
  return useSyncExternalStore(
    (fn) => {
      openListeners.add(fn);
      return () => {
        openListeners.delete(fn);
      };
    },
    importOpen,
    importOpen,
  );
}
