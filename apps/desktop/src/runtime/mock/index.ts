// The in-process runtime adapter: the app's requests go straight to a `MockHost` in the same page and its events
// come straight back, with no socket, no port and no other process. This is what the app runs on until a real
// runtime exists, and what `pnpm dev` and the unit tests use.
import type { BridgeError, BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "../../lib/protocol";
import { NO_CAPABILITIES, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeStatus } from "../adapter";
import { MockHost, OpError, sharedHost, type MockEvent } from "./host";

export { MockHost, OpError, sharedHost } from "./host";

const DISCONNECTED: BridgeError = { code: "disconnected", message: "the runtime is not connected" };

/** How long opening waits for the first look for a coding agent (MockHost.ready), so the team's first read names what
 *  answers Buddy. The look is one call to the shell; past this the runtime opens anyway and says it when it knows. */
const READY_MS = 2_000;

/** `p`, or nothing after `ms`, whichever comes first. */
function within(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
  });
  return Promise.race([p.catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

/** A refusal as the protocol's reply frame carries it. */
function refusal(e: unknown): BridgeError {
  if (e instanceof OpError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: "internal", message: e.message };
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as BridgeError;
  return { code: "internal", message: String(e) };
}

/** What the demo runtime can do beyond chat: none of the optional feature groups (it answers their reads empty), but it
 *  names models for its members, as a runtime on this computer does. */
export const MOCK_CAPABILITIES: RuntimeCapabilities = { ...NO_CAPABILITIES, models: true };

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
    this.opening = within(this.host.ready(), READY_MS).then(() => {
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
    // The answer arrives after the caller's own code has run on, as it would from another process. An answer the host
    // settles later (an ask of Buddy's agent, which approval-core decides) is waited for, and refused the same way.
    return Promise.resolve()
      .then(() => {
        if (this.status !== "open") throw DISCONNECTED;
        return this.host.handle(op, (params ?? {}) as Record<string, unknown>) as OpResult<K> | Promise<OpResult<K>>;
      })
      .catch((e: unknown) => {
        throw refusal(e);
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
