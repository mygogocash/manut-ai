// The connected runtime's one host per page, as `MockHost` is the demo's: every client the app opens (the store's,
// Settings' short-lived ones, the session views') talks to the same host, so the shop is read once for all of them.
//
// The host keeps the latest read of the shop in memory, and on disk through the offline cache (cache.ts) after every
// good read. It reads the shop again every minute while anyone is connected, and turns what changed between two
// reads into the protocol's events: a new action waiting for the owner is an ask, one that was decided or expired
// leaves Needs you, a new task or attention item appears. The changes of a task already listed show when the list is
// read again; following tasks live is the streaming slice (docs/runtime-adapter.md).
//
// Its link to the API is one of: connecting (the first read), open, signed out, offline, or unavailable (the API
// answered 5xx or something unreadable). Clients follow it. When a read fails because the API is offline or not
// answering, the last good read stands in for the shop instead of an empty screen: the one this run made, else the one
// an earlier run kept on disk, if it is no more than 7 days old. `cache` says which (showing it and when it was read,
// too old to show, or none), the mode line says so in words, and the runtime stays open. A runtime with nothing to show
// is closed to the store, which marks its chats stale and reads everything again when the runtime opens (store.ts
// `resync`); the runtime also closes and opens once when the API answers again after a kept read stood in, so a read
// after an outage replays nothing: the app's own re-read brings everything back.
//
// It changes nothing. Every write op answers `not_yet` until the approvals slice: answering an approval must go
// through `packages/approval-core`'s settle-once rules, never a second way round (CLAUDE.md). While only a kept read is
// shown every write answers `offline` instead (an ask from it: "Connect to answer this"), and none is queued.
import { t } from "../../i18n";
import type { BridgeEvent, OpMap } from "../../lib/protocol";
import type { NodeSessionResult } from "../../harness/session";
import type { ThreadEvent, ThreadOps } from "../../threads/types";
import { OpError } from "../mock/host";
import { CACHE_MAX_AGE_MS, type CachedRead, type ShopCache } from "./cache";
import type { ApiSession, SignInState } from "./session";
import { readShop, type ReadFailure, type ShopRead, type ShopSnapshot } from "./shop";
import { attentionRows, automationRows, pendingAsks, routineRows, taskOpen, team, TEAM, threadRows } from "./view";

/** A read of the shop while open, every minute. */
export const POLL_MS = 60_000;
/** A list asked for within this long of the last read is answered from it. */
export const FRESH_MS = 15_000;
/** After a failed read: wait this long, doubling each time, up to the most. */
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

export type LinkState = "connecting" | "open" | ReadFailure;
export type HostEvent = BridgeEvent | ThreadEvent;

/** What stands in for the shop while the API cannot be reached: the last good read, shown, with the time it was read
 *  (ms); a read that is too old to show (more than 7 days), with the time it was read; or nothing at all (none was kept,
 *  or what was kept is damaged). Always `none` while the link is open or signed out. */
export type CacheView = { kind: "none" } | { kind: "showing"; at: number } | { kind: "too_old"; at: number };
const NO_CACHE: CacheView = { kind: "none" };
/** What a failed read leaves the screens: the read to answer from (null when none may be shown) and how to say so. */
interface StandIn {
  snapshot: ShopSnapshot | null;
  view: CacheView;
}
const sameView = (a: CacheView, b: CacheView) => a.kind === b.kind && (a.kind === "none" || (b.kind !== "none" && a.at === b.at));

/** Ops the app sends beside the protocol's op map, as `MockHost` answers them. */
interface ExtraOps {
  "runs.node_session": { params: { bot: string }; result: NodeSessionResult };
  "tasks.linear": { params: { bot: string }; result: { configured: boolean; server: string } };
}
type AllOps = OpMap & ThreadOps & ExtraOps;
/** Typed against every op, so an op added to the protocol does not compile until this runtime answers it. */
type Handlers = { [K in keyof AllOps]: (p: AllOps[K]["params"]) => AllOps[K]["result"] | Promise<AllOps[K]["result"]> };

export interface HostOptions {
  session: ApiSession;
  now?: () => number;
  /** Where the last good read is kept between runs. Without one the host still shows the last read of this run when the
   *  API cannot be reached, but a restart starts from nothing. */
  cache?: ShopCache;
  /** Whether a read may be kept now; always, when absent. Settings can move the saved choice off this shop while the
   *  page still runs it, and from then on nothing is kept, so the file that switch removed does not come back with the
   *  next read. */
  keeping?: () => boolean;
}

const notFound = () => new OpError("not_found", t("rt.notFound"));
const notYet = (): never => {
  throw new OpError("not_yet", t("rt.notYet"));
};
const FAILURE_TEXT: Record<ReadFailure, Parameters<typeof t>[0]> = { signed_out: "rt.signedOut", offline: "rt.offline", unavailable: "rt.unavailable" };

/** The signature of what a schedule shows, so a read that changed none of them stays quiet. */
const scheduleSig = (s: ShopSnapshot) =>
  JSON.stringify(s.schedules.map((x) => [x.id, x.name, x.revision, x.enabled, x.nextFire, x.hour, x.minute, x.weekdays]));

export class HttpHost {
  readonly session: ApiSession;
  link: LinkState = "connecting";
  /** What stands in for the shop while the link is offline or unavailable. Replaced only when it changes. */
  cache: CacheView = NO_CACHE;
  private readonly now: () => number;
  private readonly disk: ShopCache | undefined;
  private readonly keeping: () => boolean;
  /** What the screens are answered from: the latest good read, or while the API cannot be reached the kept one. */
  private snapshot: ShopSnapshot | null = null;
  /** The read an earlier run kept, looked at once for the outage that is on, and for whom (a new sign-in is a new look). */
  private onDisk: { tenant: string; read: CachedRead } | null = null;
  private clients = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private reading: Promise<ShopRead> | null = null;
  private offSession: (() => void) | null = null;
  private linkFns = new Set<(l: LinkState) => void>();
  private eventFns = new Set<(ev: HostEvent) => void>();

  constructor(opts: HostOptions) {
    this.session = opts.session;
    this.now = opts.now ?? Date.now;
    this.disk = opts.cache;
    this.keeping = opts.keeping ?? (() => true);
  }

  /** Whether the screens can be answered: the API answered, or its last answer is shown because it cannot be reached. */
  get usable(): boolean {
    return this.link === "open" || this.cache.kind === "showing";
  }

  /** Called when the link or what stands in for the shop changes; read `link` and `cache` for the new state. */
  onLink(fn: (l: LinkState) => void): () => void {
    this.linkFns.add(fn);
    return () => this.linkFns.delete(fn);
  }

  subscribe(fn: (ev: HostEvent) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }

  /** A client starts using the host; the first one starts the reading. Returns how the client lets go: the last one
   *  to let go stops it, so a closed app reads nothing. */
  attach(): () => void {
    this.clients += 1;
    if (this.clients === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.clients -= 1;
      if (this.clients === 0) this.stop();
    };
  }

  /** Answers one protocol op, or throws the `OpError` that refuses it. */
  async handle(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(this.ops, op)) throw new OpError("unknown_op", t("rt.notFound"));
    const handler = this.ops[op as keyof AllOps] as (p: unknown) => unknown;
    // Only a kept read answers while the API cannot be reached, so a write has nothing live to act on. It is refused, not
    // held to be sent later: an ask from the kept read needs the live record, and everything else the person says again.
    if (handler === notYet && this.cache.kind === "showing") throw new OpError("offline", t(op === "approval.respond" ? "rt.connectToAnswer" : "rt.offline"));
    return handler(params);
  }

  // ---- reading ----------------------------------------------------------------------------------------------------

  private start(): void {
    this.running = true;
    this.offSession = this.session.subscribe((s) => this.onSession(s));
    void this.cycle();
  }

  private stop(): void {
    this.running = false;
    this.clearTimer();
    this.offSession?.();
    this.offSession = null;
    this.snapshot = null;
    this.onDisk = null;
    this.attempt = 0;
    this.show("connecting", NO_CACHE);
  }

  /** Signing in starts the reading; signing out, or the API ending the session, stops it and forgets the shop. */
  private onSession(s: SignInState): void {
    if (!this.running) return;
    if (s.kind === "signed_in") {
      if (this.link !== "open") void this.cycle();
    } else if (s.kind === "signed_out" || s.kind === "no_keychain") {
      this.clearTimer();
      this.snapshot = null;
      this.onDisk = null;
      this.show("signed_out", NO_CACHE);
    }
  }

  private async cycle(): Promise<void> {
    this.clearTimer();
    if (!this.running) return;
    await this.session.load();
    if (!this.running) return;
    if (this.session.state.kind !== "signed_in") {
      // Nothing to read until someone signs in, which `onSession` hears.
      this.snapshot = null;
      this.onDisk = null;
      this.show("signed_out", NO_CACHE);
      return;
    }
    await this.read();
  }

  /** One read at a time: every caller that asks while one runs gets its answer. */
  private read(): Promise<ShopRead> {
    return (this.reading ??= this.fetchShop());
  }

  private async fetchShop(): Promise<ShopRead> {
    // Taken before the request goes out: a sign-out while it is on its way makes the ticket stale, and the cache then
    // refuses to keep what the request brings back.
    const ticket = this.disk?.ticket();
    let r: ShopRead;
    let standIn: StandIn | null = null;
    try {
      r = await readShop(this.session, this.now);
      if (!r.ok && r.failure !== "signed_out") standIn = await this.standIn();
    } finally {
      this.reading = null;
    }
    this.apply(r, standIn, ticket);
    return r;
  }

  /** What stands in for the shop when a read failed because the API is offline or not answering: the last good read of
   *  this run, else the one an earlier run kept (looked for once per outage), and either only while it is no more than
   *  7 days old. */
  private async standIn(): Promise<StandIn> {
    let found = this.snapshot;
    if (!found && this.disk) {
      const tenant = this.tenant();
      if (tenant) {
        if (this.onDisk?.tenant !== tenant) this.onDisk = { tenant, read: await this.disk.load(this.session.origin, tenant) };
        const read = this.onDisk.read;
        if (read.kind === "too_old") return { snapshot: null, view: { kind: "too_old", at: read.at } };
        if (read.kind === "usable") found = read.snapshot;
      }
    }
    if (!found) return { snapshot: null, view: NO_CACHE };
    if (this.now() - found.readAt > CACHE_MAX_AGE_MS) return { snapshot: null, view: { kind: "too_old", at: found.readAt } };
    return { snapshot: found, view: { kind: "showing", at: found.readAt } };
  }

  /** The tenant the session is signed in as, which names the file the read is kept in; null when it is not signed in. */
  private tenant(): string | null {
    const s = this.session.state;
    return s.kind === "signed_in" ? s.tenant : null;
  }

  private apply(r: ShopRead, standIn: StandIn | null, ticket: number | undefined): void {
    if (!this.running) return;
    if (!r.ok && r.failure === "signed_out") {
      this.snapshot = null;
      this.onDisk = null;
      this.show("signed_out", NO_CACHE);
      this.clearTimer();
      return;
    }
    // A read that finished after the session ended (the person signed out while it was on its way) says nothing about the
    // shop any more: it neither shows nor is kept.
    if (this.session.state.kind !== "signed_in") return;
    if (!r.ok) {
      this.snapshot = standIn?.snapshot ?? null;
      this.show(r.failure, standIn?.view ?? NO_CACHE);
      this.schedule(this.backoff());
      return;
    }
    this.attempt = 0;
    const was = this.snapshot;
    this.snapshot = r.snapshot;
    this.onDisk = null;
    // Opening (the first read, or the first after an outage) replays nothing: the app reads everything on open.
    if (this.link !== "open" || !was) this.show("open", NO_CACHE);
    else this.emitChanges(was, r.snapshot);
    this.schedule(POLL_MS);
    this.keep(r.snapshot, ticket);
  }

  /** Keeps the read on disk for the next run, unless Settings has moved the choice off this shop. Never waited on. */
  private keep(snapshot: ShopSnapshot, ticket: number | undefined): void {
    const tenant = this.tenant();
    if (!this.disk || ticket === undefined || !tenant || !this.keeping()) return;
    void this.disk.keep(this.session.origin, tenant, snapshot, ticket);
  }

  private backoff(): number {
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    return delay;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Moves to a link and what stands in for the shop with it, and tells the listeners when either changed. */
  private show(link: LinkState, cache: CacheView): void {
    const same = sameView(this.cache, cache);
    if (this.link === link && same) return;
    this.link = link;
    if (!same) this.cache = cache;
    for (const fn of [...this.linkFns]) fn(link);
  }

  private emit(ev: HostEvent): void {
    for (const fn of [...this.eventFns]) fn(ev);
  }

  /** What changed between two reads, as the events the store already follows. */
  private emitChanges(was: ShopSnapshot, now: ShopSnapshot): void {
    const before = new Set(pendingAsks(was).map((a) => a.request_id));
    const after = pendingAsks(now);
    for (const ask of after) if (!before.has(ask.request_id)) this.emit(ask);
    const still = new Set(after.map((a) => a.request_id));
    for (const id of before) {
      if (still.has(id)) continue;
      const action = now.tasks.flatMap((task) => task.actions).find((a) => a.id === id);
      // An action that ran out of time timed out; one that is gone with its task was cancelled; any other was decided.
      const reason = !action ? "cancelled" : action.state === "expired" || action.state === "proposed" ? "timeout" : "resolved";
      this.emit({ event: "prompt.expired", bot: TEAM, request_id: id, reason });
    }
    const had = new Set(was.tasks.map((task) => task.id));
    const has = new Set(now.tasks.map((task) => task.id));
    for (const row of threadRows(now)) if (!had.has(row.thread)) this.emit({ event: "thread.added", bot: TEAM, thread: row.thread, title: row.title });
    for (const id of had) if (!has.has(id)) this.emit({ event: "thread.removed", bot: TEAM, thread: id });
    const seen = new Set(attentionRows(was).map((m) => m.id));
    for (const row of attentionRows(now)) if (!seen.has(row.id)) this.emit({ event: "message", bot: TEAM, id: row.id, text: row.text });
    if (scheduleSig(was) !== scheduleSig(now)) this.emit({ event: "routines.update", bot: TEAM });
    if (team(was)[0].running !== team(now)[0].running) this.emit({ event: "bots.update", bot: TEAM });
  }

  /** The latest read when it is fresh enough, else a new one. While the API cannot be reached the kept read answers at
   *  once, with no request: the host's own retries find out when it can again. A read that fails with nothing kept to
   *  show fails the op with its reason. */
  private async current(): Promise<ShopSnapshot> {
    if (this.snapshot && (this.cache.kind === "showing" || this.now() - this.snapshot.readAt < FRESH_MS)) return this.snapshot;
    const r = await this.read();
    if (!r.ok) {
      if (this.snapshot) return this.snapshot;
      throw new OpError(r.failure, t(FAILURE_TEXT[r.failure]));
    }
    return r.snapshot;
  }

  /** The asks still waiting, sent again after `chat.open` answered, as a runtime replays them (store.ts dedupes). */
  private replayAsks(snapshot: ShopSnapshot): void {
    setTimeout(() => {
      if (this.running) for (const ask of pendingAsks(snapshot)) this.emit(ask);
    }, 0);
  }

  // ---- ops --------------------------------------------------------------------------------------------------------

  private readonly ops: Handlers = (() => {
    // Buddy is the only member, so any other name is one this runtime does not have.
    const member = (p: { bot?: unknown }) => {
      if (p.bot !== TEAM) throw new OpError("unknown_bot", t("rt.notFound"));
    };
    return {
      hello: () => ({ bridge: "real", version: "manut-api/v1", hermes: { home: "" } }),
      "bots.list": () => ({ bots: team(this.snapshot) }),
      "chat.open": async (p) => {
        member(p);
        const snapshot = await this.current();
        this.replayAsks(snapshot);
        return { session_id: `main-${TEAM}`, messages: attentionRows(snapshot), running: false, model: "", provider: "", reasoning: "" };
      },
      "thread.list": async (p) => (member(p), { threads: threadRows(await this.current()) }),
      "thread.open": async (p) => {
        member(p);
        const snapshot = await this.current();
        const task = snapshot.tasks.find((x) => x.id === p.thread);
        if (!task) throw notFound();
        return taskOpen(task, snapshot.readAt);
      },
      "routines.list": async (p) => (member(p), { routines: routineRows(await this.current()) }),
      "automations.list": async () => ({ automations: automationRows(await this.current()) }),
      "bots.info": async (p) => {
        member(p);
        const snapshot = await this.current();
        const rows = threadRows(snapshot);
        return {
          places: {},
          first_active: rows.length ? Math.min(...rows.map((r) => r.started_at)) : null,
          last_active: rows.length ? Math.max(...rows.map((r) => r.last ?? r.started_at)) : null,
          skills: 0,
          routines: snapshot.schedules.length,
        };
      },
      // Buddy's readiness is the API's to say; until it can, the chat treats an unknown answer as ready.
      "bots.ready": (p) => (member(p), { ok: true, provider: "", model: "", error: "", unknown: true }),
      "models.options": (p) => (member(p), { providers: [], current: { model: "", provider: "", reasoning: "" }, reasoning_levels: [] }),
      "skills.list": (p) => (member(p), { skills: [] }),
      "commands.list": (p) => (member(p), { commands: [] }),
      "bots.avatar": (p) => (member(p), { rev: null, data: null }),
      "bots.restart_scope": (p) => (member(p), { gateway: TEAM, bots: [{ name: TEAM, display_name: "Buddy" }] }),
      // What the API does not have is read as empty, so a screen that asks never waits on it.
      "elsewhere.list": (p) => (member(p), { sessions: [] }),
      "links.places": (p) => (member(p), { places: { slack: {}, discord: {} } }),
      "panel.terminal": (p) => (member(p), { runs: [] }),
      "panel.worktrees": (p) => (member(p), { worktrees: [] }),
      "runs.list": (p) => (member(p), { runs: [] }),
      "runs.prs": () => ({ prs: {} }),
      "runs.cli": () => ({ runs: [], agents: { claude: "no_adapter", codex: "no_adapter", omo: "no_adapter", pi: "no_adapter", omp: "no_adapter", grok: "no_adapter" } }),
      "runs.node_session": (p) => (member(p), { session: null }),
      "cli.title": () => ({ title: "" }),
      "tasks.linear": (p) => (member(p), { configured: false, server: "" }),
      "usage.read": () => ({ providers: [] }),
      "accounts.list": () => ({ groups: [] }),
      "plugins.list": (p) => (member(p), { plugins: [] }),
      "plugins.catalog": (p) => (member(p), { total: 0, matched: 0, entries: [], categories: {}, generated_at: null }),
      "panel.diff": () => {
        throw notFound();
      },
      "runs.get": () => {
        throw notFound();
      },
      "elsewhere.peek": () => {
        throw notFound();
      },
      "media.read": () => {
        throw notFound();
      },
      // Writes: none until the approvals slice.
      "chat.send": notYet,
      "chat.steer": notYet,
      "chat.interrupt": notYet,
      "approval.respond": notYet,
      "clarify.respond": notYet,
      "chat.set_model": notYet,
      "chat.attach": notYet,
      "folder.open": notYet,
      "folder.close": notYet,
      "folder.resume": notYet,
      "thread.create": notYet,
      "thread.remove": notYet,
      "bots.rename": notYet,
      "bots.set_avatar": notYet,
      "bots.restart": notYet,
      "automations.add": notYet,
      "automations.pause": notYet,
      "automations.resume": notYet,
      "automations.remove": notYet,
      "plugins.inspect": notYet,
      "plugins.install": notYet,
      "plugins.toggle": notYet,
      "plugins.update": notYet,
      "plugins.reload": notYet,
      "plugins.remove": notYet,
      "peers.probe": notYet,
      "peers.attach": notYet,
      "peers.detach": notYet,
      "accounts.add": notYet,
      "accounts.set_active": notYet,
      "accounts.remove": notYet,
      "accounts.label": notYet,
      "accounts.discard": notYet,
    };
  })();
}
