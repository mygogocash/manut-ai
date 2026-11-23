// The connected runtime's adapter: a thin client of the page's one `HttpHost` (host.ts), as `MockRuntime` is of the
// demo's `MockHost`. Each caller of `createRuntime` gets its own client; they all share the host's one session, one
// read of the shop and one timer, so the API is read once however many screens ask.
//
// Its status follows the host's link: open once the shop has been read; connecting before the first read; closed when
// signed out, offline or facing an API that does not answer. A request while closed is refused with that reason, which
// the chat shows as it shows any refusal.
import { t } from "../../i18n";
import type { BridgeError, BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "../../lib/protocol";
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeStatus } from "../adapter";
import { OpError } from "../mock/host";
import { HttpHost, type HostEvent, type LinkState } from "./host";
import { ApiSession } from "./session";
import { shellFetch, shellVault } from "./shell";

export { HttpHost, type LinkState } from "./host";
export { ApiSession } from "./session";

/** What the connected runtime offers beyond chat: the shop's schedules, read-only, on the Automations page. The
 *  other groups belong to a runtime on this computer (Hermes' places, plugins, restarts, coding-CLI logins). */
export const HTTP_CAPABILITIES: RuntimeCapabilities = { elsewhere: false, automations: true, plugins: false, restart: false, accounts: false };

const REFUSAL: Record<Exclude<LinkState, "open">, () => BridgeError> = {
  connecting: () => ({ code: "disconnected", message: t("bot.offline") }),
  signed_out: () => ({ code: "signed_out", message: t("rt.signedOut") }),
  offline: () => ({ code: "offline", message: t("rt.offline") }),
  unavailable: () => ({ code: "unavailable", message: t("rt.unavailable") }),
};

export class HttpRuntime implements RuntimeAdapter {
  readonly kind = "http" as const;
  readonly capabilities = HTTP_CAPABILITIES;
  status: RuntimeStatus = "closed";
  private release: (() => void) | null = null;
  private offEvents: (() => void) | null = null;
  private offLink: (() => void) | null = null;
  private handlers = new Map<string, Set<(ev: never) => void>>();
  private statusHandlers = new Set<(s: RuntimeStatus) => void>();
  private waiting: { resolve: () => void; reject: (e: BridgeError) => void }[] = [];

  constructor(private readonly host: HttpHost) {}

  /** Joins the host and resolves once the shop has been read. Signed out or offline, it keeps waiting while the host
   *  tries again; `close` refuses the wait. */
  connect(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    const opened = new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    if (!this.release) {
      this.setStatus("connecting");
      this.offEvents = this.host.subscribe((ev) => this.deliver(ev));
      this.offLink = this.host.onLink((l) => this.follow(l));
      this.release = this.host.attach();
      this.follow(this.host.link);
    }
    return opened;
  }

  close(): void {
    this.offEvents?.();
    this.offLink?.();
    this.offEvents = this.offLink = null;
    const release = this.release;
    this.release = null;
    release?.();
    this.setStatus("closed");
    for (const w of this.waiting.splice(0)) w.reject(REFUSAL.connecting());
  }

  request<K extends Op>(op: K, params?: OpParams<K>): Promise<OpResult<K>> {
    if (!this.release) return Promise.reject<OpResult<K>>(REFUSAL.connecting());
    const link = this.host.link;
    if (link !== "open") return Promise.reject<OpResult<K>>(REFUSAL[link]());
    return this.host.handle(op, (params ?? {}) as Record<string, unknown>).then(
      (result) => result as OpResult<K>,
      (e: unknown) => {
        const error: BridgeError = e instanceof OpError ? { code: e.code, message: e.message } : { code: "internal", message: t("rt.unavailable") };
        throw error;
      },
    );
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

  private follow(link: LinkState): void {
    if (!this.release) return;
    this.setStatus(link === "open" ? "open" : link === "connecting" ? "connecting" : "closed");
    if (link === "open") for (const w of this.waiting.splice(0)) w.resolve();
  }

  private setStatus(s: RuntimeStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of [...this.statusHandlers]) h(s);
  }

  /** Each handler gets its own copy, as each would parse its own frame, so one screen cannot change what another reads. */
  private deliver(ev: HostEvent): void {
    for (const key of [ev.event, "*"]) {
      const set = this.handlers.get(key);
      if (set) for (const h of [...set]) h(JSON.parse(JSON.stringify(ev)) as never);
    }
  }
}

const sessions = new Map<string, ApiSession>();
const hosts = new Map<string, HttpHost>();

/** The page's one session with the API at `origin`, over the desktop shell's request command and keychain. Settings
 *  signs in and out through it, and the runtime reads through it, so both always agree. */
export function sessionFor(origin: string): ApiSession {
  let session = sessions.get(origin);
  if (!session) sessions.set(origin, (session = new ApiSession({ origin, fetch: shellFetch(), vault: shellVault() })));
  return session;
}

/** The page's one host for the API at `origin`. */
export function sharedHttpHost(origin: string): HttpHost {
  let host = hosts.get(origin);
  if (!host) hosts.set(origin, (host = new HttpHost({ session: sessionFor(origin) })));
  return host;
}
