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
// after an outage replays nothing but which asks are over: the app's own re-read brings everything else back.
//
// Its main write is answering an ask (`approval.respond`), and only through the API's decide route, where approval-core
// settles each request once with the role the session carries (`answer`; never a second way round, CLAUDE.md). The
// answer names the option by what it does and the revision the card showed, nothing else; the card is marked answered
// only when the API says so; and after any answer the shop is read again, so the card closes in the API's words
// ("Already decided by Mint at 19:42"). The owner's other everyday writes are the team's: pausing and resuming one of its
// routines, and Pause everyone, each through apps/api's own routines routes with the viewed shop's own owner session
// (`change`). None of them sends, posts, pays or deletes anything. Every other write answers `not_yet`, Buddy's chat
// included, which would need a model. While only a kept read is shown every write answers `offline` instead (an ask
// from it: "Connect to answer this"), and none is queued.
//
// Several shops (docs/several-shops.md). Each read starts with the person's shops (`GET /v1/shops`, with the sign-in).
// When they are in none, the signed-in tenant is read as above, as before shops. When they are in some, each shop is read
// with its own shop session (shops.ts): what waits there, and for a shop the person owns its tasks, schedules, attention
// items, team and routines as well (a helper's shop shows its asks only). Every shop's asks are one Needs you, each
// naming its shop and offering what the person's role there allows; the shop being viewed, which the switcher in the
// account row chooses (`shops.switch`), is what every other page shows: its team, its jobs and its routines. An answer, or a helper passing a
// request on, always goes with the session of the ask's own shop, which its id names, and never with the shop being
// viewed. A shop the person's place in ended (removed, unlinked, gone from the list) is said so, its asks close in those
// words, and its session and kept read are dropped at once.
//
// A helper's new device (docs/people.md). After each read, a shop the person owns is also asked which helpers signed in
// there, with that shop's own session and never a shop they help at (devices.ts). That is done in the background, after the
// read is taken, so a slow or failing devices route never holds back or fails the read of the shop. Each sign-in the app
// has not said yet is emitted once as `device.new`; the first look at a shop emits none, and what was seen is kept per shop
// on this computer and goes with the shop. The store turns the event into the notification (store.ts `notifySessionEvent`,
// notify.ts `showNewDevice`).
import { mayDecide } from "@manut/approval-core";
import { t } from "../../i18n";
import type { ApprovalChoice, BridgeEvent, OpMap, PassedOnNote, ShopLeft, ShopRow } from "../../lib/protocol";
import { leftWords, onlyOwnerWords } from "../../lib/shops";
import type { NodeSessionResult } from "../../harness/session";
import type { ThreadEvent, ThreadOps } from "../../threads/types";
import { OpError } from "../mock/host";
import { decisionPath, outcomeOf, type Closing } from "./answer";
import { answerable, isAsk, optionFor, parseAskId, parseShopAskId, type ShopApproval } from "./approvals";
import { CACHE_MAX_AGE_MS, type CachedRead, type ShopCache } from "./cache";
import { connectionHandlers, type OwnerLink } from "./connections";
import { shopRoutines, teamRoutineRow } from "./customize";
import { DeviceWatch, readDevices } from "./devices";
import { peopleHandlers } from "./people";
import type { TeamState } from "../mission";
import type { RoutineRow } from "../routines";
import type { ApiSession, SignInState } from "./session";
import { decodeTeam, decodeTeamRoutines, readShop, type ReadFailure, type ShopPart, type ShopRead, type ShopSnapshot, type ShopTeam, type TeamRoutine } from "./shop";
import { departureOf, listShops, ShopSessions, type Departure, type Left, type ShopAnswer } from "./shops";
import { attentionRows, automationRows, memberName, onTeam, pendingAsks, routineRows, taskOpen, team, TEAM, threadRows } from "./view";
import { activityOf, jobOf, jobRows, teamStateOf } from "./work";

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
  /** The shop sessions, over `session`; one of its own when absent. */
  shops?: ShopSessions;
  now?: () => number;
  /** Where the last good read is kept between runs. Without one the host still shows the last read of this run when the
   *  API cannot be reached, but a restart starts from nothing. */
  cache?: ShopCache;
  /** Whether a read may be kept now; always, when absent. Settings can move the saved choice off this shop while the
   *  page still runs it, and from then on nothing is kept, so the file that switch removed does not come back with the
   *  next read. */
  keeping?: () => boolean;
  /** What the app has already said of its shops' helpers' devices, kept on this computer; this computer's own storage when
   *  absent. */
  devices?: DeviceWatch;
}

const notFound = () => new OpError("not_found", t("rt.notFound"));
const notYet = (): never => {
  throw new OpError("not_yet", t("rt.notYet"));
};
/** A read the API cannot serve yet. It is not `notYet`'s words, which say what Connected does so far. */
const notYetShow = (): never => {
  throw new OpError("not_yet", t("rt.notYetShow"));
};
const FAILURE_TEXT: Record<ReadFailure, Parameters<typeof t>[0]> = { signed_out: "rt.signedOut", offline: "rt.offline", unavailable: "rt.unavailable" };
/** What a shop the person helps at answers about its team: it is its owner's to see and change. */
const ownerOnly = (shop: ShopRow) => new OpError("owner_only", t("rt.ownerOnly", { owner: shop.owner, shop: shop.name }));

/** A note passed on is 1 to 500 characters once trimmed, counted by character, as `@manut/people-rules` counts it
 *  (MAX_NOTE_LENGTH); the API checks it again. */
const MAX_NOTE = 500;
const PASS_ON_PATH = (requestId: string) => `/v1/approvals/${encodeURIComponent(requestId)}/pass-on`;

/** The shop a read names by id, among its shops. */
const partOf = (s: ShopSnapshot | null, shop: string): ShopPart | undefined => s?.shops?.find((p) => p.shop.id === shop);

/** The signature of the shops a read lists and the one it views, so a read that changed none of them stays quiet. */
const shopsSig = (s: ShopSnapshot | null) => JSON.stringify([s?.shops?.map((p) => [p.shop.id, p.shop.name, p.shop.owner, p.shop.role]) ?? null, s?.viewing ?? null]);

/** What an ask from one of several shops shows beyond its id, so a read that changed it (a note passed on since, a role
 *  that moved) sends the ask again and its card follows. */
const askSig = (a: { choices: unknown; pass_on?: unknown; passed_on?: unknown; shop?: unknown; outdated?: unknown }) => JSON.stringify([a.choices, a.pass_on ?? null, a.passed_on ?? null, a.shop ?? null, a.outdated ?? null]);

/** How an ask of one of several shops that left the open approvals closes: in the words of its shop's departure when the
 *  person's place there ended; "changed" when the request is asked again at another revision; else, by its expiry, timed
 *  out or answered elsewhere (a shop session reads no tasks, so nothing tells a decision from a withdrawal). */
function leftShopHow(askRef: string, was: ShopSnapshot, now: ShopSnapshot, departed: (shop: string) => string | null, at: number): Closing {
  const ref = parseShopAskId(askRef);
  if (!ref) return { reason: "cancelled" };
  const part = partOf(now, ref.shop);
  if (!part) {
    const words = departed(ref.shop);
    return words ? { reason: "cancelled", note: words } : { reason: "cancelled" };
  }
  if (part.approvals.some((a) => a.record.request.id === ref.id && isAsk(a))) return { reason: "cancelled", note: t("rt.ask.changed") };
  const before = partOf(was, ref.shop)?.approvals.find((a) => a.record.request.id === ref.id);
  const expiresAt = before?.record.request.expiresAt;
  return { reason: expiresAt !== undefined && expiresAt <= at ? "timeout" : "resolved" };
}

/** How an ask that left the open approvals with no answer from here closes, as `now` tells it. */
function leftHow(askRef: string, now: ShopSnapshot): Closing {
  const ref = parseAskId(askRef);
  if (ref && now.approvals.some((a) => a.record.request.id === ref.id && isAsk(a))) return { reason: "cancelled", note: t("rt.ask.changed") };
  const action = ref ? now.tasks.flatMap((task) => task.actions).find((a) => a.id === ref.id) : undefined;
  return { reason: !action ? "cancelled" : action.state === "expired" || action.state === "proposed" ? "timeout" : "resolved" };
}

/** The signature of what a schedule and a team routine show, so a read that changed none of them stays quiet. */
const scheduleSig = (s: ShopSnapshot) =>
  JSON.stringify([
    s.schedules.map((x) => [x.id, x.name, x.revision, x.enabled, x.nextFire, x.hour, x.minute, x.weekdays]),
    (s.routines ?? []).map((r) => [r.id, r.name, r.member, r.when, r.paused, r.next, r.asksFirst]),
  ]);

/** The signature of what the team shows: who is on it, and each one's status, work and pause. */
const teamSig = (s: ShopSnapshot | null) => JSON.stringify(team(s).map((b) => [b.name, b.status, b.running, b.paused ?? false]));

/** The writes the owner makes to the viewed shop's team (`change`): refused while only a kept read is shown, as every
 *  write is. */
const TEAM_CHANGES = new Set(["team.pause", "team.resume", "routine.pause", "routine.resume", "automations.pause", "automations.resume"]);

export class HttpHost {
  readonly session: ApiSession;
  link: LinkState = "connecting";
  /** What stands in for the shop while the link is offline or unavailable. Replaced only when it changes. */
  cache: CacheView = NO_CACHE;
  private readonly now: () => number;
  private readonly disk: ShopCache | undefined;
  private readonly keeping: () => boolean;
  private readonly shopSessions: ShopSessions;
  private readonly devices: DeviceWatch;
  /** What the screens are answered from: the latest good read, or while the API cannot be reached the kept one. */
  private snapshot: ShopSnapshot | null = null;
  /** The shop the person chose to view, when they are in several; the first one listed until they choose. */
  private viewing: string | null = null;
  /** The shops the person's place in ended while this ran, newest first: the account row says so until the app starts
   *  again, and their asks close in these words. */
  private departed: { shop: ShopRow; departure: Departure }[] = [];
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
  /** How the card of an ask the person answered here closes, in the API's words, kept until the ask leaves the shop's
   *  open approvals (`emitLeft`). By ask id. */
  private closings = new Map<string, Closing>();

  constructor(opts: HostOptions) {
    this.session = opts.session;
    this.now = opts.now ?? Date.now;
    this.disk = opts.cache;
    this.keeping = opts.keeping ?? (() => true);
    this.shopSessions = opts.shops ?? new ShopSessions(opts.session, this.now);
    this.devices = opts.devices ?? new DeviceWatch();
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
    const asks = op === "approval.respond" || op === "approval.pass_on";
    const writes = handler === notYet || asks || TEAM_CHANGES.has(op);
    if (writes && this.cache.kind === "showing") throw new OpError("offline", t(asks ? "rt.connectToAnswer" : "rt.offline"));
    return handler(params);
  }

  // ---- reading ----------------------------------------------------------------------------------------------------

  private start(): void {
    this.running = true;
    // A look at the disk that was on its way when the host last stopped can end after the stop and leave its answer here;
    // by now the person may have signed out and deleted what it found, so a start never trusts an earlier look.
    this.onDisk = null;
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
    this.closings.clear();
    this.viewing = null;
    this.departed = [];
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
      this.closings.clear();
      this.viewing = null;
      this.departed = [];
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

  /** A read that starts after now. One already on its way may have been asked before what just changed (an answer), so it
   *  is waited out first. */
  private async refresh(): Promise<void> {
    const before = this.reading;
    if (before) await before;
    if (this.running) await this.read();
  }

  private async fetchShop(): Promise<ShopRead> {
    // Taken before the request goes out: a sign-out while it is on its way makes the ticket stale, and the cache then
    // refuses to keep what the request brings back.
    const ticket = this.disk?.ticket();
    let r: ShopRead;
    let standIn: StandIn | null = null;
    try {
      r = await this.readAll();
      if (!r.ok && r.failure !== "signed_out") standIn = await this.standIn();
    } finally {
      this.reading = null;
    }
    this.apply(r, standIn, ticket);
    return r;
  }

  /** One read of what the screens show: the person's shops first. In none, the signed-in tenant as before shops; in
   *  some, each one's asks with its own session, and the one viewed as the pages' shop. A shop the person's place in
   *  ended on the way is said so at once (`depart`), whatever else the read finds. */
  private async readAll(): Promise<ShopRead> {
    const listed = await listShops(this.session);
    if (!listed.ok) return { ok: false, failure: listed.failure };
    const read = await this.shopSessions.readAll(listed.shops);
    this.depart(read.left, listed.shops);
    if (!read.ok) return { ok: false, failure: read.failure };
    if (read.parts.length) return { ok: true, snapshot: this.atShops(read.parts, read.unreadable, this.now()) };
    // In no shop, or every one left in this very read: the signed-in tenant, as before shops.
    return readShop(this.session, this.now);
  }

  /** A read of several shops, viewing the one the person chose while it is still theirs, else the first listed. The pages
   *  show the viewed shop's own read: for a shop the person owns its tasks, schedules, attention items, team and routines;
   *  for one they help at, what waits there and nothing else. */
  private atShops(parts: ShopPart[], unreadable: unknown[], readAt: number): ShopSnapshot {
    const viewed = parts.find((p) => p.shop.id === this.viewing) ?? parts[0];
    const work = viewed.work;
    return {
      tasks: work?.tasks ?? [],
      approvals: viewed.approvals,
      schedules: work?.schedules ?? [],
      attention: work?.attention ?? [],
      attentionOff: !work,
      unreadable,
      readAt,
      shops: parts,
      viewing: viewed.shop.id,
      ...(work ? { team: work.team, routines: work.routines } : {}),
    };
  }

  /** The person's place in these shops ended. Each is said so (the account row's notice, `shops.list`), its asks close in
   *  those words, and what was read of it goes at once: from what the screens show, and from the kept read on disk, which
   *  is written again without it. Its session already went (shops.ts). */
  private depart(left: readonly Left[], listed: readonly ShopRow[] = []): void {
    if (!left.length) return;
    const was = this.snapshot;
    for (const { shop, departure } of left) {
      const row = partOf(was, shop)?.shop ?? listed.find((r) => r.id === shop) ?? { id: shop, name: "", owner: "", role: "helper" as const };
      this.departed = [{ shop: row, departure }, ...this.departed.filter((d) => d.shop.id !== shop)];
    }
    if (was?.shops) {
      const parts = was.shops.filter((p) => !left.some((l) => l.shop === p.shop.id));
      if (parts.length !== was.shops.length) {
        // With none left, the screens show no shop until the next read, which reads the signed-in tenant instead.
        const now: ShopSnapshot = parts.length
          ? this.atShops(parts, was.unreadable, was.readAt)
          : { tasks: [], approvals: [], schedules: [], attention: [], attentionOff: true, unreadable: was.unreadable, readAt: was.readAt, shops: [] };
        this.snapshot = now;
        this.emitLeft(was, now);
        const ticket = this.disk?.ticket();
        if (this.cache.kind !== "showing") this.keep(now, ticket);
      }
    }
    this.emit({ event: "shops.update", bot: TEAM });
  }

  /** What the app says about a shop the person's place in ended this run, or null when nothing was said of it. */
  private departedWords(shop: string): string | null {
    const d = this.departed.find((x) => x.shop.id === shop);
    return d ? leftWords({ name: d.shop.name, owner: d.shop.owner, why: d.departure.why, at: d.departure.at === null ? null : d.departure.at / 1000 }) : null;
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
      if (standIn?.snapshot?.viewing) this.viewing = standIn.snapshot.viewing;
      this.show(r.failure, standIn?.view ?? NO_CACHE);
      this.schedule(this.backoff());
      return;
    }
    this.attempt = 0;
    const was = this.snapshot;
    this.snapshot = r.snapshot;
    this.viewing = r.snapshot.viewing ?? null;
    this.onDisk = null;
    // Opening (the first read, or the first after an outage) replays nothing: the app reads everything on open. One thing
    // it cannot read again is an ask card it already holds: the store keeps those across a re-read, so an ask the read that
    // stood in for the shop showed, and that is not waiting now (decided meanwhile, expired, its task gone), is said to be
    // over here, or it would stay in Needs you.
    if (this.link !== "open" || !was) {
      this.show("open", NO_CACHE);
      if (was) this.emitLeft(was, r.snapshot);
    } else this.emitChanges(was, r.snapshot);
    this.schedule(POLL_MS);
    this.keep(r.snapshot, ticket);
    this.lookAtDevices(r.snapshot);
  }

  /** After a read is taken: forgets what the app saw of the shops the person no longer owns, then asks each shop they own
   *  which helpers signed in there (each with its own session, a shop they help at never) and tells the sign-ins it has not
   *  told yet. Each shop is read in the background and never waited on: the asks are what the owner must see, and a route
   *  that is slow or down must not hold them back. */
  private lookAtDevices(snapshot: ShopSnapshot): void {
    const owned = (snapshot.shops ?? []).filter((p) => p.shop.role === "owner").map((p) => p.shop);
    this.devices.keepOnly(owned.map((shop) => shop.id));
    for (const shop of owned) void this.tellDevicesOf(shop).catch(() => undefined);
  }

  /** Reads `shop`'s devices and says each sign-in the app has not said yet (`device.new`), once, oldest first. A read that
   *  did not work says and remembers nothing, and so does one that ended after the person signed out (which clears what the
   *  host holds of the shops) or left the shop, or after the host stopped: the next read that works tells the sign-ins. */
  private async tellDevicesOf(shop: ShopRow): Promise<void> {
    const listed = await readDevices(this.shopSessions, shop);
    if (!listed || !this.running || partOf(this.snapshot, shop.id)?.shop.role !== "owner") return;
    for (const d of this.devices.fresh(shop.id, listed)) {
      this.emit({ event: "device.new", bot: TEAM, id: d.id, helper: d.name, shop: { id: shop.id, name: shop.name }, at: d.openedAt / 1000 });
    }
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

  /** Each ask that was waiting in `was` and is not in `now`, as the event that takes it out of Needs you. An ask the
   *  person answered here closes in the words the API gave (`closings`). Any other is read from `now`: a request asked
   *  again at another revision changed, and its new version is an ask of its own; otherwise its action says how it went.
   *  An action that ran out of time timed out, one that is gone with its task was cancelled, any other was decided. */
  private emitLeft(was: ShopSnapshot, now: ShopSnapshot): void {
    const still = new Set(pendingAsks(now).map((a) => a.request_id));
    const shops = !!(was.shops || now.shops);
    for (const { request_id: id } of pendingAsks(was)) {
      if (still.has(id)) continue;
      const closing = this.closings.get(id) ?? (shops ? leftShopHow(id, was, now, (shop) => this.departedWords(shop), this.now()) : leftHow(id, now));
      this.closings.delete(id);
      this.emit({ event: "prompt.expired", bot: TEAM, request_id: id, reason: closing.reason, ...(closing.note ? { note: closing.note } : {}) });
    }
  }

  /** The person's answer to an ask, sent to the decide route as exactly the option that does what they chose and the
   *  revision their card showed; the role is the session's, never sent. Refused here, with nothing sent, for an ask the
   *  shop no longer holds, one the shop has moved to another revision since the card showed it, one this build cannot
   *  answer, and a choice the request does not offer. Taken only when the API says it was decided; after any answer sent,
   *  whatever came back, the shop is read again. */
  private async answer(askRef: string, choice: ApprovalChoice): Promise<Record<string, never>> {
    if (this.snapshot?.shops) return this.answerAtShop(this.snapshot, askRef, choice);
    const ref = parseAskId(askRef);
    const snapshot = this.snapshot;
    const approval = ref && snapshot ? snapshot.approvals.find((a) => a.record.request.id === ref.id && isAsk(a)) : undefined;
    if (!ref || !snapshot || !approval) throw notFound();
    if (approval.record.request.revision !== ref.revision) throw new OpError("changed", t("rt.ask.changed"));
    const request = answerable(approval);
    if (!request) throw new OpError("update_app", t("rt.updateToAnswer"));
    const option = optionFor(request, choice);
    if (!option) throw new OpError("not_offered", t("rt.ask.notOffered"));
    const answered = await this.session.write(decisionPath(request.id), { optionId: option.id, seenRevision: ref.revision });
    const names = new Map(snapshot.approvals.flatMap((a) => (a.passedOn?.name ? [[a.passedOn.by, a.passedOn.name] as const] : [])));
    const outcome = outcomeOf(answered, { kind: request.kind, names, now: this.now() });
    if (!outcome.ok && outcome.closing) this.closings.set(askRef, outcome.closing);
    void this.refresh().catch(() => undefined);
    if (!outcome.ok) throw new OpError(outcome.code, outcome.words);
    return {};
  }

  /** The ask `askRef` names among the shops of `snapshot`, with its shop: the shop its id names, never the one viewed.
   *  Refused, with nothing sent, for an ask no shop of the read holds now and for one the shop has moved to another
   *  revision since its card showed it. */
  private askAtShop(snapshot: ShopSnapshot, askRef: string): { part: ShopPart; approval: ShopApproval; revision: number } {
    const ref = parseShopAskId(askRef);
    const part = ref ? partOf(snapshot, ref.shop) : undefined;
    const approval = ref && part ? part.approvals.find((a) => a.record.request.id === ref.id && isAsk(a)) : undefined;
    if (!ref || !part || !approval) throw notFound();
    if (approval.record.request.revision !== ref.revision) throw new OpError("changed", t("rt.ask.changed"));
    return { part, approval, revision: ref.revision };
  }

  /** An answer to an ask of one of several shops: as `answer` is, but sent with that shop's own session (shops.ts), and
   *  refused here, with nothing sent, when the person's role there may not decide the request's kind (approval-core's
   *  `mayDecide`, the rule the API decides with). */
  private async answerAtShop(snapshot: ShopSnapshot, askRef: string, choice: ApprovalChoice): Promise<Record<string, never>> {
    const { part, approval, revision } = this.askAtShop(snapshot, askRef);
    const request = answerable(approval);
    if (!request) throw new OpError("update_app", t("rt.updateToAnswer"));
    if (!mayDecide(part.shop.role, request.kind)) throw new OpError("not_permitted", onlyOwnerWords(request.kind, part.shop.owner));
    const option = optionFor(request, choice);
    if (!option) throw new OpError("not_offered", t("rt.ask.notOffered"));
    const answered = await this.shopSessions.write(part.shop.id, decisionPath(request.id), { optionId: option.id, seenRevision: revision });
    if (answered.kind === "left") {
      this.depart([{ shop: part.shop.id, departure: answered.departure }]);
      throw new OpError(answered.departure.why, this.departedWords(part.shop.id) ?? t("rt.notFound"));
    }
    const names = new Map(part.approvals.flatMap((a) => (a.passedOn?.name ? [[a.passedOn.by, a.passedOn.name] as const] : [])));
    const outcome = outcomeOf(answered, { kind: request.kind, names, now: this.now() });
    if (!outcome.ok && outcome.closing) this.closings.set(askRef, outcome.closing);
    void this.refresh().catch(() => undefined);
    if (!outcome.ok) throw new OpError(outcome.code, outcome.words);
    return {};
  }

  /** A helper passing an ask of their shop on to its owner, with a note, through that shop's own session: exactly
   *  `{ note }` (docs/pilot-api.md, "A helper's own routes"). It decides nothing; the ask keeps waiting for the owner.
   *  Refused here, with nothing sent, for anything but a request the person may pass on: a helper's, of a kind only the
   *  owner decides, not passed on yet, and a note of 1 to 500 characters. */
  private async passOn(askRef: string, note: string): Promise<{ passed_on: PassedOnNote }> {
    const snapshot = this.snapshot;
    if (!snapshot?.shops) throw notFound();
    const { part, approval } = this.askAtShop(snapshot, askRef);
    const request = answerable(approval);
    if (!request) throw new OpError("update_app", t("rt.updateToAnswer"));
    if (part.shop.role !== "helper") throw new OpError("not_a_helper", t("rt.pass.helpersOnly"));
    if (mayDecide("helper", request.kind)) throw new OpError("decide_yourself", t("rt.pass.yours"));
    if (approval.passedOn) throw new OpError("already_passed", t("rt.pass.already", { owner: part.shop.owner }));
    const text = typeof note === "string" ? note.trim() : "";
    if (!text || [...text].length > MAX_NOTE) throw new OpError("bad_note", t("rt.pass.badNote"));
    const answered = await this.shopSessions.write(part.shop.id, PASS_ON_PATH(request.id), { note: text });
    void this.refresh().catch(() => undefined);
    if (answered.kind === "left") {
      this.depart([{ shop: part.shop.id, departure: answered.departure }]);
      throw new OpError(answered.departure.why, this.departedWords(part.shop.id) ?? t("rt.notFound"));
    }
    if (answered.kind === "ok") return { passed_on: { name: "", note: text, at: this.now() / 1000 } };
    if (answered.kind !== "refused") throw new OpError(answered.kind, t(answered.kind === "signed_out" ? "rt.signedOut" : "rt.ask.noReply"));
    const words: Record<string, string> = {
      bad_note: t("rt.pass.badNote"),
      decide_yourself: t("rt.pass.yours"),
      already_passed: t("rt.pass.already", { owner: part.shop.owner }),
      not_a_helper: t("rt.pass.helpersOnly"),
      not_found: t("rt.notFound"),
    };
    throw new OpError(answered.code || "refused", words[answered.code] ?? t("rt.ask.refused"));
  }

  /** Shows `shop` on every page from now on: one of the shops of the latest read (or of the kept one), and nothing is read
   *  for it, since what a shop session may read of it, what waits there, is in every read already. */
  private switchTo(shop: string): Record<string, never> {
    const snapshot = this.snapshot;
    const part = partOf(snapshot, shop);
    if (!snapshot?.shops || !part) throw notFound();
    if (snapshot.viewing === shop) return {};
    this.viewing = shop;
    this.snapshot = this.atShops(snapshot.shops, snapshot.unreadable, snapshot.readAt);
    this.emit({ event: "shops.update", bot: TEAM });
    return {};
  }

  /** The person's shops for the switcher: the ones they own first, the one viewed, and the ones whose place ended. */
  private shopList(): OpMap["shops.list"]["result"] {
    const snapshot = this.snapshot;
    const left: ShopLeft[] = this.departed.map(({ shop, departure }) => ({
      id: shop.id,
      name: shop.name,
      owner: shop.owner,
      why: departure.why,
      at: departure.at === null ? null : departure.at / 1000,
    }));
    return { shops: snapshot?.shops?.map((p) => ({ ...p.shop })) ?? [], current: snapshot?.shops ? (snapshot.viewing ?? null) : null, left };
  }

  /** What changed between two reads, as the events the store already follows. An ask of one of several shops that is
   *  still waiting but shows otherwise now (a note passed on since, a role that moved) is sent again, and its card
   *  follows; the shops listed, or the one viewed, changing is `shops.update`. */
  private emitChanges(was: ShopSnapshot, now: ShopSnapshot): void {
    const before = new Map(pendingAsks(was).map((a) => [a.request_id, askSig(a)]));
    for (const ask of pendingAsks(now)) {
      const sig = before.get(ask.request_id);
      if (sig === undefined || (ask.shop && sig !== askSig(ask))) this.emit(ask);
    }
    this.emitLeft(was, now);
    if (shopsSig(was) !== shopsSig(now)) this.emit({ event: "shops.update", bot: TEAM });
    const had = new Set(was.tasks.map((task) => task.id));
    const has = new Set(now.tasks.map((task) => task.id));
    for (const row of threadRows(now)) if (!had.has(row.thread)) this.emit({ event: "thread.added", bot: TEAM, thread: row.thread, title: row.title });
    for (const id of had) if (!has.has(id)) this.emit({ event: "thread.removed", bot: TEAM, thread: id });
    const seen = new Set(attentionRows(was).map((m) => m.id));
    for (const row of attentionRows(now)) if (!seen.has(row.id)) this.emit({ event: "message", bot: TEAM, id: row.id, text: row.text });
    if (scheduleSig(was) !== scheduleSig(now)) this.emit({ event: "routines.update", bot: TEAM });
    if (teamSig(was) !== teamSig(now)) this.emit({ event: "bots.update", bot: TEAM });
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

  // ---- the owner's changes to the team ---------------------------------------------------------------------------

  /** The viewed shop, when the person owns it and its team was read: the one shop whose routines and team the owner's
   *  writes change, always with its own session. Refused here, with nothing sent, for the signed-in tenant (the API knows
   *  no team for it: not yet) and for a shop the person helps at (the team there is its owner's). */
  private ownedTeam(): { shop: ShopRow; snapshot: ShopSnapshot } {
    const snapshot = this.snapshot;
    const part = snapshot?.viewing ? partOf(snapshot, snapshot.viewing) : undefined;
    if (!snapshot || !part) return notYet();
    if (part.shop.role !== "owner") throw ownerOnly(part.shop);
    if (!part.work || !snapshot.team) return notYet();
    return { shop: part.shop, snapshot };
  }

  /** Sends one change to the viewed shop's team, as exactly `body`, with that shop's own session, and reads the shop again
   *  whatever came back, so every page shows what the API holds. The API's answer when it made the change; else the
   *  refusal, in words. A change that got no answer is never sent again from here: the API may have it, and the read that
   *  follows says. */
  private async change(path: string, body: Record<string, unknown>): Promise<unknown> {
    const { shop } = this.ownedTeam();
    const answer = await this.shopSessions.write(shop.id, path, body);
    void this.refresh().catch(() => undefined);
    if (answer.kind === "ok") return answer.json;
    throw this.changeRefused(shop, answer);
  }

  private changeRefused(shop: ShopRow, answer: Exclude<ShopAnswer, { kind: "ok" }>): OpError {
    if (answer.kind === "left") {
      this.depart([{ shop: shop.id, departure: answer.departure }]);
      return new OpError(answer.departure.why, this.departedWords(shop.id) ?? t("rt.notFound"));
    }
    if (answer.kind === "signed_out") return new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") return new OpError("offline", t("rt.offline"));
    if (answer.kind === "unavailable") return new OpError("unavailable", t("rt.change.noReply"));
    if (answer.status === 403 && answer.code === "owner_only") return ownerOnly(shop);
    if (answer.status === 404) return new OpError("not_found", t("rt.notFound"));
    return new OpError(answer.code || "refused", t("rt.change.refused"));
  }

  /** Pause everyone, or Resume everyone: `POST /v1/team/pause` or `/v1/team/resume` with exactly `{}`. apps/api's pause
   *  holds the team's routines and nothing else, and its answer is the team as it now stands, shown at once. */
  private async pauseTeam(paused: boolean): Promise<TeamState> {
    const answered = decodeTeam(await this.change(paused ? "/v1/team/pause" : "/v1/team/resume", {}));
    if (!answered) throw new OpError("unavailable", t("rt.change.noReply"));
    this.showTeam((s) => ({ ...s, team: answered }));
    const state = this.snapshot && teamStateOf(this.snapshot);
    if (!state) throw new OpError("unavailable", t("rt.change.noReply"));
    return state;
  }

  /** Pauses or resumes one of the viewed shop's routines: `POST /v1/routines/pause` or `/v1/routines/resume` with exactly
   *  `{ routineId }`. Only a routine the read lists is sent. Its answer is the routine as it now stands, shown at once. */
  private async switchRoutine(routineId: unknown, on: boolean): Promise<RoutineRow> {
    const { snapshot } = this.ownedTeam();
    if (typeof routineId !== "string" || !snapshot.routines?.some((r) => r.id === routineId)) throw notFound();
    const json = (await this.change(on ? "/v1/routines/resume" : "/v1/routines/pause", { routineId })) as { routine?: unknown } | null;
    const [routine] = decodeTeamRoutines({ routines: [json?.routine ?? null] }, []);
    if (!routine || routine.id !== routineId) throw new OpError("unavailable", t("rt.change.noReply"));
    this.showTeam((s) => ({ ...s, routines: s.routines.map((r) => (r.id === routine.id ? routine : r)) }));
    return teamRoutineRow(routine);
  }

  /** The Automations page pausing or resuming a row: one of the team's routines goes the same way as from Customize. A
   *  schedule of the shop's own is not the owner's to change from a session (the API answers it 401), so it is not yet. */
  private async switchAutomation(p: { bot?: unknown; job?: unknown }, on: boolean): Promise<{ job: string }> {
    const routine = this.snapshot?.routines?.find((r) => r.id === p.job && r.member === p.bot);
    if (!routine) return notYet();
    await this.switchRoutine(routine.id, on);
    return { job: routine.id };
  }

  /** Shows the viewed shop's team and routines as the API just answered a change, until the read that follows replaces
   *  them, and tells the screens what moved. */
  private showTeam(edit: (w: { team: ShopTeam; routines: TeamRoutine[] }) => { team: ShopTeam; routines: TeamRoutine[] }): void {
    const was = this.snapshot;
    if (!was?.team || !was.viewing) return;
    const next = edit({ team: was.team, routines: was.routines ?? [] });
    const shops = was.shops?.map((p) => (p.shop.id === was.viewing && p.work ? { ...p, work: { ...p.work, ...next } } : p));
    this.snapshot = { ...was, ...next, ...(shops ? { shops } : {}) };
    if (teamSig(was) !== teamSig(this.snapshot)) this.emit({ event: "bots.update", bot: TEAM });
    if (scheduleSig(was) !== scheduleSig(this.snapshot)) this.emit({ event: "routines.update", bot: TEAM });
  }

  // ---- Customize › Connections ----------------------------------------------------------------------------------

  /** What the Connections ops need of this host (connections.ts): the shop the switcher shows, the person's role at each
   *  shop, each shop's own session (or the sign-in while they are in no shops), and the host's word on a shop the
   *  person's place in ended. Nothing the ops send is kept here. Registering this Mac as an outpost uses it too
   *  (outpost.ts), so it goes with the session of the shop the page shows, as a change to the vault does. */
  ownerLink(): OwnerLink {
    return {
      live: () => {
        if (this.cache.kind === "showing") throw new OpError("offline", t("rt.offline"));
      },
      viewed: async () => {
        const snapshot = this.snapshot ?? (await this.current());
        if (!snapshot.shops) return null;
        const part = partOf(snapshot, snapshot.viewing ?? "");
        if (!part) throw notFound();
        return { shop: part.shop.id, role: this.shopSessions.roleAt(part.shop) };
      },
      roleAt: (shop) => {
        const part = partOf(this.snapshot, shop);
        return part ? this.shopSessions.roleAt(part.shop) : undefined;
      },
      inShops: () => !!this.snapshot?.shops,
      read: (shop, path) => (shop === null ? this.session.read(path) : this.shopSessions.read(shop, path)),
      write: (shop, path, body) => (shop === null ? this.session.write(path, body) : this.shopSessions.write(shop, path, body)),
      writeVia: (shop, path, body, through) =>
        shop === null ? this.session.writeVia(path, body, through) : this.shopSessions.writeVia(shop, path, body, through),
      writeOnce: async (shop, path, body) => {
        if (shop === null) return this.session.writeOnce(path, body);
        // The shop's session as it is held now, which the read just before opened or renewed (connections.ts). It is sent
        // once, and not again after a 401 as shops.ts would send it.
        const held = this.session.shopSession(shop);
        if (!held) return { kind: "unavailable" };
        const answer = await this.session.sendAs(held.accessToken, "POST", path, body);
        const ended = departureOf(answer);
        if (!ended) return answer;
        await this.session.dropShopSessions([shop]);
        return { kind: "left", departure: ended };
      },
      departed: (shop, departure) => {
        this.depart([{ shop, departure }]);
        return new OpError(departure.why, this.departedWords(shop) ?? t("rt.notFound"));
      },
    };
  }

  // ---- ops --------------------------------------------------------------------------------------------------------

  private readonly ops: Handlers = (() => {
    // The team the viewed shop's read lists: Buddy always, and for a shop the person owns its members. Any other name is
    // one this runtime does not have.
    const member = (p: { bot?: unknown }) => {
      if (!onTeam(this.snapshot, p.bot)) throw new OpError("unknown_bot", t("rt.notFound"));
    };
    return {
      hello: () => ({ bridge: "real", version: "manut-api/v1", hermes: { home: "" } }),
      "bots.list": () => ({ bots: team(this.snapshot) }),
      // Buddy's chat holds the asks and the attention notes. The API keeps no chat with a member, so a member's is empty:
      // their work shows as jobs, and their drafts in the task's notes.
      "chat.open": async (p) => {
        member(p);
        const snapshot = await this.current();
        if (p.bot !== TEAM) return { session_id: `main-${String(p.bot)}`, messages: [], running: false, model: "", provider: "", reasoning: "" };
        this.replayAsks(snapshot);
        return { session_id: `main-${TEAM}`, messages: attentionRows(snapshot), running: false, model: "", provider: "", reasoning: "" };
      },
      // Every task is one of Buddy's threads, as before members: History and Recent list each once.
      "thread.list": async (p) => (member(p), { threads: p.bot === TEAM ? threadRows(await this.current()) : [] }),
      "thread.open": async (p) => {
        member(p);
        const snapshot = await this.current();
        const task = p.bot === TEAM ? snapshot.tasks.find((x) => x.id === p.thread) : undefined;
        if (!task) throw notFound();
        return taskOpen(task, snapshot.readAt);
      },
      "routines.list": async (p) => (member(p), { routines: routineRows(await this.current(), p.bot) }),
      "automations.list": async () => ({ automations: automationRows(await this.current()) }),
      "bots.info": async (p) => {
        member(p);
        const snapshot = await this.current();
        // Buddy's are every task, as his threads are; a member's are their jobs.
        const times = p.bot === TEAM ? threadRows(snapshot).map((r) => [r.started_at, r.last ?? r.started_at]) : jobRows(snapshot).filter((j) => j.bot === p.bot).map((j) => [j.at, j.at]);
        return {
          places: {},
          first_active: times.length ? Math.min(...times.map(([first]) => first)) : null,
          last_active: times.length ? Math.max(...times.map(([, last]) => last)) : null,
          skills: 0,
          routines: routineRows(snapshot, p.bot).length,
        };
      },
      // Buddy's readiness is the API's to say; until it can, the chat treats an unknown answer as ready.
      "bots.ready": (p) => (member(p), { ok: true, provider: "", model: "", error: "", unknown: true }),
      "models.options": (p) => (member(p), { providers: [], current: { model: "", provider: "", reasoning: "" }, reasoning_levels: [] }),
      "skills.list": (p) => (member(p), { skills: [] }),
      "commands.list": (p) => (member(p), { commands: [] }),
      "bots.avatar": (p) => (member(p), { rev: null, data: null }),
      "bots.restart_scope": (p) => (member(p), { gateway: p.bot, bots: [{ name: p.bot, display_name: memberName(p.bot) }] }),
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
      // Writes: answering an ask, through the decide route, and a helper passing one on; nothing else yet.
      "approval.respond": (p) => (member(p), this.answer(p.request_id, p.choice)),
      "approval.pass_on": (p) => (member(p), this.passOn(p.request_id, p.note)),
      "shops.list": () => this.shopList(),
      "shops.switch": (p) => this.switchTo(p.shop),
      "chat.send": notYet,
      "chat.steer": notYet,
      "chat.interrupt": notYet,
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
      "automations.pause": (p) => this.switchAutomation(p, false),
      "automations.resume": (p) => this.switchAutomation(p, true),
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
      // Mission Control: the jobs and the activity log are the viewed shop's tasks, each member's runs and the actions they
      // asked for (work.ts). The log has no fixed span: the tasks are kept until the shop deletes them. The team's state
      // and Pause everyone are a shop the person owns; the signed-in tenant has no team the API knows, and a helper's
      // shop's team is its owner's.
      "jobs.list": async () => ({ jobs: jobRows(await this.current()) }),
      "jobs.get": async (p) => {
        const job = jobOf(await this.current(), String(p.job));
        if (!job) throw notFound();
        return job;
      },
      "activity.list": async () => ({ events: activityOf(await this.current()), keptMonths: null }),
      "team.state": async () => {
        const snapshot = await this.current();
        const state = teamStateOf(snapshot);
        if (state) return state;
        const viewed = snapshot.viewing ? partOf(snapshot, snapshot.viewing) : undefined;
        if (viewed && viewed.shop.role !== "owner") throw ownerOnly(viewed.shop);
        return notYetShow();
      },
      "team.pause": () => this.pauseTeam(true),
      "team.resume": () => this.pauseTeam(false),
      // What the team knows: the API serves a shop's memory to operators only (admin routes), so no session can read or
      // change it. Nothing the owner types is sent anywhere.
      "memory.list": notYetShow,
      "memory.remember": notYet,
      "memory.confirm": notYet,
      "memory.correct": notYet,
      "memory.forget": notYet,
      // The team's routines, then the shop's other schedules. The owner pauses and resumes a routine through the API's
      // routines routes; making one waits for a later slice, and a schedule no session may change.
      "routine.list": async () => ({ routines: shopRoutines(await this.current()) }),
      "routine.create": notYet,
      "routine.pause": async (p) => ({ routine: await this.switchRoutine(p.routine, false) }),
      "routine.resume": async (p) => ({ routine: await this.switchRoutine(p.routine, true) }),
      // Customize › Connections: the shop's vault and outposts, with the owner's session (connections.ts).
      ...connectionHandlers(this.ownerLink()),
      // Settings › People: who can use Manut AI for the shop, invites, removal and cover, with the owner's session (people.ts).
      ...peopleHandlers(this.ownerLink()),
    };
  })();
}
