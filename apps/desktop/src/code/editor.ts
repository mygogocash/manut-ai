// Open a folder in the person's editor (item 107). The shell knows a fixed list of editors (src-tauri/src/folder_open.rs
// `EDITORS`) and says which are installed here; the page names one by its id and never by a path or a command. A typed
// command is not offered: it would be a way to run anything, which needs the design of an ask (docs/decisions.md).
//
// Every function takes the host it is to ask, so a test stands in for the shell and a store built with a host keeps asking
// that one, never the app's global one.
import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";

export interface EditorInfo {
  id: string;
  label: string;
}

/** The part of a host this needs: optional, so a shell older than item 107 offers no editor and the menus show none. */
export interface EditorHost {
  editors?(): Promise<EditorInfo[]>;
  openInEditor?(cwd: string, editor: string): Promise<void>;
}

/** The ids the shell knows, in the order "Automatic" takes the first installed. A saved id outside it is Automatic. */
export const EDITOR_IDS = ["vscode", "cursor", "windsurf", "zed", "xcode"] as const;

const KEY = "manut.editor";

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The saved choice: "auto" or one id of the list. Anything else (a damaged value, an editor since removed from the list) is auto. */
export function readEditorPref(): string {
  const v = read();
  return v !== null && (EDITOR_IDS as readonly string[]).includes(v) ? v : "auto";
}

const listeners = new Set<() => void>();
export function setEditorPref(id: string): void {
  try {
    if (id === "auto") localStorage.removeItem(KEY);
    else if ((EDITOR_IDS as readonly string[]).includes(id)) localStorage.setItem(KEY, id);
  } catch {
    /* no storage */
  }
  listeners.forEach((l) => l());
}
export function useEditorPref(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readEditorPref,
    readEditorPref,
  );
}

/** The editor to open with: the one named when it is installed, else (Automatic, or the named one is gone) the first installed. */
export function resolveEditor(pref: string, installed: readonly EditorInfo[]): EditorInfo | null {
  return installed.find((e) => e.id === pref) ?? installed[0] ?? null;
}

// what each host said, kept so a menu asks the shell once; a refusal is not kept
const lists = new WeakMap<object, Promise<EditorInfo[]>>();
const waiting = new Set<() => void>();
const known = new WeakMap<object, EditorInfo[]>();

/** The editors installed here, as `host` says. A host that cannot say has none. `again` asks the shell afresh (Settings does
 *  when it opens, so an editor installed since shows up). */
export function editorsOf(host: EditorHost, again = false): Promise<EditorInfo[]> {
  const had = lists.get(host);
  if (had && !again) return had;
  const p = (host.editors ? host.editors() : Promise.resolve([])).then(
    (l) => {
      const clean = Array.isArray(l) ? l.filter((e) => e && typeof e.id === "string" && typeof e.label === "string") : [];
      known.set(host, clean);
      waiting.forEach((f) => f());
      return clean;
    },
    () => {
      lists.delete(host);
      return [] as EditorInfo[];
    },
  );
  lists.set(host, p);
  return p;
}

/** The editors installed here, or null until the host has answered. */
export function useEditors(host: EditorHost): EditorInfo[] | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    waiting.add(f);
    void editorsOf(host);
    return () => void waiting.delete(f);
  }, [host]);
  return known.get(host) ?? null;
}

/** The editor the menus offer now: the saved choice or the first installed, or null while none is installed (no menu item then). */
export function useEditorChoice(host: EditorHost): EditorInfo | null {
  const list = useEditors(host);
  const pref = useEditorPref();
  return list ? resolveEditor(pref, list) : null;
}

/** The app's own words for why an open failed. The shell's text is for its log, not for the person. */
export function editorWhy(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "";
  if (/not there/i.test(text)) return t("editor.fail.gone");
  if (/not a folder/i.test(text)) return t("editor.fail.folder");
  if (/not installed|not an editor|no editor/i.test(text)) return t("editor.fail.missing");
  return t("editor.fail.other");
}

/** Open `folder` in the editor the saved choice names (else the first installed) through `host`. Rejects with the app's plain
 *  words. With no editor installed it rejects too, though no menu offers it then. */
export async function openFolderInEditor(host: EditorHost, folder: string, pref: string = readEditorPref()): Promise<void> {
  if (!host.openInEditor) throw new Error(t("editor.fail.missing"));
  const choice = resolveEditor(pref, await editorsOf(host));
  if (!choice) throw new Error(t("editor.fail.missing"));
  try {
    await host.openInEditor(folder, choice.id);
  } catch (e) {
    throw new Error(editorWhy(e));
  }
}
