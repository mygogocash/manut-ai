// In-app updates. The Tauri shell's updater plugin reads one fixed endpoint (tauri.conf.json) and installs only a
// build signed with the key whose public half is pinned there. Outside Tauri (browser dev, e2e) there is no updater,
// unless the page sets `window.__manutUpdateHost`, the e2e stand-in.
//
// The updater is on (`UPDATER_ENABLED`) with Manut AI's own key: tauri.conf.json pins the public half and names a
// `latest.json` under GitHub's releases/latest, which skips drafts, so it moves only when the owner publishes a
// release (docs/releasing.md). The flag stays so a build can be made that asks nothing, and so tests can see it.
//
// The Mac App Store edition never asks (`isAppStore`, docs/app-store.md): the App Store updates it, an app that updates
// itself is refused there (Guideline 2.4.5(vii)), and its shell does not even carry the updater plugin. Settings ›
// General › System says so instead.
import { isAppStore } from "../appStore";
import { t } from "../i18n";
import { inTauri } from "../lib/tauri";

/** Download progress: bytes so far and the total when the server sent one. */
export type UpdateProgress = { done: number; total: number | null };

export interface PendingUpdate {
  version: string;
  /** Download, verify and install; reports progress as it goes. */
  install(onProgress: (p: UpdateProgress) => void): Promise<void>;
}

export interface UpdateHost {
  /** A newer signed release, or null when this is the newest. */
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
}

const MIN = 60 * 1000;
/** After a good check the next one is this far away, unless the person comes back to the window first. */
export const CHECK_EVERY_MS = 6 * 60 * MIN;
/** Coming back to the window asks again only when the last good check is at least this old. */
export const FRESH_MS = 30 * MIN;
/** A failed check is tried again after this long, then twice as long each time, and never later than an hour. */
export const RETRY_FIRST_MS = 2 * MIN;
export const RETRY_MAX_MS = 60 * MIN;
/** While checks fail, coming back to the window asks again once the last try is this old. */
export const RETRY_GAP_MS = MIN;
/** A check gives up after this long, so one request that never answers cannot hold back every later check. */
export const CHECK_TIMEOUT_MS = 30 * 1000;

/** Whether the desktop app looks for updates at all. */
export const UPDATER_ENABLED = true;


/** The shell's updater plugin as an `UpdateHost`. Exported so its request shape stays tested. */
export function tauriHost(): UpdateHost {
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!u) return null;
      return {
        version: u.version,
        async install(onProgress) {
          let done = 0;
          let total: number | null = null;
          await u.downloadAndInstall((e) => {
            if (e.event === "Started") total = e.data.contentLength ?? null;
            else if (e.event === "Progress") done += e.data.chunkLength;
            onProgress({ done, total });
          });
        },
      };
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

export function updateHost(appStore: boolean = isAppStore()): UpdateHost | null {
  if (typeof window === "undefined") return null;
  // before e2e's stand-in too, so a page shown as the App Store edition has no update button at all
  if (appStore) return null;
  const injected = (window as unknown as { __manutUpdateHost?: UpdateHost }).__manutUpdateHost;
  if (injected) return injected;
  return UPDATER_ENABLED && inTauri() ? tauriHost() : null;
}

/** How long to wait after the nth failed check in a row: 2, 4, 8, 16, 32 minutes, then an hour. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Keeps an open app looking for a newer release: once now, 6 hours after each good check, minutes after a failed
 * one (see `retryDelay`), and when the window is shown or focused again while the last good check is half an hour
 * old or more. That last one does not depend on a timer, so it also covers a Mac that slept and a window that was
 * hidden. One request at a time; `paused` (an install is running) skips a check. Returns the stop function.
 */
export function watchForUpdates(
  host: UpdateHost,
  found: (u: PendingUpdate | null) => void,
  paused: () => boolean = () => false,
): () => void {
  let live = true;
  let flying = false;
  let failures = 0;
  let lastOk: number | null = null;
  let lastTry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = (ms: number) => {
    clearTimeout(timer);
    if (live) timer = setTimeout(() => void run(), ms);
  };
  const run = async () => {
    if (!live || flying) return;
    if (paused()) return plan(CHECK_EVERY_MS);
    flying = true;
    lastTry = Date.now();
    clearTimeout(timer);
    try {
      const u = await host.check();
      failures = 0;
      lastOk = Date.now();
      if (live && !paused()) found(u);
      plan(CHECK_EVERY_MS);
    } catch {
      // offline or the endpoint is down: stay quiet and try again soon
      failures += 1;
      plan(retryDelay(failures));
    } finally {
      flying = false;
    }
  };
  const back = () => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (lastOk !== null && now - lastOk < FRESH_MS) return;
    if (now - lastTry < RETRY_GAP_MS) return;
    void run();
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  void run();
  return () => {
    live = false;
    clearTimeout(timer);
    window.removeEventListener("focus", back);
    document.removeEventListener("visibilitychange", back);
  };
}

/** Whole percent of a download, or null when the size is unknown. */
export function percent(p: UpdateProgress): number | null {
  if (!p.total || p.total <= 0) return null;
  return Math.min(100, Math.floor((p.done / p.total) * 100));
}

/** One short line for a failed check or install. */
export function shortError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const line = raw.split("\n")[0].trim();
  if (!line) return t("upd.failed");
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
