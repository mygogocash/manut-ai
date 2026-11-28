// The choices the Diff beside a lane keeps (item 146): unified or side by side, and the list or one file at a time. Saved on this
// computer in `localStorage`, as Settings keeps its own (lib/sourceControl.ts), so a person who prefers one layout finds it again
// in every lane after a restart. Nothing here is sent anywhere; the Diff's scope (All changes, Not committed, Commits) is not kept,
// since it is the question of the moment and opens on the whole list.
import { useSyncExternalStore } from "react";
import type { DiffLayout } from "../chat/activity/diffLayout";
import { changes } from "../lib/changes";

export interface DiffPrefs {
  layout: DiffLayout;
  /** One file at a time, with Prev and Next, rather than the list. */
  one: boolean;
}

export const DIFF_DEFAULTS: DiffPrefs = { layout: "unified", one: false };

export const DIFF_PREFS_KEY = "manut.pane.diff";

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(DIFF_PREFS_KEY);
  } catch {
    return null;
  }
}

/** The saved choices; a value that is not usable is the default. */
export function parseDiffPrefs(text: string | null): DiffPrefs {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    /* damaged: the defaults */
  }
  return { layout: o.layout === "split" || o.layout === "unified" ? o.layout : DIFF_DEFAULTS.layout, one: typeof o.one === "boolean" ? o.one : DIFF_DEFAULTS.one };
}

const listeners = changes();
let cache: { text: string; value: DiffPrefs } | null = null;
// the choices as of this run: where storage cannot keep them (none, or full) they still hold until the app closes
let held: DiffPrefs = DIFF_DEFAULTS;

export function diffPrefs(): DiffPrefs {
  const text = read();
  if (text === null) return held;
  if (!cache || cache.text !== text) cache = { text, value: parseDiffPrefs(text) };
  return cache.value;
}

export function setDiffPrefs(patch: Partial<DiffPrefs>): void {
  held = parseDiffPrefs(JSON.stringify({ ...diffPrefs(), ...patch }));
  try {
    localStorage.setItem(DIFF_PREFS_KEY, JSON.stringify(held));
  } catch {
    /* no storage, or full: the choice holds for this run only */
  }
  listeners.emit();
}

export function useDiffPrefs(): DiffPrefs {
  return useSyncExternalStore(
    (l) => listeners.subscribe(l),
    diffPrefs,
    diffPrefs,
  );
}
