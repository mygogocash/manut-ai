// The one seam between the app and whatever answers it.
//
// The screens speak the event protocol in `src/lib/protocol.ts` and nothing else: requests by op name, events by
// name. Oh My Hermes carried that protocol over a loopback WebSocket to a Python bridge in front of Hermes Agent.
// Manut AI keeps the protocol as the contract and puts the carrier behind this interface, so the app starts with no
// Hermes, no Python and no second process, and a real backend can arrive later as one more adapter.
//
// Adapters today (`src/runtime/index.ts` picks one):
//   - `mock`: an in-process runtime with staged data and scripted turns (`src/runtime/mock`). The default, which
//     Settings › Developer calls Practice.
//   - `http`: the connected runtime over apps/api at one origin (`src/runtime/http`), chosen in Settings ›
//     Developer as Connected. docs/runtime-adapter.md maps its ops to the API's routes.
//   - `websocket`: the original loopback transport (`src/lib/bridge.ts`), used only when a URL is configured, which
//     is how the Playwright suite reaches `e2e/mock-bridge.mjs`.
import type { BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "../lib/protocol";

export type RuntimeStatus = "connecting" | "open" | "closed";

export type RuntimeKind = "mock" | "websocket" | "http";

/** What a runtime can do beyond chat. The app hides a feature whose capability is off instead of showing a screen
 *  that cannot work; each one names a group of protocol ops, so a runtime that grows them only flips its flag. */
export interface RuntimeCapabilities {
  /** A team member's sessions in other apps: the "other places" chip, the Elsewhere list, Reply there
   *  (`elsewhere.*`, `links.places`). */
  elsewhere: boolean;
  /** Scheduled jobs: the Automations page and a member's Schedule tab (`automations.*`, `routines.list`). */
  automations: boolean;
  /** The plugin catalog and a member's installed plugins (`plugins.*`). */
  plugins: boolean;
  /** Restarting the process that serves a member (`bots.restart`, `bots.restart_scope`). */
  restart: boolean;
  /** Coding-CLI logins and their subscription usage, which the runtime reads from this computer (`accounts.*`,
   *  `usage.read`). */
  accounts: boolean;
}

/** A capability by name, for `can()`. */
export type RuntimeFeature = keyof RuntimeCapabilities;

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  status: RuntimeStatus;
  /** Starts connecting and resolves on the first successful open. An adapter that can lose its runtime keeps
   *  trying to get it back afterwards and reports each change through `onStatus`. */
  connect(): Promise<void>;
  /** Stops for good: pending requests are refused with `disconnected`. */
  close(): void;
  /** One protocol request. Rejects with a `BridgeError` (`{ code, message }`). */
  request<K extends Op>(op: K, params?: OpParams<K>): Promise<OpResult<K>>;
  on<K extends EventName>(event: K, handler: (ev: EventOf<K>) => void): () => void;
  /** Every event, whatever its name. */
  onAny(handler: (ev: BridgeEvent) => void): () => void;
  onStatus(handler: (s: RuntimeStatus) => void): () => void;
}

export const ALL_CAPABILITIES: RuntimeCapabilities = { elsewhere: true, automations: true, plugins: true, restart: true, accounts: true };
export const NO_CAPABILITIES: RuntimeCapabilities = { elsewhere: false, automations: false, plugins: false, restart: false, accounts: false };
