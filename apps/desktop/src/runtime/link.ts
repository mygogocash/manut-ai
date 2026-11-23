// What the screens say and do about the runtime itself: the quiet mode line above the account row ("Practice mode",
// "Connected to dev.manut.xyz"), and the sign-in state and restart Settings › Developer shows. The runtime choice is
// read once at start (index.ts), so these read that choice, while Settings shows the choice saved for the next start.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Key } from "../i18n";
import type { RuntimeKind } from "./adapter";
import { sessionFor, sharedHttpHost, type LinkState } from "./http";
import type { SignInState } from "./http/session";
import { runtimeKind, startedRuntime } from "./index";
import { hostOf, type RuntimeSetting } from "./setting";

const LINK_KEY: Record<LinkState, Key> = {
  open: "mode.connected",
  connecting: "mode.connecting",
  signed_out: "mode.signedOut",
  offline: "mode.offline",
  unavailable: "mode.unavailable",
};

/** The mode line's words: Practice, or the host and how the link to it stands. Null for a WebSocket runtime, which
 *  only the e2e suite configures and which is neither. */
export function modeLine(setting: RuntimeSetting, kind: RuntimeKind, link: LinkState | null): { key: Key; vars?: { host: string } } | null {
  if (kind === "websocket") return null;
  if (setting.mode === "practice" || kind === "mock") return { key: "mode.practice" };
  return { key: LINK_KEY[link ?? "connecting"], vars: { host: hostOf(setting.origin) } };
}

/** Whether the choice saved on this computer is not the one this page started with. */
export function pendingRestart(saved: RuntimeSetting, started: RuntimeSetting = startedRuntime()): boolean {
  if (saved.mode !== started.mode) return true;
  return saved.mode === "connected" && started.mode === "connected" && saved.origin !== started.origin;
}

const none = () => () => {};

/** The mode line for the runtime this page started with, following the connected host's link as it changes. */
export function useModeLine(): ReturnType<typeof modeLine> {
  const setting = startedRuntime();
  const kind = runtimeKind(setting);
  const host = kind === "http" && setting.mode === "connected" ? sharedHttpHost(setting.origin) : null;
  const subscribe = useCallback((fn: () => void) => (host ? host.onLink(fn) : () => {}), [host]);
  const link = useSyncExternalStore(host ? subscribe : none, () => host?.link ?? null, () => host?.link ?? null);
  return modeLine(setting, kind, link);
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
