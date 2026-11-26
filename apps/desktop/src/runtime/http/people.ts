// Settings › People on the connected runtime (docs/people.md; the routes are docs/pilot-api.md, "The owner's own routes"): who
// can use Manut AI for a shop, an invite, cancelling one, removing a helper and the cover while the owner is away, each read or
// sent with the owner's session of that shop.
//
// Rules this module keeps:
// - The list is of the shop the switcher shows, read with that shop's own session (shops.ts). A change goes to the shop its
//   list was read for (`p.shop`), never to the one the switcher shows now, and with that shop's session, as an answer to an ask
//   goes to the ask's own shop. A person who is in no shops has none to manage: the API answers a person's own sign-in 404
//   (People exist for pilot shops), so nothing is sent for them (`no_shop`).
// - Only the owner sees or changes these. A shop the person helps at is refused here (`owner_only`) with nothing sent, as the
//   API would refuse a helper's session, so a helper's session never carries a name, a LINE ID or an email to the API.
// - What a change names is checked here first, by the rules the API checks again: a name is 1 to 80 characters with no control
//   characters, an identity is exactly a LINE ID or an email address. A refusal that costs nothing is said before anything is
//   sent.
// - What the API answers is read field by field. An entry this build cannot read is left out of a list, and an answer that is
//   not this route's reads as unavailable, so nothing is shown on a guess.
// - The invite's link is a credential until the invite is used or ends. It is returned to the page that asked and kept nowhere
//   else: not in this module, the host, the saved read of the shop or an error's words.
// - While only a kept read of the shop is shown (the API cannot be reached), nothing here is sent: the kept read holds no
//   people, and a change made blind could act on a list that moved on.
import { t } from "../../i18n";
import { helperNameOf, identityOk, MAX_HELPER_NAME, type PeopleOps, type PersonIdentity, type ShopAway, type ShopHelper, type ShopInvite, type ShopPeople } from "../people";
import { OpError } from "../mock/host";
import type { OwnerLink } from "./connections";
import type { ShopAnswer } from "./shops";
import { isObj } from "../../lib/guards";

export const PEOPLE_PATH = "/v1/people";
export const INVITE_PATH = "/v1/people/invites";
export const CANCEL_INVITE_PATH = "/v1/people/invites/revoke";
export const REMOVE_HELPER_PATH = "/v1/people/remove";
export const AWAY_PATH = "/v1/people/away";
export const CLEAR_AWAY_PATH = "/v1/people/away/clear";

type Obj = Record<string, unknown>;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
/** The API keeps an identity's value to this many characters (`MAX_FIELD` in apps/api/src/people-store.ts). */
const MAX_FIELD = 256;

/** An ISO time from the API in seconds, as the protocol counts; undefined for anything that is not one. */
function seconds(v: unknown): number | undefined {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

/** A helper's name as the API says it: any text, or none ("" when the API sent none, as for a person it has no name for). */
const nameOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** The identity an invite or a helper is bound to, or null when it is neither shape. Extra fields are left behind. */
export function decodeIdentity(v: unknown): PersonIdentity | null {
  if (!isObj(v)) return null;
  if (v.kind === "line" && text(v.id, MAX_FIELD)) return { kind: "line", id: v.id };
  if (v.kind === "email" && text(v.address, MAX_FIELD)) return { kind: "email", address: v.address };
  return null;
}

/** One helper of the API's list (`People.helpers` in docs/pilot-api.md), or null when this build cannot read it whole. */
export function decodeHelper(v: unknown): ShopHelper | null {
  if (!isObj(v) || !text(v.id, 256)) return null;
  const identity = decodeIdentity(v.identity);
  const joinedAt = seconds(v.joinedAt);
  if (!identity || joinedAt === undefined || typeof v.devices !== "number" || !Number.isInteger(v.devices) || v.devices < 0) return null;
  return { id: v.id, name: nameOf(v.name), identity, joinedAt, devices: v.devices };
}

/** A link the owner can send: an http or https address, which is all the API makes (`${WEB_ORIGIN}/join/<token>`). Anything
 *  else is not shown or copied as a link. */
export function readLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? v : null;
  } catch {
    return null;
  }
}

/** One invite of the API's list or of an answer (`InviteView`), as the API words its status: any of the four, or null when
 *  this build cannot read it whole. The page lists only the two that mean something to the owner (`ShopInvite`). */
export function decodeInvite(v: unknown): (Omit<ShopInvite, "state"> & { status: "pending" | "used" | "revoked" | "expired" }) | null {
  if (!isObj(v) || !text(v.id, 256)) return null;
  if (v.status !== "pending" && v.status !== "used" && v.status !== "revoked" && v.status !== "expired") return null;
  const identity = decodeIdentity(v.identity);
  const createdAt = seconds(v.createdAt);
  const expiresAt = seconds(v.expiresAt);
  if (!identity || createdAt === undefined || expiresAt === undefined) return null;
  return { id: v.id, name: nameOf(v.name), identity, status: v.status, createdAt, expiresAt, link: v.status === "pending" ? readLink(v.inviteUrl) : null };
}

/** The invite as the page shows it: only one that waits or ran out. */
function shown(invite: NonNullable<ReturnType<typeof decodeInvite>>): ShopInvite | null {
  if (invite.status !== "pending" && invite.status !== "expired") return null;
  const { status, ...rest } = invite;
  return { ...rest, state: status };
}

/** The cover of the API's answer (`AwayView`): null for none, undefined when this build cannot read it. */
function decodeAway(v: unknown): ShopAway | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !text(v.helperId, 256) || typeof v.inForce !== "boolean") return undefined;
  const until = seconds(v.until);
  return until === undefined ? undefined : { helperId: v.helperId, name: nameOf(v.name), until, inForce: v.inForce };
}

/** The people of a `GET /v1/people` answer, or null when it is not one. A helper or invite it cannot read is left out; a cover it
 *  cannot read is read as none, which says nothing about who covers rather than a guess. */
export function peopleOf(json: unknown, shop: string): ShopPeople | null {
  if (!isObj(json) || !isObj(json.owner) || typeof json.owner.name !== "string" || !Array.isArray(json.helpers) || !Array.isArray(json.invites)) return null;
  const account = isObj(json.owner.account) && typeof json.owner.account.devices === "number" && Number.isInteger(json.owner.account.devices) && json.owner.account.devices >= 0 ? json.owner.account.devices : null;
  const helpers = json.helpers.map(decodeHelper).filter((h): h is ShopHelper => h !== null);
  const invites = json.invites
    .map(decodeInvite)
    .map((i) => (i ? shown(i) : null))
    .filter((i): i is ShopInvite => i !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  const away = decodeAway(json.away === undefined ? null : json.away);
  return { shop, owner: { name: json.owner.name, devices: account }, helpers, invites, away: away ?? null };
}

/** What the page says when a change was refused, by code: the people routes' own refusals in plain words, and the words of the
 *  page's own checks. Never a word of what was typed. */
const REFUSED: Record<string, () => string> = {
  owner_only: () => t("people.err.ownerOnly"),
  no_shop: () => t("people.err.noShop"),
  not_found: () => t("people.err.notFound"),
  invalid_name: () => t("people.err.name", { max: MAX_HELPER_NAME }),
  bad_identity: () => t("people.err.identity"),
  invalid_request: () => t("people.err.invite"),
  already_invited: () => t("people.err.alreadyInvited"),
  already_helper: () => t("people.err.alreadyHelper"),
  unknown_invite: () => t("people.err.inviteGone"),
  not_pending: () => t("people.err.notPending"),
  not_a_helper: () => t("people.err.notHelper"),
  bad_date: () => t("people.err.date"),
};

export const refusal = (code: string): OpError => new OpError(code, (REFUSED[code] ?? (() => t("people.err.failed")))());

type Handlers = { [K in keyof PeopleOps]: (p: PeopleOps[K]["params"]) => Promise<PeopleOps[K]["result"]> };

/** The six People ops over `link`. */
export function peopleHandlers(link: OwnerLink): Handlers {
  /** The JSON of an answer that did what it said, or the refusal to throw. `changing`: the request made a change, so an API that
   *  does not answer leaves it unknown whether it was made, which the words say (the page reads the list again to see). */
  const ok = (answer: ShopAnswer, shop: string, changing = false): unknown => {
    if (answer.kind === "ok") return answer.json;
    if (answer.kind === "left") throw link.departed(shop, answer.departure);
    // A 4xx is the API's refusal, said in words. Every 5xx, `not_configured` (an invite link cannot be made) and `people_unavailable`
    // among them, reaches this build as no answer at all, since the session keeps no body for one: it is said as such.
    if (answer.kind === "refused") throw refusal(answer.code);
    if (answer.kind === "signed_out") throw new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") throw new OpError("offline", t("rt.offline"));
    throw new OpError("unavailable", changing ? t("rt.change.noReply") : t("people.err.unavailable"));
  };
  const unreadable = () => new OpError("unavailable", t("people.err.unreadable"));
  /** The shop a change names, checked here with nothing sent: one of the person's shops, which they own. */
  const target = (shop: unknown): string => {
    const role = typeof shop === "string" ? link.roleAt(shop) : undefined;
    if (!role) throw refusal("not_found");
    if (role !== "owner") throw refusal("owner_only");
    return shop as string;
  };
  const id = (v: unknown, code: string): string => {
    if (!text(v, 256)) throw refusal(code);
    return v;
  };

  return {
    "people.list": async () => {
      link.live();
      const viewed = await link.viewed();
      if (!viewed) throw refusal("no_shop");
      if (viewed.role !== "owner") throw refusal("owner_only");
      const people = peopleOf(ok(await link.read(viewed.shop, PEOPLE_PATH), viewed.shop), viewed.shop);
      if (!people) throw unreadable();
      return people;
    },

    "people.invite": async (p) => {
      link.live();
      const shop = target(p.shop);
      const name = helperNameOf(p.name);
      if (!name) throw refusal("invalid_name");
      const identity = identityOk(p.identity);
      if (!identity) throw refusal("bad_identity");
      // Exactly the fields the route reads: a body with anything more is refused by the API, never read.
      const json = ok(await link.write(shop, INVITE_PATH, { name, identity }), shop, true);
      const made = isObj(json) ? decodeInvite(json.invite) : null;
      if (!made || made.status !== "pending") throw unreadable();
      // The link is the answer's own (`inviteUrl`), beside the invite. When it cannot be read the invite is there all the same,
      // so it is returned without one and the page says so.
      const invite = shown(made);
      if (!invite) throw unreadable();
      return { invite: { ...invite, link: readLink((json as Obj).inviteUrl) } };
    },

    "people.cancelInvite": async (p) => {
      link.live();
      const shop = target(p.shop);
      const inviteId = id(p.invite, "unknown_invite");
      const json = ok(await link.write(shop, CANCEL_INVITE_PATH, { inviteId }), shop, true);
      const cancelled = isObj(json) ? decodeInvite(json.invite) : null;
      if (!cancelled || cancelled.id !== inviteId || cancelled.status !== "revoked") throw unreadable();
      return { invite: inviteId };
    },

    "people.remove": async (p) => {
      link.live();
      const shop = target(p.shop);
      const helperId = id(p.helper, "not_a_helper");
      const json = ok(await link.write(shop, REMOVE_HELPER_PATH, { helperId }), shop, true);
      if (!isObj(json) || json.removed !== helperId) throw unreadable();
      const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
      const sessionsEnded = count(json.sessionsEnded);
      const invitesRevoked = Array.isArray(json.invitesRevoked) ? json.invitesRevoked.length : null;
      if (sessionsEnded === null || invitesRevoked === null || typeof json.coverEnded !== "boolean") throw unreadable();
      return { helper: helperId, sessionsEnded, invitesRevoked, coverEnded: json.coverEnded };
    },

    "people.setAway": async (p) => {
      link.live();
      const shop = target(p.shop);
      const helperId = id(p.helper, "not_a_helper");
      // The date goes as the ISO time the API reads. Whether it is in the future is the API's to say (`bad_date`), by its own
      // clock rather than this computer's.
      if (typeof p.until !== "number" || !Number.isFinite(p.until)) throw refusal("bad_date");
      const json = ok(await link.write(shop, AWAY_PATH, { helperId, until: new Date(p.until * 1000).toISOString() }), shop, true);
      const away = isObj(json) ? decodeAway(json.away) : undefined;
      if (!away) throw unreadable();
      return { away };
    },

    "people.clearAway": async (p) => {
      link.live();
      const shop = target(p.shop);
      const json = ok(await link.write(shop, CLEAR_AWAY_PATH, {}), shop, true);
      if (!isObj(json) || json.away !== null) throw unreadable();
      return { away: null };
    },
  };
}
