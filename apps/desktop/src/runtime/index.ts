// Which runtime the app talks to. Everything that used to make its own bridge client asks here instead.
//
// The rule is deliberately small: a configured WebSocket URL (the page's `__MANUT_BRIDGE_URL__` stand-in, or the
// `VITE_MANUT_BRIDGE` build variable) selects the WebSocket adapter; otherwise the app runs on the in-process
// runtime. Nothing is configured in a normal build, so the desktop app starts with no other process. The packaged
// app's content security policy also allows no socket, so a WebSocket runtime there needs that policy widened on
// purpose (src-tauri/tauri.conf.json).
import { BridgeClient, bridgeUrlConfigured } from "../lib/bridge";
import { ALL_CAPABILITIES, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeFeature, type RuntimeKind } from "./adapter";
import { MOCK_CAPABILITIES, MockRuntime } from "./mock";

export type { RuntimeAdapter, RuntimeCapabilities, RuntimeFeature, RuntimeKind, RuntimeStatus } from "./adapter";

export function runtimeKind(): RuntimeKind {
  return bridgeUrlConfigured() ? "websocket" : "mock";
}

/** A new client of the runtime. Each caller gets its own, so a short-lived one can close without ending another's;
 *  in-process clients all reach the same runtime state. */
export function createRuntime(): RuntimeAdapter {
  return runtimeKind() === "websocket" ? new BridgeClient() : new MockRuntime();
}

export function runtimeCapabilities(): RuntimeCapabilities {
  return runtimeKind() === "websocket" ? ALL_CAPABILITIES : MOCK_CAPABILITIES;
}

/** Whether the runtime has `feature`. Screens and menu rows that need a missing one are not shown. */
export function can(feature: RuntimeFeature): boolean {
  return runtimeCapabilities()[feature];
}
