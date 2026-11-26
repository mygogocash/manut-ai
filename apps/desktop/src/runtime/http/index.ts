// The connected runtime's adapter: a thin client of the page's one `HttpHost` (host.ts), as `MockRuntime` is of the
// demo's `MockHost`. Each caller of `createRuntime` gets its own client; they all share the host's one session, one
// read of the shop and one timer, so the API is read once however many screens ask.
//
// Its status follows the host's link: open once the shop has been read; connecting before the first read; closed when
// signed out, or offline or facing an API that does not answer with nothing kept to show. A request while closed is
// refused with that reason, which the chat shows as it shows any refusal.
//
// While the API cannot be reached and the host shows the last good read instead (offline cache, cache.ts), the status
// stays open, so the screens show it instead of an empty screen. When the API answers again the status closes and opens
// once: the store reads everything again when the runtime opens, as after any outage, and that is what replaces what
// the kept read showed.
import { t } from "../../i18n";
import type { BridgeError, BridgeEvent, EventName, EventOf, Op, OpParams, OpResult } from "../../lib/protocol";
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeStatus } from "../adapter";
import { OpError } from "../mock/host";
import { readRuntimeSetting } from "../setting";
import { ShopCache } from "./cache";
import type { OwnerLink } from "./connections";
import type { FeedSocket, OpenSocket } from "./feed";
import { HttpHost, type HostEvent, type LinkState } from "./host";
import { followSignIn, shellOutpost } from "./outpost";
import { ApiSession } from "./session";
import { shellCacheStore, shellFetch, shellVault } from "./shell";

export { HttpHost, type CacheView, type LinkState } from "./host";
export { ApiSession } from "./session";

/** What the connected runtime offers beyond chat: the shop's schedules and its team's routines on the Automations page
 *  (an owner pauses and resumes a team routine there; the rest is read-only). The other groups belong to a runtime on
 *  this computer (Hermes' places, plugins, restarts, coding-CLI logins). */
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
  /** The screens are being answered from the kept read, not from the API. */
  private kept = false;
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
      this.offLink = this.host.onLink(() => this.follow());
      this.release = this.host.attach();
      this.follow();
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
    if (link !== "open" && !this.host.usable) return Promise.reject<OpResult<K>>(REFUSAL[link]());
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

  private follow(): void {
    if (!this.release) return;
    const link = this.host.link;
    const kept = link !== "open" && this.host.usable;
    // The kept read stood in for the shop, and the API answers again: close for a moment, so that opening makes the store
    // read everything again instead of keeping what the kept read showed.
    if (this.kept && link === "open") this.setStatus("closed");
    this.kept = kept;
    this.setStatus(link === "open" || kept ? "open" : link === "connecting" ? "connecting" : "closed");
    if (this.status === "open") for (const w of this.waiting.splice(0)) w.resolve();
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
let saved: ShopCache | null = null;

/** The page's one saved read of the shop, over the desktop shell's file commands. One for the whole page, so every call
 *  to the disk runs in turn, whichever origin it is for. */
export function shopCache(): ShopCache {
  return (saved ??= new ShopCache(shellCacheStore()));
}

/** Forgets the saved read of the shop. Signing out, a session the API ended, a new sign-in over another session, and
 *  Settings moving the choice off the shop all call it. */
export function forgetShop(): Promise<void> {
  return shopCache().clear();
}

/** Whether the choice saved on this computer is still Connected to `origin`. */
function stillConnectedTo(origin: string): boolean {
  const choice = readRuntimeSetting();
  return choice.mode === "connected" && choice.origin === origin;
}

/** The page's one session with the API at `origin`, over the desktop shell's request command and keychain. Settings
 *  signs in and out through it, and the runtime reads through it, so both always agree. When it ends, what was read
 *  with it is forgotten. This Mac's outpost follows it and the shop sessions it holds: it runs while the person is
 *  signed in to the shop it is registered for, or holds that shop's owner session, and stops as they sign out, the API
 *  ends the session, or their place in the shop ends (outpost.ts). */
export function sessionFor(origin: string): ApiSession {
  let session = sessions.get(origin);
  if (!session) {
    sessions.set(origin, (session = new ApiSession({ origin, fetch: shellFetch(), vault: shellVault(), onEnd: forgetShop })));
    followSignIn(session, shellOutpost(), () => t("outpost.windowTitle"));
  }
  return session;
}

/** The page's own WebSocket, which the shops' live feed opens (feed.ts), or none in a page that has no WebSocket. The
 *  app's CSP lets it reach Manut AI's own API hosts and nowhere else (src-tauri/tauri.conf.json). Its handlers take what the
 *  feed reads of their events, a message's data and a close's code, so it serves as the feed's socket as it is. */
function pageSocket(): { open: OpenSocket } | undefined {
  if (typeof WebSocket === "undefined") return undefined;
  return { open: (url, protocols) => new WebSocket(url, protocols) as unknown as FeedSocket };
}

/** The page's one host for the API at `origin`. It keeps each good read in the saved file, but only while the choice
 *  saved on this computer is still this origin, and follows each shop's live feed while the API says it is on. */
export function sharedHttpHost(origin: string): HttpHost {
  let host = hosts.get(origin);
  if (!host) {
    hosts.set(origin, (host = new HttpHost({ session: sessionFor(origin), cache: shopCache(), keeping: () => stillConnectedTo(origin),
      feed: pageSocket() })));
  }
  return host;
}

/** The host's word on the person's shops at `origin` and each one's own session, which registering this Mac goes through
 *  for the shop the page shows (outpost.ts), as the Connections ops do. */
export function ownerLinkFor(origin: string): OwnerLink {
  return sharedHttpHost(origin).ownerLink();
}
