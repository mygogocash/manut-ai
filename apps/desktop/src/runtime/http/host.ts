// The connected runtime's one host per page, as `MockHost` is the demo's: every client the app opens (the store's,
// Settings' short-lived ones, the session views') talks to the same host, so the shop is read once for all of them.
//
// The host keeps the latest read of the shop in memory only (an offline cache is a later slice), reads it again every
// minute while anyone is connected, and turns what changed between two reads into the protocol's events: a new
// action waiting for the owner is an ask, one that was decided or expired leaves Needs you, a new task or attention
// item appears. The changes of a task already listed show when the list is read again; following tasks live is the
// streaming slice (docs/runtime-adapter.md).
//
// Its link to the API is one of: connecting (the first read), open, signed out, offline, or unavailable (the API
// answered 5xx or something unreadable). Clients follow it: anything but open is a closed runtime to the store, which
// marks its chats stale and reads everything again when the runtime opens (store.ts `resync`). So a read after an
// outage replays nothing: the app's own re-read brings everything back.
//
// It changes nothing. Every write op answers `not_yet` until the approvals slice: answering an approval must go
// through `packages/approval-core`'s settle-once rules, never a second way round (CLAUDE.md).
import { t } from "../../i18n";
import type { BridgeEvent, OpMap } from "../../lib/protocol";
import type { NodeSessionResult } from "../../harness/session";
import type { ThreadEvent, ThreadOps } from "../../threads/types";
import { OpError } from "../mock/host";
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
}

const notFound = () => new OpError("not_found", t("rt.notFound"));
const notYet = (): never => {
  throw new OpError("not_yet", t("rt.notYet"));
};
/** A read the API cannot serve yet. It is not `notYet`'s words, which say that Connected only reads. */
const notYetShow = (): never => {
  throw new OpError("not_yet", t("rt.notYetShow"));
};
const FAILURE_TEXT: Record<ReadFailure, Parameters<typeof t>[0]> = { signed_out: "rt.signedOut", offline: "rt.offline", unavailable: "rt.unavailable" };

/** The signature of what a schedule shows, so a read that changed none of them stays quiet. */
const scheduleSig = (s: ShopSnapshot) =>
  JSON.stringify(s.schedules.map((x) => [x.id, x.name, x.revision, x.enabled, x.nextFire, x.hour, x.minute, x.weekdays]));

export class HttpHost {
  readonly session: ApiSession;
  link: LinkState = "connecting";
  private readonly now: () => number;
  private snapshot: ShopSnapshot | null = null;
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
  }

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
    return (this.ops[op as keyof AllOps] as (p: unknown) => unknown)(params);
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
    this.attempt = 0;
    this.setLink("connecting");
  }

  /** Signing in starts the reading; signing out, or the API ending the session, stops it and forgets the shop. */
  private onSession(s: SignInState): void {
    if (!this.running) return;
    if (s.kind === "signed_in") {
      if (this.link !== "open") void this.cycle();
    } else if (s.kind === "signed_out" || s.kind === "no_keychain") {
      this.clearTimer();
      this.snapshot = null;
      this.setLink("signed_out");
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
      this.setLink("signed_out");
      return;
    }
    await this.read();
  }

  /** One read at a time: every caller that asks while one runs gets its answer. */
  private read(): Promise<ShopRead> {
    return (this.reading ??= readShop(this.session, this.now).then((r) => {
      this.reading = null;
      this.apply(r);
      return r;
    }));
  }

  private apply(r: ShopRead): void {
    if (!this.running) return;
    if (!r.ok) {
      this.snapshot = null;
      this.setLink(r.failure);
      if (r.failure === "signed_out") this.clearTimer();
      else this.schedule(this.backoff());
      return;
    }
    this.attempt = 0;
    const was = this.snapshot;
    this.snapshot = r.snapshot;
    // Opening (the first read, or the first after an outage) replays nothing: the app reads everything on open.
    if (this.link !== "open" || !was) this.setLink("open");
    else this.emitChanges(was, r.snapshot);
    this.schedule(POLL_MS);
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

  private setLink(l: LinkState): void {
    if (this.link === l) return;
    this.link = l;
    for (const fn of [...this.linkFns]) fn(l);
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

  /** The latest read when it is fresh enough, else a new one. A read that fails fails the op with its reason. */
  private async current(): Promise<ShopSnapshot> {
    if (this.snapshot && this.now() - this.snapshot.readAt < FRESH_MS) return this.snapshot;
    const r = await this.read();
    if (!r.ok) throw new OpError(r.failure, t(FAILURE_TEXT[r.failure]));
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
      // Mission Control: the API keeps no job trace or activity log a session can read, and has no way to stop a team.
      "jobs.list": notYetShow,
      "jobs.get": notYetShow,
      "activity.list": notYetShow,
      "team.state": notYetShow,
      "team.pause": notYet,
      "team.resume": notYet,
      // What the team knows: the API serves a shop's memory to operators only (admin routes), so no session can read or
      // change it. Nothing the owner types is sent anywhere.
      "memory.list": notYetShow,
      "memory.remember": notYet,
      "memory.confirm": notYet,
      "memory.correct": notYet,
      "memory.forget": notYet,
    };
  })();
}
