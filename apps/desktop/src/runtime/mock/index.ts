// The in-process runtime adapter: the app's requests go straight to a `MockHost` in the same page and its events
// come straight back, with no socket, no port and no other process. This is what the app runs on until a real
// runtime exists, and what `pnpm dev` and the unit tests use.
import type { BridgeError, BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "../../lib/protocol";
import { NO_CAPABILITIES, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeStatus } from "../adapter";
import { MockHost, OpError, sharedHost, type MockEvent } from "./host";

export { MockHost, OpError, sharedHost } from "./host";

const DISCONNECTED: BridgeError = { code: "disconnected", message: "the runtime is not connected" };

/** What the demo runtime can do beyond chat: none of the optional feature groups (it answers their reads empty). */
export const MOCK_CAPABILITIES: RuntimeCapabilities = NO_CAPABILITIES;

export class MockRuntime implements RuntimeAdapter {
  readonly kind = "mock" as const;
  readonly capabilities = MOCK_CAPABILITIES;
  status: RuntimeStatus = "closed";
  private handlers = new Map<string, Set<(ev: never) => void>>();
  private statusHandlers = new Set<(s: RuntimeStatus) => void>();
  private unsubscribe: (() => void) | null = null;
  private opening: Promise<void> | null = null;

  /** `host`: the runtime to talk to. Every adapter in the page shares one unless a test hands in its own. */
  constructor(private host: MockHost = sharedHost()) {}

  connect(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    if (this.opening) return this.opening;
    this.setStatus("connecting");
    // Opens a moment later, like any transport: callers that subscribe right after `connect()` see the change.
    this.opening = Promise.resolve().then(() => {
      this.opening = null;
      if (this.status !== "connecting") throw DISCONNECTED;
      this.unsubscribe = this.host.subscribe((ev) => this.deliver(ev));
      this.setStatus("open");
    });
    return this.opening;
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setStatus("closed");
  }

  request<K extends Op>(op: K, params?: OpParams<K>): Promise<OpResult<K>> {
    if (this.status !== "open") return Promise.reject<OpResult<K>>(DISCONNECTED);
    // The answer arrives after the caller's own code has run on, as it would from another process.
    return Promise.resolve().then(() => {
      if (this.status !== "open") throw DISCONNECTED;
      try {
        return this.host.handle(op, (params ?? {}) as Record<string, unknown>) as OpResult<K>;
      } catch (e) {
        const error: BridgeError = e instanceof OpError ? { code: e.code, message: e.message } : { code: "internal", message: e instanceof Error ? e.message : String(e) };
        throw error;
      }
    });
  }

  on<K extends EventName>(event: K, handler: (ev: EventOf<K>) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (ev: never) => void);
    return () => set!.delete(handler as (ev: never) => void);
  }

  onAny(handler: (ev: BridgeEvent) => void): () => void {
    return this.on("*" as EventName, handler as (ev: EventOf<EventName>) => void);
  }

  onStatus(handler: (s: RuntimeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(s: RuntimeStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of [...this.statusHandlers]) h(s);
  }

  /** One event to its own handlers and to the catch-all ones. Each handler gets its own copy through JSON, as each
   *  would parse its own frame: one screen cannot change what another reads, and nothing that is not JSON crosses. */
  private deliver(ev: MockEvent): void {
    for (const key of [ev.event, "*"]) {
      const set = this.handlers.get(key);
      if (set) for (const h of [...set]) h(JSON.parse(JSON.stringify(ev)) as never);
    }
  }
}
