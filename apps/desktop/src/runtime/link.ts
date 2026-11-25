// What the screens say and do about the runtime itself: the quiet mode line above the account row ("Practice mode",
// "Connected to dev.manut.xyz", or while the API cannot be reached "Offline. Showing what was here at 14:05"), and the
// sign-in state and restart Settings › Developer shows. The runtime choice is read once at start (index.ts), so these
// read that choice, while Settings shows the choice saved for the next start.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { dayTime } from "../app/time";
import type { Key } from "../i18n";
import type { RuntimeKind } from "./adapter";
import { forgetShop, sessionFor, sharedHttpHost, type CacheView, type HttpHost, type LinkState } from "./http";
import type { SignInState } from "./http/session";
import { runtimeKind, startedRuntime } from "./index";
import { hostOf, writeRuntimeSetting, type RuntimeSetting } from "./setting";

const LINK_KEY: Record<LinkState, Key> = {
  open: "mode.connected",
  connecting: "mode.connecting",
  signed_out: "mode.signedOut",
  offline: "mode.offline",
  unavailable: "mode.unavailable",
};

/** When a kept read was made, as the mode line says it: "14:05" on the day it was read, and the day first on any other
 *  day ("Nov 22 14:05"), so a read from yesterday is never taken for one from this morning. */
export function readTime(at: number, now: number = Date.now()): string {
  return dayTime(at, now);
}

/** The mode line's words: Practice, or the host and how the link to it stands. While the API cannot be reached (offline,
 *  or not answering) and the runtime shows its last good read, the line says so and when it was read; with a read too
 *  old to show (7 days), it says that instead, and on a computer with no keychain, where no copy is kept, it says that.
 *  Null for a WebSocket runtime, which only the e2e suite configures and which is neither. */
export function modeLine(
  setting: RuntimeSetting,
  kind: RuntimeKind,
  link: LinkState | null,
  cache: CacheView | null = null,
  now: number = Date.now(),
): { key: Key; vars?: { host: string; time?: string } } | null {
  if (kind === "websocket") return null;
  if (setting.mode === "practice" || kind === "mock") return { key: "mode.practice" };
  const host = hostOf(setting.origin);
  if ((link === "offline" || link === "unavailable") && cache) {
    const offline = link === "offline";
    if (cache.kind === "showing") return { key: offline ? "mode.cachedOffline" : "mode.cachedUnavailable", vars: { host, time: readTime(cache.at, now) } };
    if (cache.kind === "too_old") return { key: offline ? "mode.oldOffline" : "mode.oldUnavailable", vars: { host } };
    if (cache.kind === "unkept") return { key: offline ? "mode.unkeptOffline" : "mode.unkeptUnavailable", vars: { host } };
  }
  return { key: LINK_KEY[link ?? "connecting"], vars: { host } };
}

/** Whether moving the saved choice from `was` to `next` leaves the shop the read was kept for: Connected to somewhere
 *  else, or Practice. Practice never shows real shop data, so it keeps none either. */
export function leavesShop(was: RuntimeSetting, next: RuntimeSetting): boolean {
  return was.mode === "connected" && !(next.mode === "connected" && next.origin === was.origin);
}

/** Saves the choice for the next start, and forgets the saved read of the shop when the choice leaves that shop. The
 *  choice is written first: what keeps the read (the host, http/index.ts) stops as soon as the saved choice is not its
 *  origin, so the removal cannot be undone by the next read of the page that still runs the old one. A choice that
 *  cannot be saved forgets nothing. */
export function saveRuntimeChoice(
  was: RuntimeSetting,
  next: RuntimeSetting,
  deps: { write: (s: RuntimeSetting) => void; forget: () => unknown } = { write: writeRuntimeSetting, forget: forgetShop },
): void {
  deps.write(next);
  if (leavesShop(was, next)) void deps.forget();
}

/** Whether the choice saved on this computer is not the one this page started with. */
export function pendingRestart(saved: RuntimeSetting, started: RuntimeSetting = startedRuntime()): boolean {
  if (saved.mode !== started.mode) return true;
  return saved.mode === "connected" && started.mode === "connected" && saved.origin !== started.origin;
}

const none = () => () => {};

/** The connected host this page started with, or null on any other runtime. */
function startedHost(): HttpHost | null {
  const setting = startedRuntime();
  return runtimeKind(setting) === "http" && setting.mode === "connected" ? sharedHttpHost(setting.origin) : null;
}

/** The mode line for the runtime this page started with, following the connected host's link, and what stands in for the
 *  shop while the API cannot be reached, as they change. */
export function useModeLine(): ReturnType<typeof modeLine> {
  const setting = startedRuntime();
  const kind = runtimeKind(setting);
  const host = startedHost();
  const subscribe = useCallback((fn: () => void) => (host ? host.onLink(fn) : () => {}), [host]);
  const link = useSyncExternalStore(host ? subscribe : none, () => host?.link ?? null, () => host?.link ?? null);
  // the host replaces `cache` only when it changes, so the object is the same between changes
  const cache = useSyncExternalStore(host ? subscribe : none, () => host?.cache ?? null, () => host?.cache ?? null);
  return modeLine(setting, kind, link, cache);
}

/** Whether the screens show a kept read because the API cannot be reached, so an ask on screen cannot be answered: the
 *  approval card says "Connect to answer this" and offers no answer. False on every other runtime. */
export function useShowingCache(): boolean {
  const host = startedHost();
  const subscribe = useCallback((fn: () => void) => (host ? host.onLink(fn) : () => {}), [host]);
  return useSyncExternalStore(host ? subscribe : none, () => host?.cache.kind === "showing", () => host?.cache.kind === "showing");
}

/** The session with the API at `origin` as Settings shows it (null without an origin), read from the keychain once. */
export function useSignIn(origin: string | null): SignInState | null {
  const session = origin ? sessionFor(origin) : null;
  const subscribe = useCallback((fn: () => void) => (session ? session.subscribe(fn) : () => {}), [session]);
  const state = useSyncExternalStore(subscribe, () => session?.state ?? null, () => session?.state ?? null);
  useEffect(() => {
    void session?.load();
  }, [session]);
  return state;
}

/** Starts the page again, so the store is built on the runtime saved for the next start. Like any reload, it stops
 *  the terminals and coding sessions the page started in the desktop shell (sessions/host.ts `reset`), which
 *  Settings says beside the button. */
export function restartApp(): void {
  if (typeof window !== "undefined") window.location.reload();
}
