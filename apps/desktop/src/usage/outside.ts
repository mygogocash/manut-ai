// Use outside Manut AI (item 106): the tokens a coding tool's own files on this Mac say were used in sessions the person
// ran elsewhere, summed per day and per project folder by the shell (src-tauri/src/outside_use.rs). This file is the page's
// side: the host the shell answers through, the one switch, and the words for a number. A module takes the host it is
// given (a test stands in for the shell); `outsideHost()` is only the default the screens pass.
import type { SessionRec } from "../sessions/agents";

export type OutsideTool = "claude" | "codex";
export const OUTSIDE_TOOLS: readonly OutsideTool[] = ["claude", "codex"];

export interface OutsideRow {
  day: string;
  /** The project folder's name; empty when the file named none. */
  project: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface OutsideSkipped {
  links: number;
  too_big: number;
  not_json: number;
  compressed: number;
  app_started: number;
  over_limit: number;
}

export interface OutsideReport {
  tool: string;
  rows: OutsideRow[];
  today: number;
  week: number;
  /** Seconds since the epoch. */
  read_at: number;
  files_read: number;
  files_cached: number;
  skipped: OutsideSkipped;
  partial: boolean;
}

export interface OutsideHost {
  /** Read `tool`'s files. `exclude` are the ids of sessions Manut AI started; `scanId` names the read for `cancel`. */
  scan(tool: OutsideTool, exclude: string[], scanId: number): Promise<OutsideReport>;
  cancel(scanId: number): Promise<void>;
}

declare global {
  interface Window {
    /** e2e stand-in for the shell (a plain browser has none). */
    __manutOutsideHost?: OutsideHost;
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const tauriHost: OutsideHost = {
  async scan(tool, exclude, scanId) {
    const { invoke } = (await import("@tauri-apps/api/core")) as unknown as { invoke: Invoke };
    return invoke<OutsideReport>("outside_use_scan", { tool, exclude, scanId });
  },
  async cancel(scanId) {
    const { invoke } = (await import("@tauri-apps/api/core")) as unknown as { invoke: Invoke };
    await invoke("outside_use_cancel", { scanId });
  },
};

type Win = (Window & typeof globalThis) | undefined;
const win = (): Win => (typeof window === "undefined" ? undefined : window);

/** The desktop app's shell, or the e2e stand-in; none in a plain browser (the page then shows nothing of this). */
export function outsideHost(w: { __manutOutsideHost?: OutsideHost } | undefined = win()): OutsideHost | null {
  if (!w) return null;
  if ("__TAURI_INTERNALS__" in w) return tauriHost;
  return w.__manutOutsideHost ?? null;
}

const KEY = "manut.outsideuse";
const EVENT = "manut:outsideuse";

/** The switch (Settings › Providers › Accounts). OFF unless turned on: docs/decisions.md says why. */
export function outsideUseOn(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return store?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setOutsideUse(on: boolean, store: Pick<Storage, "setItem"> | undefined = globalThis.localStorage, target: Pick<EventTarget, "dispatchEvent"> | undefined = win()): void {
  try {
    store?.setItem(KEY, on ? "1" : "0");
  } catch {
    /* no storage: the switch stays off */
  }
  target?.dispatchEvent(new Event(EVENT));
}

/** Calls `f` when the switch changes anywhere on the page. */
export function watchOutsideUse(f: () => void, target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined = win()): () => void {
  target?.addEventListener(EVENT, f);
  return () => target?.removeEventListener(EVENT, f);
}

/** The conversation ids of the sessions Manut AI started with `tool`: matched against the tool's files, never opened. */
export function startedIds(list: readonly SessionRec[], tool: OutsideTool): string[] {
  return list.filter((s) => s.agent === tool && s.agentSession).map((s) => s.agentSession!);
}

/** 980, 1.2k, 34k, 5.6M: a count of tokens as a person reads it. */
export function tokenText(n: number): string {
  const f = (x: number, u: string) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${u}`;
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return f(n / 1000, "k");
  if (n < 1_000_000_000) return f(n / 1_000_000, "M");
  return f(n / 1_000_000_000, "B");
}

/** Whether the skipped files are worth a line (sessions Manut AI started are not: those are counted elsewhere). */
export function skippedCount(s: OutsideSkipped): number {
  return s.links + s.too_big + s.not_json + s.compressed;
}
