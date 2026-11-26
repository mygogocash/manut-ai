// The side menu's own choices (item 94), in Settings › General under "Recent chats", where a person who wants them finds them and
// nobody has to touch them:
//  - the Working group: OFF by default. When on, a chat whose turn runs waits in a quiet "Working" group under Recent and is back
//    in Recent when it finishes (its turn's end is its newest activity, so it is on top). A chat that needs the person is never put
//    there (menu.ts `recentParts`).
//  - settle after quiet days: a chat or a lane untouched for this many days is marked Done for now by itself (3 by default, 0 turns
//    it off; rows.ts `settleDue`).
//  - settle on merge: a lane whose pull request the host says merged is marked Done for now by itself (on by default).
//
// One small record on this computer (`manut.sidebar.inbox`); anything missing or malformed reads as the default.
import { useSyncExternalStore } from "react";

export const INBOX_KEY = "manut.sidebar.inbox";

export interface InboxSettings {
  working: boolean;
  quietDays: number;
  merged: boolean;
}

export const INBOX_DEFAULTS: InboxSettings = { working: false, quietDays: 3, merged: true };
/** The choices of quiet days Settings offers (0 is Off). */
export const QUIET_DAYS: readonly number[] = [0, 1, 3, 7, 14];

/** A saved record, defensively: each field this build knows, of the right type, else its default. */
export function parseInbox(raw: string | null): InboxSettings {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    /* a broken record reads as the defaults */
  }
  const r = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const days = r.quietDays;
  return {
    working: typeof r.working === "boolean" ? r.working : INBOX_DEFAULTS.working,
    quietDays: typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 365 ? days : INBOX_DEFAULTS.quietDays,
    merged: typeof r.merged === "boolean" ? r.merged : INBOX_DEFAULTS.merged,
  };
}

function read(): InboxSettings {
  try {
    return parseInbox(typeof localStorage !== "undefined" ? localStorage.getItem(INBOX_KEY) : null);
  } catch {
    return INBOX_DEFAULTS;
  }
}

let now = read();
const listeners = new Set<() => void>();

export const getInbox = (): InboxSettings => now;

export function setInbox(patch: Partial<InboxSettings>): void {
  const next = parseInbox(JSON.stringify({ ...now, ...patch }));
  if (next.working === now.working && next.quietDays === now.quietDays && next.merged === now.merged) return;
  now = next;
  try {
    localStorage.setItem(INBOX_KEY, JSON.stringify(next));
  } catch {
    /* no storage: it holds for this run */
  }
  for (const l of listeners) l();
}

/** Tests: read the settings again from storage. */
export function reloadInbox(): void {
  now = read();
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useInbox = (): InboxSettings => useSyncExternalStore(subscribe, getInbox, getInbox);
