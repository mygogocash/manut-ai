// Settings › People for the shop's owner, kept apart from the page so it can be tested without one: how the owner, a helper, an
// invite and the cover are said, how the in-place forms and questions move (Invite a helper, Remove, Set cover), and how a change
// reaches the runtime. The design canvas's boards are "Settings: people" (People.dc.html) and "States: people and roles"
// (StatesPeople.dc.html). The rules are the API's: the runtime applies them (src/runtime/people.ts, and `@manut/people-rules`
// behind it), and nothing here decides who may see or change what. The roles table is the one place the page states a rule, and
// it reads that from approval-core's `mayDecide` rather than say it again.
//
// Where this page differs from the canvas, because the canvas would say something untrue of the app as built (docs/decisions.md
// has each call): the invite is not sent, so the owner is given a link to send; "Undo" after a removal is gone, since removing a
// helper ends every session of theirs and nothing brings it back; the roles table has only rows that hold; and the canvas's
// "Everyone signs in with their own LINE or email" says what is true, which is Apple.
//
// An invite's link is held by the page's own state only while the page is open. It is never put in the store or written down.
import { mayDecide, type ApprovalKind } from "@manut/approval-core";
import { sameIdentity } from "@manut/people-rules";
import { hhmm, sameDay } from "../app/time";
import { lang, locale, t, type Key } from "../i18n";
import { isBridgeError, type ShopRow } from "../lib/protocol";
import { MAX_HELPER_NAME, helperNameOf, identityOk, type PersonIdentity, type ShopAway, type ShopHelper, type ShopInvite, type ShopPeople, type ShopRemoval } from "../runtime/people";
import { dayText } from "./memory";

// ---- what the page says -----------------------------------------------------------------------------------------------------

/** Sentences joined as the language writes them: Japanese and Chinese run on after their own full stop. */
const sentences = (parts: string[]): string => parts.join(lang() === "ja" || lang() === "zh" ? "" : " ");

/** "Friday 27 November", with the year when it is not this year: a day with its weekday, as the canvas writes "until Sunday 29
 *  November". English writes the day first, as everywhere in the app (memory.ts `dayText`). */
export function weekdayDay(sec: number, nowMs: number): string {
  const at = new Date(sec * 1000);
  const thisYear = at.getFullYear() === new Date(nowMs).getFullYear();
  const format = new Intl.DateTimeFormat(lang() === "en" ? "en-GB" : locale(), { weekday: "long", day: "numeric", month: "long", ...(thisYear ? {} : { year: "numeric" }) });
  if (lang() !== "en") return format.format(at);
  // Built from the parts, so it never depends on where a locale puts its commas.
  const parts = format.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return [part("weekday"), part("day"), part("month"), part("year")].filter(Boolean).join(" ");
}

/** "today at 14:20", or "22 November at 14:20" on another day: a time from yesterday is never taken for one from this morning. */
function whenText(sec: number, nowMs: number): string {
  const time = hhmm(new Date(sec * 1000));
  return sameDay(sec, nowMs / 1000) ? t("people.inv.today", { time }) : t("people.inv.on", { day: dayText(sec, nowMs), time });
}

/** The person as the owner knows them: the name they gave, or what the invite or helper is, when they gave none. */
export const nameOrHelper = (name: string): string => name.trim() || t("shops.helper");

/** "1 person", "2 people", and "2 people, 1 invited" while an invite waits. The owner counts, helpers count, and an invite that
 *  waits is invited, not yet a person; one that ran out is neither. */
export function countLine(people: Pick<ShopPeople, "helpers" | "invites">): string {
  const n = people.helpers.length + 1;
  const invited = people.invites.filter((i) => i.state === "pending").length;
  const who = n === 1 ? t("people.count1") : t("people.count", { n });
  return invited > 0 ? t("people.countInvited", { people: who, n: invited }) : who;
}

/** How many devices have someone signed in, as a sentence. */
export function devicesLine(n: number): string {
  return n === 0 ? t("people.devices0") : n === 1 ? t("people.devices1") : t("people.devices", { n });
}

/** The account an invite or a helper is bound to, as the owner typed it: an email as it is, a LINE ID named as one. */
export const identityText = (id: PersonIdentity): string => (id.kind === "email" ? id.address : t("people.identity.line", { id: id.id }));

/** What the owner's row says beneath "Fon (you)": on how many devices they are signed in, when the API says. */
export const ownerLine = (people: Pick<ShopPeople, "owner">): string => (people.owner.devices === null ? "" : devicesLine(people.owner.devices));

/** The lines under a helper's name: since when, and the account they signed in with and where. */
export function helperLines(h: ShopHelper, nowMs: number): [string, string] {
  return [t("people.helperSince", { day: dayText(h.joinedAt, nowMs) }), t("people.helperLine", { who: identityText(h.identity), devices: devicesLine(h.devices) })];
}

/** The lines under an invite's name. One that waits says when it was made and until when it works; for a LINE ID it says too that
 *  nobody can open it yet. One that ran out says when. */
export function inviteLines(i: ShopInvite, nowMs: number): string[] {
  if (i.state === "expired") return [t("people.inv.expired", { day: weekdayDay(i.expiresAt, nowMs) })];
  const made = t("people.inv.line", { when: whenText(i.createdAt, nowMs), day: weekdayDay(i.expiresAt, nowMs) });
  return i.identity.kind === "line" ? [made, t("people.inv.noLine")] : [made];
}

/** What the cover says: who covers and until when while it is in force, or that it is over. Null when nobody was ever set. */
export function coverLine(away: ShopAway | null, nowMs: number): string | null {
  if (!away) return null;
  const name = nameOrHelper(away.name);
  const day = weekdayDay(away.until, nowMs);
  return away.inForce ? t("people.away.inForce", { name, day }) : t("people.away.over", { name, day });
}

/** What removing `name` did, in the owner's words: signed out on every device, and what else the API says it did. A way back is
 *  not offered, because there is none: they are invited again. */
export function removedNotice(name: string, did: ShopRemoval): string {
  const parts = [t("people.removed", { name })];
  if (did.invitesRevoked === 1) parts.push(t("people.removedInvites1"));
  else if (did.invitesRevoked > 1) parts.push(t("people.removedInvites", { n: did.invitesRevoked }));
  if (did.coverEnded) parts.push(t("people.removedCover"));
  parts.push(t("people.removedAgain", { name }));
  return sentences(parts);
}

// ---- what each role can do ----------------------------------------------------------------------------------------------------

export type Can = "yes" | "no" | "asks";

export interface RoleRow {
  id: string;
  label: Key;
  owner: Can;
  helper: Can;
}

/** What a role may decide of these kinds of request, read from approval-core's own rule: "yes" for all of them, "asks" for a role
 *  that must ask the owner (a helper's refusal is a decision about money or the shop's public face too), "no" for the owner when
 *  it could not, which approval-core never says. */
function decides(role: "owner" | "helper", kinds: readonly ApprovalKind[]): Can {
  return kinds.every((k) => mayDecide(role, k)) ? "yes" : role === "helper" ? "asks" : "no";
}

/** The table "What each role can do": the canvas's rows that are true of the app as built. The first four are approval-core's
 *  `mayDecide`, so they cannot drift from the rule. The last three are what the API gives each role (docs/people.md): a helper's
 *  session reads the requests that wait, and every other route the owner reaches (what the team knows, its tasks, the team, its
 *  routines, the connections, the consent, the export and the people) answers it 403 `owner_only`. The canvas's "Use Code" and
 *  "See sales, the AI budget and the plan" are left out: Code is on the person's own computer whatever their role, and the app
 *  shows no sales or plan to anyone yet. */
export function roleRows(): RoleRow[] {
  const approve = (id: string, label: Key, kinds: readonly ApprovalKind[]): RoleRow => ({ id, label, owner: decides("owner", kinds), helper: decides("helper", kinds) });
  return [
    approve("messages", "people.role.messages", ["message", "reply"]),
    approve("money", "people.role.money", ["money"]),
    approve("posts", "people.role.posts", ["public_post"]),
    approve("payments", "people.role.payments", ["payment_confirmation"]),
    { id: "see", label: "people.role.see", owner: "yes", helper: "yes" },
    { id: "knows", label: "people.role.knows", owner: "yes", helper: "no" },
    { id: "change", label: "people.role.change", owner: "yes", helper: "no" },
  ];
}

/** The words in a cell of the table. */
export const canText = (can: Can): string => (can === "yes" ? t("people.yes") : can === "asks" ? t("people.asks") : t("people.no"));

// ---- what is typed ---------------------------------------------------------------------------------------------------------------

/** What the owner typed as the account to invite. A LINE ID never holds an `@` and an email always does, so one box serves both,
 *  as the canvas has it. Outer spaces are never part of either. */
export function identityOf(typed: string): PersonIdentity {
  const text = typed.trim();
  return text.includes("@") ? { kind: "email", address: text } : { kind: "line", id: text };
}

/** Which kind of account the box holds so far, to say what that kind needs. Null while nothing is typed. */
export function contactKind(typed: string): "line" | "email" | null {
  const text = typed.trim();
  return text === "" ? null : text.includes("@") ? "email" : "line";
}

/** Whether the form can be sent: a name the shop's record keeps and an account the rules accept. */
export const inviteReady = (name: string, contact: string): boolean => helperNameOf(name) !== null && identityOk(identityOf(contact)) !== null;

/** Whether the name is too long to keep, for the line that says so. An empty name just waits. */
export const nameTooLong = (name: string): boolean => [...name.normalize("NFC").trim()].length > MAX_HELPER_NAME;

const DAY_FIELD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The last second of a day on this computer's calendar ("2026-11-27", as a date field writes it), in seconds: the moment an owner
 *  who says "until Friday" is still away at. Null for anything that is not a day that exists. */
export function endOfDay(day: string): number | null {
  const m = DAY_FIELD.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(y, mo - 1, d, 23, 59, 59);
  // A day that does not exist ("2026-02-30") rolls into the next month: only a time that reads back as the same day is that day.
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d ? Math.floor(at.getTime() / 1000) : null;
}

/** Today on this computer's calendar, as a date field writes it: the earliest day the cover may end. */
export function todayField(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whether cover can be set: a helper, and a day that exists and has not passed. The API says it again by its own clock. */
export const coverReady = (helper: string, day: string, nowMs: number): boolean => {
  const until = endOfDay(day);
  return helper !== "" && until !== null && until * 1000 > nowMs;
};

// ---- what is open on the page ---------------------------------------------------------------------------------------------------

/** The one form or question open in the list: the Invite a helper form with its fields, or the question about removing a helper.
 *  Nothing is changed until the owner answers it. */
export type PeopleAsk = { kind: "invite"; name: string; contact: string } | { kind: "remove"; helper: string } | null;

export interface PeopleUi {
  ask: PeopleAsk;
  /** the cover's two fields, which stay as typed until it is set */
  cover: { helper: string; day: string };
  /** a change is on its way: nothing else can be asked or typed */
  busy: boolean;
  /** which part of the page the last change's words show in */
  at: "who" | "cover" | null;
  /** why the last change did not happen, in the page's words; never a word of what was typed */
  error: string | null;
  /** what the last change did */
  notice: string | null;
  /** the invite just made, whose link is open to copy and send until the owner is done with it */
  made: string | null;
  /** the invite whose link was just copied, for the moment its button says so */
  copied: string | null;
}

export const PEOPLE_START: PeopleUi = { ask: null, cover: { helper: "", day: "" }, busy: false, at: null, error: null, notice: null, made: null, copied: null };

export type PeopleAction =
  | { type: "openInvite" }
  | { type: "name"; text: string }
  | { type: "contact"; text: string }
  | { type: "askRemove"; helper: string }
  | { type: "cancel" }
  | { type: "coverHelper"; helper: string }
  | { type: "coverDay"; day: string }
  | { type: "begin"; at: "who" | "cover" }
  | { type: "done"; notice: string; made?: string | null; resetCover?: boolean }
  | { type: "failed"; message: string; close: boolean }
  | { type: "dismiss" }
  | { type: "copied"; invite: string }
  | { type: "uncopy" }
  | { type: "reset" };

/** Moves the page between asking, waiting on the runtime and done. One question at a time, and none while a change is on its way,
 *  so the owner cannot ask twice. A change's words show where it was asked: the list or the cover. */
export function peopleReduce(s: PeopleUi, a: PeopleAction): PeopleUi {
  switch (a.type) {
    case "openInvite":
      return s.busy ? s : { ...s, ask: { kind: "invite", name: "", contact: "" }, at: "who", error: null, notice: null };
    case "name":
      return !s.busy && s.ask?.kind === "invite" ? { ...s, ask: { ...s.ask, name: a.text } } : s;
    case "contact":
      return !s.busy && s.ask?.kind === "invite" ? { ...s, ask: { ...s.ask, contact: a.text } } : s;
    case "askRemove":
      return s.busy ? s : { ...s, ask: { kind: "remove", helper: a.helper }, at: "who", error: null, notice: null };
    case "cancel":
      return s.busy ? s : { ...s, ask: null, error: null };
    case "coverHelper":
      return s.busy ? s : { ...s, cover: { ...s.cover, helper: a.helper } };
    case "coverDay":
      return s.busy ? s : { ...s, cover: { ...s.cover, day: a.day } };
    case "begin":
      return { ...s, busy: true, at: a.at, error: null, notice: null };
    case "done":
      return { ...s, ask: null, busy: false, error: null, notice: a.notice, made: a.made === undefined ? s.made : a.made, cover: a.resetCover ? { helper: "", day: "" } : s.cover };
    // A refusal keeps the form or question open, so the owner can read why and try again (a name fixed), unless what it was about
    // is gone.
    case "failed":
      return { ...s, busy: false, error: a.message, notice: null, ask: a.close ? null : s.ask };
    case "dismiss":
      return { ...s, made: null };
    case "copied":
      return { ...s, copied: a.invite };
    case "uncopy":
      return { ...s, copied: null };
    case "reset":
      return PEOPLE_START;
  }
}

// ---- what a refusal says ----------------------------------------------------------------------------------------------------------

/** What the page says to the runtime's refusals, by code, in the owner's language. Any other refusal is said in the runtime's own
 *  words. */
const REFUSALS = new Map<string, () => string>([
  ["owner_only", () => t("people.err.ownerOnly")],
  ["no_shop", () => t("people.err.noShop")],
  ["not_found", () => t("people.err.notFound")],
  ["invalid_name", () => t("people.err.name", { max: MAX_HELPER_NAME })],
  ["bad_identity", () => t("people.err.identity")],
  ["invalid_request", () => t("people.err.invite")],
  ["already_invited", () => t("people.err.alreadyInvited")],
  ["already_helper", () => t("people.err.alreadyHelper")],
  ["unknown_invite", () => t("people.err.inviteGone")],
  ["not_pending", () => t("people.err.notPending")],
  ["not_a_helper", () => t("people.err.notHelper")],
  ["bad_date", () => t("people.err.date")],
]);

export function refusalText(code: string, message: string): string {
  return REFUSALS.get(code)?.() ?? message;
}

/** The refusals that mean the list the owner is looking at is out of date: the page reads it again, so what they see is how things
 *  stand. A change whose outcome is unknown (the API did not answer, or answered in a way this build cannot read) is one too. */
const MOVED_ON = new Set(["unknown_invite", "not_pending", "not_a_helper", "already_invited", "already_helper", "unavailable"]);

/** What a shop the person helps at says in place of the list: only its owner sees and changes it. */
export const helperShopWords = (shop: Pick<ShopRow, "name" | "owner">): string =>
  t("people.err.helperShop", { owner: shop.owner || t("shops.helper"), shop: shop.name || t("people.thisShop") });

// ---- changes ------------------------------------------------------------------------------------------------------------------------

/** The five changes, which the page sends through its own client of the runtime. */
export interface PeopleCalls {
  invite(shop: string, name: string, identity: PersonIdentity): Promise<{ invite: ShopInvite }>;
  cancelInvite(shop: string, invite: string): Promise<{ invite: string }>;
  remove(shop: string, helper: string): Promise<ShopRemoval>;
  setAway(shop: string, helper: string, until: number): Promise<{ away: ShopAway }>;
  clearAway(shop: string): Promise<{ away: null }>;
}

export type PeopleDo =
  | { what: "invite"; name: string; contact: string }
  | { what: "cancel"; invite: string }
  | { what: "remove"; helper: string }
  | { what: "away"; helper: string; until: number }
  | { what: "back" };

export interface PeopleStep {
  data: ShopPeople;
  action: PeopleAction;
  /** the list the owner sees is out of date: read it again */
  reread: boolean;
}

/** Asks the runtime to make the change, on the shop the list was read for, and says what the list is now and how the page moves on.
 *  A row the runtime says is gone is dropped, since the owner is looking at a list that went out of date. */
export async function peopleDo(calls: PeopleCalls, data: ShopPeople, todo: PeopleDo, nowMs: number = Date.now()): Promise<PeopleStep> {
  try {
    switch (todo.what) {
      case "invite": {
        const { invite } = await calls.invite(data.shop, todo.name, identityOf(todo.contact));
        return { data: { ...data, invites: [invite, ...data.invites.filter((i) => i.id !== invite.id)] }, action: { type: "done", notice: t("people.inv.made", { name: nameOrHelper(invite.name) }), made: invite.id }, reread: false };
      }
      case "cancel": {
        const name = nameOrHelper(data.invites.find((i) => i.id === todo.invite)?.name ?? "");
        const { invite } = await calls.cancelInvite(data.shop, todo.invite);
        return { data: { ...data, invites: data.invites.filter((i) => i.id !== invite) }, action: { type: "done", notice: t("people.inv.cancelled", { name }), made: null }, reread: false };
      }
      case "remove": {
        const helper = data.helpers.find((h) => h.id === todo.helper);
        const name = nameOrHelper(helper?.name ?? "");
        const did = await calls.remove(data.shop, todo.helper);
        // What the API says it did, applied to the list: their invites that waited go (as many as it counted), and so does their cover.
        const next: ShopPeople = {
          ...data,
          helpers: data.helpers.filter((h) => h.id !== todo.helper),
          invites: did.invitesRevoked > 0 && helper ? data.invites.filter((i) => !(i.state === "pending" && sameIdentity(i.identity, helper.identity))) : data.invites,
          away: did.coverEnded ? null : data.away,
        };
        return { data: next, action: { type: "done", notice: removedNotice(name, did) }, reread: false };
      }
      case "away": {
        const { away } = await calls.setAway(data.shop, todo.helper, todo.until);
        return { data: { ...data, away }, action: { type: "done", notice: t("people.away.setDone", { name: nameOrHelper(away.name), day: weekdayDay(away.until, nowMs) }), resetCover: true }, reread: false };
      }
      case "back": {
        await calls.clearAway(data.shop);
        return { data: { ...data, away: null }, action: { type: "done", notice: t("people.away.endDone") }, reread: false };
      }
    }
  } catch (e) {
    // The runtime's refusals are said in plain words by code (or in its own words for a code this page does not know); anything
    // else that went wrong is the page's own "That did not work", never an internal message.
    const code = isBridgeError(e) ? e.code : "internal";
    const message = isBridgeError(e) ? refusalText(code, e.message) : t("people.err.failed");
    // What the question was about is gone: close it, so the owner is looking at the list as it now is. A change whose outcome the
    // page cannot tell is never said to be done: the list is read again to see (`MOVED_ON`).
    const gone = code === "not_a_helper" || code === "unknown_invite" || code === "not_pending";
    return { data, action: { type: "failed", message, close: gone }, reread: MOVED_ON.has(code) };
  }
}
