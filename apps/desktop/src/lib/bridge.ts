// The WebSocket runtime adapter: the protocol in ./protocol.ts as JSON frames over one socket.
//
// This was Oh My Hermes' only transport (to its Python bridge). Manut AI starts no bridge, so nothing dials by
// default: `src/runtime/index.ts` builds this adapter only when a URL is configured, which today means the Playwright
// suite pointing the page at `e2e/mock-bridge.mjs`. A later remote runtime that speaks the same frames can reuse it.
import type { BridgeError, BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "./protocol";
import { ALL_CAPABILITIES, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeStatus } from "../runtime/adapter";

export type BridgeStatus = RuntimeStatus;

/** The page's stand-in for a URL source (the e2e suite sets it; it may answer a new URL after the runtime moved). */
type UrlStandIn = () => Promise<string>;
const standIn = (): UrlStandIn | undefined =>
  typeof window !== "undefined" ? (window as { __MANUT_BRIDGE_URL__?: UrlStandIn }).__MANUT_BRIDGE_URL__ : undefined;
const envUrl = (): string | undefined => (import.meta.env?.VITE_MANUT_BRIDGE as string | undefined) || undefined;

/** The page's switch for the in-process runtime (the e2e suite sets it, before the page loads). The suite builds the page with
 *  `VITE_MANUT_BRIDGE` for the mock bridge, so a spec that walks Practice, the app's own runtime, says so here and the page starts
 *  as it does with no bridge configured. Nothing in the app sets it. */
const inProcess = (): boolean => typeof window !== "undefined" && (window as { __MANUT_IN_PROCESS__?: unknown }).__MANUT_IN_PROCESS__ === true;

/** Whether a WebSocket runtime is configured at all: the page's `__MANUT_BRIDGE_URL__` stand-in, or the
 *  `VITE_MANUT_BRIDGE` build variable. With neither, the app runs on its in-process runtime and never dials; so it does when
 *  the page says `__MANUT_IN_PROCESS__`, whatever else is configured. */
export function bridgeUrlConfigured(): boolean {
  return !inProcess() && (!!standIn() || !!envUrl());
}

/** The URL to dial: the stand-in's answer, else `VITE_MANUT_BRIDGE`. Asked again before every dial, because a
 *  runtime that died and came back may listen on a new port with a new token. */
export async function resolveBridgeUrl(): Promise<string> {
  const ask = standIn();
  if (ask) return ask();
  const fromEnv = envUrl();
  if (fromEnv) return fromEnv;
  throw new Error("no WebSocket runtime is configured");
}

type Pending = { resolve: (v: never) => void; reject: (e: BridgeError) => void };
type Handler<K extends EventName> = (ev: EventOf<K>) => void;

export interface BridgeOptions {
  /** Override URL resolution (tests). A function is asked again before every dial, as `resolveBridgeUrl` is. */
  url?: string | (() => Promise<string>);
  /** Override the WebSocket constructor (tests). */
  WebSocketImpl?: typeof WebSocket;
  /** Backoff bounds in ms. */
  minDelay?: number;
  maxDelay?: number;
  /** What the runtime at the other end can do; everything, unless the caller knows better. */
  capabilities?: RuntimeCapabilities;
}

export class BridgeClient implements RuntimeAdapter {
  readonly kind = "websocket" as const;
  readonly capabilities: RuntimeCapabilities;
  status: BridgeStatus = "closed";
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<(ev: never) => void>>();
  private statusHandlers = new Set<(s: BridgeStatus) => void>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private firstOpen: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(private opts: BridgeOptions = {}) {
    this.capabilities = opts.capabilities ?? ALL_CAPABILITIES;
  }

  /** Starts connecting and resolves on the first successful open. Keeps reconnecting afterwards. */
  connect(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => this.firstOpen.push({ resolve, reject }));
    if (this.stopped) {
      this.stopped = false;
      void this.dial();
    }
    return p;
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.failPending({ code: "disconnected", message: "bridge connection closed" });
    this.setStatus("closed");
    const waiting = this.firstOpen.splice(0);
    for (const w of waiting) w.reject({ code: "disconnected", message: "bridge connection closed" });
  }

  request<K extends Op>(op: K, params?: OpParams<K>): Promise<OpResult<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject<OpResult<K>>({ code: "disconnected", message: "bridge is not connected" });
    }
    const id = `r${++this.seq}`;
    return new Promise<OpResult<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      ws.send(JSON.stringify({ ...(params ?? {}), id, op }));
    });
  }

  on<K extends EventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (ev: never) => void);
    return () => set!.delete(handler as (ev: never) => void);
  }

  /** Every event, whatever its type. */
  onAny(handler: (ev: BridgeEvent) => void): () => void {
    return this.on("*" as EventName, handler as Handler<EventName>);
  }

  onStatus(handler: (s: BridgeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(s: BridgeStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const h of [...this.statusHandlers]) h(s);
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    let url: string;
    try {
      const u = this.opts.url;
      url = typeof u === "string" ? u : u ? await u() : await resolveBridgeUrl();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus("open");
      for (const w of this.firstOpen.splice(0)) w.resolve();
    };
    ws.onmessage = (m) => this.onFrame(typeof m.data === "string" ? m.data : String(m.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending({ code: "disconnected", message: "bridge connection lost" });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus("closed");
    const min = this.opts.minDelay ?? 250;
    const max = this.opts.maxDelay ?? 5000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dial();
    }, delay);
  }

  private failPending(err: BridgeError) {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  private onFrame(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (typeof msg.event === "string") {
      const ev = msg as unknown as BridgeEvent;
      for (const key of [ev.event, "*"]) {
        const set = this.handlers.get(key);
        if (set) for (const h of [...set]) h(ev as never);
      }
      return;
    }
    if (typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result as never);
      else p.reject((msg.error as BridgeError) ?? { code: "unknown", message: "request failed" });
    }
  }
}
