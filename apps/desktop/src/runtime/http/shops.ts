// The person's shops (docs/several-shops.md; docs/pilot-api.md, "Several shops"): which shops they are in, and as what
// (`GET /v1/shops`, with the sign-in), and one shop session for each (`POST /v1/shops/session` with exactly `{ shop }`),
// which is the only credential the app sends to act for that shop.
//
// Rules this module keeps:
// - A shop's requests always carry that shop's own session: never the sign-in, and never another shop's session. Which
//   shop a request is for is always the caller's to say, from what it acts on (an ask names its shop), never from the
//   shop the switcher shows.
// - A shop session lasts 30 days and has no refresh. One that has ended, or that the API answers 401 for any reason but
//   `unlinked` or `removed`, is opened again once with the sign-in, and the request is sent once more. That is as safe for
//   a decision as for a read: the API answers 401 from the credential before it reads the body, so the first one decided
//   nothing.
// - 401 `unlinked` (the operator unlinked this owner account) and 401 `removed` (the owner removed this helper) end the
//   person's place in that shop: nothing opens it again, its session is dropped at once, and the answer says when, so the
//   app can say so in words (`left`). A shop the sign-in can no longer open (404) has left too, with no date to say.
// - The tokens go to the keychain item (session.ts) and to a request's bearer, and nowhere else: never a log, an address
//   or the screen.
import type { ShopRole, ShopRow } from "../../lib/protocol";
import { decodeApprovals } from "./approvals";
import { decodeWork, readTaskList, type ReadFailure, type ShopPart, type ShopWork, type TaskListRead } from "./shop";
import type { Answer, ApiSession, ShopSessionRecord } from "./session";
import type { FetchLike } from "./shell";
import { isObj } from "../../lib/guards";

export type { ShopRole, ShopRow } from "../../lib/protocol";

/** How a person's place in a shop ended: removed as its helper, or unlinked as its owner's account, each with when the API
 *  says it happened (ms; null when it did not say), or gone from their list with nothing said (deleted, or left another
 *  way). */
export interface Departure {
  why: "removed" | "unlinked" | "gone";
  at: number | null;
}

/** What a request made with a shop session came back with: the API's answer, or that the person's place in the shop has
 *  ended, so nothing more is asked of it. */
export type ShopAnswer = Answer | { kind: "left"; departure: Departure };

export type ShopsList = { ok: true; shops: ShopRow[] } | { ok: false; failure: ReadFailure };

/** A shop the person's place in ended, found while reading. */
export interface Left {
  shop: string;
  departure: Departure;
}

/** One read of every listed shop's asks: each shop with what waits there, or the worst reason one could not be read. Either
 *  way, `left` says whose place ended in it. */
export type ShopsRead = { ok: true; parts: ShopPart[]; unreadable: unknown[]; left: Left[] } | { ok: false; failure: ReadFailure; left: Left[] };

/** What `GET /v1/approvals?state=open` reads for one shop: its asks. */
export const OPEN_ASKS = "/v1/approvals?state=open";
/** What an owner's session also reads of a shop (docs/several-shops.md, slice 4), each minute: its tasks from the task
 *  list (shop.ts `readTaskList`), with each member's runs and newest draft; its schedules and its attention items; and its
 *  team with its routines. It never reads the shop's export, which holds every task's whole history. */
export const TEAM_ROUTINES = "/v1/routines";
export const SHOP_SCHEDULES = "/v1/schedules";
export const SHOP_ATTENTION = "/v1/inbound/attention";

/** One shop's answers in a read: its asks, and for a shop the person owns its tasks, routines, schedules and attention
 *  items. */
interface ShopAnswers {
  asks: ShopAnswer;
  work: { tasks: TaskListRead<ShopAnswer>; routines: ShopAnswer; schedules: ShopAnswer; attention: ShopAnswer } | null;
}

/** What an owner's work read came to: the work, none (the session may not read it: a helper's session answers 403
 *  `owner_only` on every part), or the reason the read failed. A deleted shop's list (404 `tenant_deleted`) has no tasks,
 *  as its export had none. */
function workOf(a: ShopAnswers, unreadable: unknown[]): ShopWork | null | ReadFailure {
  if (!a.work) return null;
  const { tasks, routines, schedules, attention } = a.work;
  const answers = [tasks, routines, schedules, attention];
  for (const worst of ["signed_out", "offline", "unavailable"] as const) if (answers.some((x) => x.kind === worst)) return worst;
  if (answers.some((x) => x.kind === "refused" && x.status === 403)) return null;
  const deleted = tasks.kind === "refused" && tasks.status === 404 && tasks.code === "tenant_deleted";
  if (routines.kind !== "ok" || schedules.kind !== "ok" || attention.kind !== "ok" || (tasks.kind !== "ok" && !deleted)) return "unavailable";
  return decodeWork(
    { tasks: tasks.kind === "ok" ? tasks.tasks : [], ...(tasks.kind === "ok" && tasks.next !== null ? { more: tasks.next } : {}), schedules: schedules.json, attention: attention.json, routines: routines.json },
    unreadable,
  );
}

/** A shop session is opened again this long before it ends, so an ending one is never sent. */
export const SHOP_EARLY_MS = 60_000;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** The shops of a `GET /v1/shops` answer, each one whole, once, the ones the person owns first in the API's order. An
 *  entry this build cannot read (a role it does not know above all) is left out: nothing here could act for it. */
export function decodeShops(json: unknown): ShopRow[] {
  const entries = isObj(json) && Array.isArray(json.shops) ? json.shops : [];
  const seen = new Set<string>();
  const rows: ShopRow[] = [];
  for (const v of entries) {
    if (!isObj(v) || !text(v.id, 256) || seen.has(v.id)) continue;
    if ((v.role !== "owner" && v.role !== "helper") || typeof v.name !== "string" || typeof v.ownerName !== "string") continue;
    seen.add(v.id);
    rows.push({ id: v.id, name: v.name, owner: v.ownerName, role: v.role });
  }
  return [...rows.filter((r) => r.role === "owner"), ...rows.filter((r) => r.role === "helper")];
}

/** The shops the person is in. An API from before shops answers the route 404, which reads as none: the app then reads the
 *  signed-in tenant as it always did. */
export async function listShops(session: ApiSession): Promise<ShopsList> {
  const answer = await session.read("/v1/shops");
  if (answer.kind === "ok") return { ok: true, shops: decodeShops(answer.json) };
  if (answer.kind === "refused") return answer.status === 404 ? { ok: true, shops: [] } : { ok: false, failure: "unavailable" };
  return { ok: false, failure: answer.kind };
}

/** A 401 that ends the person's place in the shop, with when; null for any other answer. */
export function departureOf(answer: Answer): Departure | null {
  if (answer.kind !== "refused" || answer.status !== 401) return null;
  const body = isObj(answer.json) ? answer.json : {};
  if (answer.code === "removed") return { why: "removed", at: ms(body.removedAt) };
  if (answer.code === "unlinked") return { why: "unlinked", at: ms(body.unlinkedAt) };
  return null;
}

/** The session of a `POST /v1/shops/session` answer, or null when it is not one. */
function decodeOpened(json: unknown): ShopSessionRecord | null {
  if (!isObj(json) || (json.role !== "owner" && json.role !== "helper") || !isObj(json.session)) return null;
  const { accessToken, expiresAt } = json.session;
  const until = ms(expiresAt);
  if (!text(accessToken, 8192) || until === null) return null;
  return { role: json.role, accessToken, expiresAt: until };
}

type Opened = { kind: "open"; held: ShopSessionRecord } | Exclude<ShopAnswer, { kind: "ok" } | { kind: "refused" }>;

/** What making a shop of the person's own came to: the shop, theirs now, with its owner session held; the API's refusal,
 *  with its code; or that the sign-in ended, the API could not be reached, or it could not make the shop. */
export type Made =
  | { kind: "made"; shop: ShopRow; teamWaits: boolean }
  | { kind: "refused"; status: number; code: string }
  | { kind: "signed_out" | "offline" | "unavailable" };

/** The shop and the owner session of a `POST /v1/shops/new` answer, or null when it is not one, and whether the answer
 *  says the shop's team waits for Manut AI to count the shop in (`teamWaits: "not_counted_in"`). */
function decodeMade(json: unknown): { shop: ShopRow; held: ShopSessionRecord; teamWaits: boolean } | null {
  if (!isObj(json) || json.role !== "owner" || !isObj(json.shop)) return null;
  const { id, name, ownerName } = json.shop;
  const held = decodeOpened(json);
  if (!text(id, 256) || typeof name !== "string" || typeof ownerName !== "string" || !held) return null;
  return { shop: { id, name, owner: ownerName, role: "owner" }, held, teamWaits: json.teamWaits === "not_counted_in" };
}

export class ShopSessions {
  /** A shop being opened, so two requests that find its session ended open it once. */
  private opening = new Map<string, Promise<Opened>>();

  constructor(
    private readonly session: ApiSession,
    private readonly now: () => number = Date.now,
  ) {}

  /** The role the person acts as at `shop`: the held session's, which is what the API decides with, else the list's. */
  roleAt(shop: ShopRow): ShopRole {
    return this.session.shopSession(shop.id)?.role ?? shop.role;
  }

  /** Reads what waits at each listed shop, each with its own session, at once (docs/several-shops.md, "One Needs you across
   *  the shops"), and of each shop the person owns its tasks, routines, schedules and attention items as well, so its pages
   *  show its tasks, its team and its routines (`ShopPart.work`). A shop they help at is read for its asks only: what a
   *  helper sees is the owner's call. A shop whose place ended in this read is left out and said in `left`, and so is each
   *  shop this computer holds a session for that the list no longer has. Any other failure fails the whole read with the worst reason (signed
   *  out, then offline, then unavailable), so one shop's asks never vanish because its read did not answer, and half a
   *  shop is never shown as the whole one. */
  async readAll(listed: readonly ShopRow[]): Promise<ShopsRead> {
    const [answers, gone] = await Promise.all([Promise.all(listed.map((shop) => this.readShop(shop))), this.leaving(listed.map((s) => s.id))]);
    const left = [...gone];
    const parts: ShopPart[] = [];
    const failures: ReadFailure[] = [];
    const unreadable: unknown[] = [];
    answers.forEach((answer, i) => {
      const shop = listed[i];
      const answered = answer.work ? [answer.asks, answer.work.tasks, answer.work.routines, answer.work.schedules, answer.work.attention] : [answer.asks];
      const ended = answered.find((a): a is Extract<ShopAnswer, { kind: "left" }> => a.kind === "left");
      if (ended) return void left.push({ shop: shop.id, departure: ended.departure });
      // Nothing that waits is ever read as "nothing waits": the API answers 503 rather than leave a request out.
      if (answer.asks.kind !== "ok") return void failures.push(answer.asks.kind === "refused" || answer.asks.kind === "left" ? "unavailable" : answer.asks.kind);
      const work = workOf(answer, unreadable);
      if (typeof work === "string") return void failures.push(work);
      const role = this.roleAt(shop);
      parts.push({ shop: { ...shop, role }, approvals: decodeApprovals(answer.asks.json, unreadable), ...(work && role === "owner" ? { work } : {}) });
    });
    for (const worst of ["signed_out", "offline", "unavailable"] as const) if (failures.includes(worst)) return { ok: false, failure: worst, left };
    return { ok: true, parts, unreadable, left };
  }

  /** One shop's requests, made together with its own session: what waits there, and while the person acts there as its
   *  owner (the session held, else the list, says so) its tasks, routines, schedules and attention items. */
  private async readShop(shop: ShopRow): Promise<ShopAnswers> {
    if (this.roleAt(shop) !== "owner") return { asks: await this.read(shop.id, OPEN_ASKS), work: null };
    const [asks, tasks, routines, schedules, attention] = await Promise.all([
      this.read(shop.id, OPEN_ASKS),
      readTaskList((path) => this.read(shop.id, path)),
      this.read(shop.id, TEAM_ROUTINES),
      this.read(shop.id, SHOP_SCHEDULES),
      this.read(shop.id, SHOP_ATTENTION),
    ]);
    return { asks, work: { tasks, routines, schedules, attention } };
  }

  /** The shops this computer holds a session for that `listed` no longer has: each one's session is looked at once, with
   *  itself, so the app can say why and when (a removal or an unlinking answers so), and then dropped. One that still
   *  works although the list left it out is ended on the API too, since nothing here will send it again. */
  private async leaving(listed: readonly string[]): Promise<Left[]> {
    const gone = this.session.heldShops().filter((shop) => !listed.includes(shop));
    if (!gone.length) return [];
    const left = await Promise.all(
      gone.map(async (shop): Promise<Left> => {
        const held = this.session.shopSession(shop);
        const answer = held ? await this.session.sendAs(held.accessToken, "GET", OPEN_ASKS) : null;
        if (held && answer?.kind === "ok") void this.session.sendAs(held.accessToken, "POST", "/v1/shops/session/end", {});
        return { shop, departure: (answer && departureOf(answer)) ?? { why: "gone", at: null } };
      }),
    );
    await this.session.dropShopSessions(gone);
    return left;
  }

  /** A GET with the shop's own session. */
  read(shop: string, path: string): Promise<ShopAnswer> {
    return this.request(shop, "GET", path);
  }

  /** A POST of `body`, as JSON, with the shop's own session: a decision, or passing a request on. */
  write(shop: string, path: string, body: unknown): Promise<ShopAnswer> {
    return this.request(shop, "POST", path, body);
  }

  /** `write`, with the same rules, sent through `through` instead of the session's own `fetch`, as `ApiSession.writeVia` is
   *  for the sign-in: registering this Mac for a shop goes through the shell's own command, which keeps the credential its
   *  answer holds (outpost.ts). Opening the shop still goes the usual way, since its answer is a session the page keeps. */
  writeVia(shop: string, path: string, body: unknown, through: FetchLike): Promise<ShopAnswer> {
    return this.request(shop, "POST", path, body, through);
  }

  /** Makes a shop of the person's own with the sign-in (`POST /v1/shops/new`, exactly `{ name, ownerName, template }`;
   *  docs/pilot-api.md, "Making a shop of your own"), and keeps the owner session the API answers with the sign-in, as
   *  opening a shop keeps one, so the shop is read with its own session from the first read. A request that got no answer is
   *  never sent again from here: the API may have made the shop, and the next read of the person's shops says so. */
  async make(input: { name: string; ownerName: string; template: string | null }): Promise<Made> {
    // Taken before the request goes out, as for opening a shop: a sign-out while it is on its way means the session it
    // brings back is ended there and not kept here. The shop is the person's all the same, and opens again with the sign-in.
    const chain = this.session.signInChain;
    const answer = await this.session.write("/v1/shops/new", { name: input.name, ownerName: input.ownerName, template: input.template });
    if (answer.kind === "ok") {
      const made = decodeMade(answer.json);
      if (!made) return { kind: "unavailable" };
      await this.session.keepShopSession(made.shop.id, made.held, chain);
      return { kind: "made", shop: made.shop, teamWaits: made.teamWaits };
    }
    if (answer.kind === "refused") return { kind: "refused", status: answer.status, code: answer.code };
    return { kind: answer.kind };
  }

  /** Forgets these shops' sessions here: they left the person's list. Nothing is sent: a shop the person was removed from
   *  or unlinked from, or that was deleted, holds no session to end. */
  drop(shops: readonly string[]): Promise<void> {
    return this.session.dropShopSessions(shops);
  }

  private async request(shop: string, method: "GET" | "POST", path: string, body?: unknown, through?: FetchLike): Promise<ShopAnswer> {
    await this.session.load();
    let held = this.session.shopSession(shop);
    let reopened = false;
    if (!held || held.expiresAt - this.now() <= SHOP_EARLY_MS) {
      const opened = await this.open(shop, held?.accessToken ?? null);
      if (opened.kind !== "open") return opened;
      held = opened.held;
      reopened = true;
    }
    let answer = await this.session.sendAs(held.accessToken, method, path, body, through);
    let ended = departureOf(answer);
    if (!ended && !reopened && answer.kind === "refused" && answer.status === 401) {
      // The session ended (its 30 days, or this device signed out of the shop elsewhere): open the shop again once.
      const opened = await this.open(shop, held.accessToken);
      if (opened.kind !== "open") return opened;
      answer = await this.session.sendAs(opened.held.accessToken, method, path, body, through);
      ended = departureOf(answer);
    }
    if (ended) {
      await this.session.dropShopSessions([shop]);
      return { kind: "left", departure: ended };
    }
    return answer;
  }

  /** Opens `shop` with the sign-in, unless another request already replaced the session `stale` names. */
  private open(shop: string, stale: string | null): Promise<Opened> {
    const current = this.session.shopSession(shop);
    if (current && current.accessToken !== stale && current.expiresAt - this.now() > SHOP_EARLY_MS) return Promise.resolve({ kind: "open", held: current });
    let opening = this.opening.get(shop);
    if (!opening) {
      opening = this.openNow(shop).finally(() => this.opening.delete(shop));
      this.opening.set(shop, opening);
    }
    return opening;
  }

  private async openNow(shop: string): Promise<Opened> {
    // Taken before the request goes out: a sign-out, or someone else's sign-in, while it is on its way means the session it
    // brings back is not kept here (session.ts `keepShopSession`).
    const chain = this.session.signInChain;
    const answer = await this.session.write("/v1/shops/session", { shop });
    if (answer.kind === "ok") {
      const opened = decodeOpened(answer.json);
      if (!opened) return { kind: "unavailable" };
      return (await this.session.keepShopSession(shop, opened, chain)) ? { kind: "open", held: opened } : { kind: "signed_out" };
    }
    if (answer.kind === "refused") {
      if (answer.status !== 404) return { kind: "unavailable" };
      // The person is in the shop neither way any more, or it is gone: the API answers both alike.
      await this.session.dropShopSessions([shop]);
      return { kind: "left", departure: { why: "gone", at: null } };
    }
    return answer;
  }
}
