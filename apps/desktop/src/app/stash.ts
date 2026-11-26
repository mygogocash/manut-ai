// Drafts kept for later (item 95): the short list at the top of Home, the New page. A draft gets there two ways: words left
// unsent in Home's box when the person moves on, and Cmd+S in any chat box, which takes the draft out of the box. From the
// list a draft is taken into a chat or a project's box, words and files, where the person sends it or not. Nothing here
// ever sends anything.
//
// A chat's own unsent text stays that chat's (drafts.ts), as before. This list holds at most five; a sixth lets the oldest
// go, with an Undo while its line shows. Each draft's pictures and files are saved where pasted files already go
// (src-tauri/src/session_files.rs, `~/.manut/session-files/<folder>/`), in a folder of the draft's own, and that folder
// is removed with the draft: when it is deleted, let go, or taken into a box (the box then holds the files itself).
// A draft's folder is named as a session's is (`s` and nine digits, starting with 9), so the shell's own checks hold;
// SESSIONS counts its sessions from 1, and keeps these folders when it clears the folders of sessions that are gone.
//
// T3 Code (pingdotgg/t3code, commit e75534b3e5658002b9a47c7881fa1efef9797fbd, MIT) keeps a stash of prompts with their
// pictures (`promptStashStore.ts`); its idea is reimplemented here against the app's own files and boxes.
import { useSyncExternalStore } from "react";
import type { OutFile } from "../state/store";
import { blobType, bytesOf } from "../sessions/attach";
import { getHost } from "../sessions/host";
import { getDraft, setDraft } from "./drafts";

export const STASH_KEY = "manut.drafts.new";
/** The list holds this many; a sixth lets the oldest go, with an Undo. */
export const STASH_MAX = 5;
/** How long the Undo for a draft let go stays offered before its files go. */
export const UNDO_MS = 10_000;
const MAX_TEXT = 20_000;

/** One file of a draft: its saved copy's path, and what the box needs to show it again. */
export interface DraftFile {
  name: string;
  size: number;
  kind: OutFile["kind"];
  path: string;
}

export interface Stashed {
  id: string;
  text: string;
  files: DraftFile[];
  /** When it was kept (ms). */
  at: number;
  /** The folder its files are saved in (none without files). */
  folder: string | null;
  /** Where it was written: `home`, or the chat key of the box it left. */
  from: string;
}

/** Where a draft's files are kept and read back (the shell's session files; tests hand in a stand-in). */
export interface DraftFiles {
  saveFile(folder: string, name: string, data: Uint8Array): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  removeFiles(folder: string): Promise<void>;
}

let files: () => DraftFiles = () => getHost();
/** Tests: where draft files go. */
export function setDraftFiles(f: (() => DraftFiles) | null): void {
  files = f ?? (() => getHost());
}

// ---- the saved list -----------------------------------------------------------------------------------------------

const isFile = (f: unknown): f is DraftFile => {
  const x = f as Partial<DraftFile> | null;
  return !!x && typeof x.name === "string" && typeof x.size === "number" && typeof x.path === "string" && ["image", "video", "file"].includes(x.kind as string);
};

/** The saved list, newest first; anything that cannot be read is left out. */
export function parseStash(raw: string | null): Stashed[] {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Stashed[] = [];
  for (const x of v) {
    const e = x as Partial<Stashed> | null;
    if (!e || typeof e.id !== "string" || typeof e.text !== "string" || typeof e.at !== "number" || !Array.isArray(e.files)) continue;
    const kept = e.files.filter(isFile);
    if (!e.text.trim() && !kept.length) continue;
    if (out.some((o) => o.id === e.id)) continue;
    out.push({ id: e.id, text: e.text.slice(0, MAX_TEXT), files: kept, at: e.at, folder: typeof e.folder === "string" ? e.folder : null, from: typeof e.from === "string" ? e.from : "home" });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** `entry` put first; past `max` the oldest goes and is returned, so it can be brought back. */
export function keepNewest(list: readonly Stashed[], entry: Stashed, max = STASH_MAX): { list: Stashed[]; dropped: Stashed | null } {
  const next = [entry, ...list.filter((e) => e.id !== entry.id)];
  if (next.length <= max) return { list: next, dropped: null };
  return { list: next.slice(0, max), dropped: next[next.length - 1] };
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

let list: Stashed[] = parseStash(storage()?.getItem(STASH_KEY) ?? null);
/** The draft let go to make room, while its Undo is offered. */
let dropped: Stashed | null = null;
let dropTimer: ReturnType<typeof setTimeout> | null = null;
let snap: { list: readonly Stashed[]; dropped: Stashed | null } = { list, dropped };
const listeners = new Set<() => void>();

function set(next: Stashed[], gone: Stashed | null = dropped): void {
  list = next;
  dropped = gone;
  snap = { list, dropped };
  try {
    storage()?.setItem(STASH_KEY, JSON.stringify(list));
  } catch {
    /* no storage, or full: the list holds for this run */
  }
  for (const l of [...listeners]) l();
}

export const stashed = (): readonly Stashed[] => list;

/** The list and the draft whose Undo is offered, for a page. */
export function useStash(): { list: readonly Stashed[]; dropped: Stashed | null } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snap,
    () => snap,
  );
}

/** Every folder a kept draft's files are in (and the one whose Undo is offered): SESSIONS keeps them when it clears the
 *  folders of sessions that are gone. */
export function draftFolders(): string[] {
  return [...list, ...(dropped ? [dropped] : [])].flatMap((e) => (e.folder ? [e.folder] : []));
}

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq += 1)}`;
/** A folder name as a session's (`s` and nine digits), from 900000000 up so it is never one SESSIONS counts to. */
function newFolder(): string {
  const taken = new Set(draftFolders());
  for (;;) {
    const f = `s9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    if (!taken.has(f)) return f;
  }
}

const removeFolder = (folder: string | null) => {
  if (folder) void files().removeFiles(folder).catch(() => undefined);
};

/** The draft let go is gone for good: its files go now. */
export function letGo(): void {
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = null;
  if (!dropped) return;
  const gone = dropped;
  set(list, null);
  removeFolder(gone.folder);
}

/** Bring back the draft let go to make room. It joins the list even past five: the person chose to keep it. */
export function undoLetGo(): void {
  if (!dropped) return;
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = null;
  const back = dropped;
  set([...list, back].sort((a, b) => b.at - a.at), null);
}

/**
 * Keep a draft: its words and its files, each file's bytes saved first in the draft's own folder. Resolves to the kept
 * draft, or null when there was nothing to keep. Throws, keeping nothing, when a file cannot be saved, so the box that
 * asked can keep its draft.
 */
export async function stashDraft(d: { text: string; files?: readonly OutFile[]; from: string }, now = Date.now()): Promise<Stashed | null> {
  const text = d.text.slice(0, MAX_TEXT);
  const outs = d.files ?? [];
  if (!text.trim() && !outs.length) return null;
  const folder = outs.length ? newFolder() : null;
  const kept: DraftFile[] = [];
  try {
    for (const f of outs) {
      const path = await files().saveFile(folder!, f.name, bytesOf(await f.read()));
      kept.push({ name: f.name, size: f.size, kind: f.kind, path });
    }
  } catch (e) {
    removeFolder(folder);
    throw e;
  }
  const entry: Stashed = { id: newId(), text, files: kept, at: now, folder, from: d.from };
  // a draft already let go and not brought back goes for good before another takes its place
  if (dropped) letGo();
  const r = keepNewest(list, entry);
  set(r.list, r.dropped);
  if (r.dropped) dropTimer = setTimeout(letGo, UNDO_MS);
  return entry;
}

/** Delete a draft from the list, and its files. */
export function dropDraft(id: string): void {
  const e = list.find((x) => x.id === id);
  if (!e) return;
  set(list.filter((x) => x.id !== id));
  removeFolder(e.folder);
}

// ---- taking a draft into a box ------------------------------------------------------------------------------------

/** Drafts on their way into a chat's box, by chat key: the box takes its files when it shows (Composer.tsx). */
const handed = new Map<string, Stashed>();

/** Take a draft out of the list. Its files stay on disk until the box that receives it has read them. */
export function takeDraft(id: string): Stashed | null {
  const e = list.find((x) => x.id === id) ?? null;
  if (e) set(list.filter((x) => x.id !== id));
  return e;
}

/** Hand a taken draft's files to chat `key`'s box; the box reads them with `filesOf` when it shows. */
export function handFiles(key: string, e: Stashed): void {
  if (e.files.length) handed.set(key, e);
}

/** The draft handed to chat `key`, once. */
export function takeHanded(key: string): Stashed | null {
  const e = handed.get(key) ?? null;
  handed.delete(key);
  return e;
}

/** A taken draft's files as files a box can hold, read back from their saved copies; the copies then go. A file that
 *  cannot be read is named in `missing`. */
export async function filesOf(e: Stashed): Promise<{ files: File[]; missing: string[] }> {
  const out: File[] = [];
  const missing: string[] = [];
  for (const f of e.files) {
    try {
      const bytes = await files().readFile(f.path);
      out.push(new File([bytes as BlobPart], f.name, { type: blobType(f.name) }));
    } catch {
      missing.push(f.name);
    }
  }
  removeFolder(e.folder);
  return { files: out, missing };
}

/** The words a box holds after a draft is taken into it: what it held, then the draft, a blank line between. */
export const joinDraft = (own: string, text: string): string => {
  const mine = own.trimEnd();
  return mine && text ? `${mine}\n\n${text}` : mine || text;
};

/** Put a taken draft into chat `key`'s box: its words after what the box held (kept as that chat's draft, and shown
 *  at once if the box is on screen), its files handed to the box. The person sends it, or not: nothing is sent here. */
export function intoChat(store: { dispatch(a: { type: "ui.draft"; bot: string; text: string }): void }, key: string, e: Stashed): void {
  const text = joinDraft(getDraft(key), e.text);
  setDraft(key, text);
  handFiles(key, e);
  store.dispatch({ type: "ui.draft", bot: key, text });
}

/** Tests: start again from what storage holds, with nothing handed and nothing let go. */
export function reloadStash(): void {
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = null;
  handed.clear();
  list = parseStash(storage()?.getItem(STASH_KEY) ?? null);
  dropped = null;
  snap = { list, dropped };
}
