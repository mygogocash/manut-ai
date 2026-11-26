// Which runtime the app talks to. Everything that used to make its own bridge client asks here instead.
//
// The rule is deliberately small: a configured WebSocket URL (the page's `__MANUT_BRIDGE_URL__` stand-in, or the
// `VITE_MANUT_BRIDGE` build variable) selects the WebSocket adapter; otherwise this computer's choice in Settings ›
// Developer does (setting.ts): Connected selects the runtime over apps/api at its origin (`./http`), and
// Practice, the default, the in-process runtime. Nothing is configured in a normal build and Practice is the default,
// so the desktop app starts with no other process and no network. The packaged app's content security policy also
// allows no socket, so a WebSocket runtime there needs that policy widened on purpose (src-tauri/tauri.conf.json);
// the connected runtime needs no change to it, because its requests go through the desktop shell (http/shell.ts).
//
// The choice is read once, when the page starts: the store is built around one runtime and keeps it, so the rest of
// the app (which features `can` show) must read the same choice until the next start.
import { BridgeClient, bridgeUrlConfigured } from "../lib/bridge";
import { ALL_CAPABILITIES, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeFeature, type RuntimeKind } from "./adapter";
import { HTTP_CAPABILITIES, HttpRuntime, sharedHttpHost } from "./http";
import { MOCK_CAPABILITIES, MockRuntime } from "./mock";
import { readRuntimeSetting, type RuntimeSetting } from "./setting";

export type { RuntimeAdapter, RuntimeCapabilities, RuntimeFeature, RuntimeKind, RuntimeStatus } from "./adapter";

let started: RuntimeSetting | null = null;

/** The choice this page started with. A choice saved since applies at the next start. */
export function startedRuntime(): RuntimeSetting {
  return (started ??= readRuntimeSetting());
}

/** Tests: read the saved choice again, as a new start would. */
export function forgetStartedRuntime(): void {
  started = null;
}

export function runtimeKind(setting: RuntimeSetting = startedRuntime()): RuntimeKind {
  if (bridgeUrlConfigured()) return "websocket";
  return setting.mode === "connected" ? "http" : "mock";
}

/** A new client of the runtime. Each caller gets its own, so a short-lived one can close without ending another's;
 *  in-process and connected clients each share one runtime state (the mock host, or the origin's HTTP host). */
export function createRuntime(setting: RuntimeSetting = startedRuntime()): RuntimeAdapter {
  const kind = runtimeKind(setting);
  if (kind === "websocket") return new BridgeClient();
  if (kind === "http" && setting.mode === "connected") return new HttpRuntime(sharedHttpHost(setting.origin));
  return new MockRuntime();
}

export function runtimeCapabilities(setting: RuntimeSetting = startedRuntime()): RuntimeCapabilities {
  const kind = runtimeKind(setting);
  return kind === "websocket" ? ALL_CAPABILITIES : kind === "http" ? HTTP_CAPABILITIES : MOCK_CAPABILITIES;
}

/** Whether the runtime has `feature`. Screens and menu rows that need a missing one are not shown. */
export function can(feature: RuntimeFeature): boolean {
  return runtimeCapabilities()[feature];
}
