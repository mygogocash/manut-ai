// Customize › Connections for the shop's owner, kept apart from the page so it can be tested without one: how a vault
// sign-in and an outpost are said, how the in-place questions move (Add a sign-in, Change, Who uses it, Rename, Remove), and
// how a change reaches the runtime. The design canvas's boards are "Customize: connections" (Connections.dc.html) and
// "States: customize" (StatesCustomize.dc.html). The rules are the API's: the runtime applies them
// (src/runtime/connections.ts), and nothing here decides who may see or change what. What the page checks as the owner types
// (an address that is not https, a name too long) is the vault's own rule, said early so the owner can fix it before Add.
//
// The typed password is the one thing here that must not stay. It lives in the open Change question's draft, or Add a
// sign-in's, only while the owner types; it leaves the page's state the moment Save or Add is pressed (`begin`), goes once
// to the runtime through the tab's own client (ConnectionsPane.tsx, never the store), and is not put back when the send
// fails: the owner types it again. No word the page shows holds it, a refusal's included.
import { hhmm, sameDay } from "../app/time";
import { listText, t } from "../i18n";
import {
  MAX_ORIGIN_LENGTH,
  MAX_ORIGINS,
  MAX_OUTPOST_NAME,
  MAX_PASSWORD,
  MAX_SIGN_INS,
  MAX_SITE,
  MAX_USERNAME,
  newSignInRefusal,
  SIGN_IN_MEMBERS,
  siteOf,
  usernameOk,
  type NewSignIn,
  type ShopConnections,
  type ShopOutpost,
  type VaultSignIn,
} from "../runtime/connections";
import { unavailable, type Load } from "./load";
import { dayText } from "./memory";

/** A member as the team is named everywhere: "nam" is Nam. The names are the same in every language. */
export const memberName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/** "today 09:02", or "3 November 09:02" on another day: a time from yesterday is never taken for one from this morning. */
function whenText(sec: number, nowMs: number): string {
  const time = hhmm(new Date(sec * 1000));
  return sameDay(sec, nowMs / 1000) ? t("vault.today", { time }) : `${dayText(sec, nowMs)} ${time}`;
}

/** The quiet line under a sign-in's site, as the canvas says it: who may use it and when it was last used ("Used by Nam and
 *  Ton, last today 09:02"), or, once the site refused the saved password, when that was. */
export function signInLine(s: VaultSignIn, nowMs: number): string {
  if (s.state === "broken" && s.brokenAt !== null) {
    const time = hhmm(new Date(s.brokenAt * 1000));
    return sameDay(s.brokenAt, nowMs / 1000) ? t("vault.brokenToday", { time }) : t("vault.brokenOn", { day: dayText(s.brokenAt, nowMs), time });
  }
  const who = listText(s.members.map(memberName));
  return s.lastUsedAt === null ? t("vault.used", { who }) : t("vault.usedLast", { who, when: whenText(s.lastUsedAt, nowMs) });
}

/** When it was added to the vault. */
export const addedLine = (s: VaultSignIn, nowMs: number): string => t("vault.added", { day: dayText(s.createdAt, nowMs) });

/** The quiet line under an outpost's name: the canvas's words for a cloud outpost, and for a Mac what it is and when it came. */
export const outpostLine = (o: ShopOutpost, nowMs: number): string => (o.kind === "cloud" ? t("outposts.cloud") : t("outposts.mac", { day: dayText(o.createdAt, nowMs) }));

/** This Mac's own record among the shop's outposts as the tab read them: the one with the id the shell gives this Mac's
 *  outpost (src/runtime/http/outpost.ts), and only a Mac's. Null until the vault was read, while the shell has not said, or
 *  when the shop's list does not have it (removed meanwhile): then nothing is folded and the list shows every one. */
export function thisMacRecord(state: Load<ShopConnections>, id: string | null): ShopOutpost | null {
  if (state.kind !== "ready" || !id) return null;
  return state.value.outposts.find((o) => o.id === id && o.kind === "this_mac") ?? null;
}

/** A new sign-in as the owner types it into Add a sign-in. The password lives here only while they type: it leaves the
 *  page's state the moment Add is pressed (`begin`). */
export interface AddDraft {
  site: string;
  /** each address field as typed, one to five of them */
  addresses: string[];
  username: string;
  password: string;
  /** the members ticked, in the team's order */
  members: string[];
}

/** Add a sign-in as it opens: every field empty, one address field, and nobody ticked, so the owner says who. */
export const addStart = (): AddDraft => ({ site: "", addresses: [""], username: "", password: "", members: [] });

/** The one question open in the tab: a new sign-in, a new password for a sign-in, who may use one, a new name for an
 *  outpost, or whether to remove one. Nothing is changed until the owner answers it. */
export type ConnAsk =
  | { kind: "add"; draft: AddDraft }
  | { kind: "password"; signIn: string; draft: string }
  | { kind: "members"; signIn: string; members: string[] }
  | { kind: "rename"; outpost: string; draft: string }
  | { kind: "remove"; outpost: string }
  | null;

export interface ConnUi {
  ask: ConnAsk;
  /** a change is on its way: nothing else can be asked or typed */
  busy: boolean;
  /** which part of the tab the last change was in, so its words show there: this Mac's own row (`this_mac`) for its record,
   *  which the shop's list leaves out once the shell says which outpost is this Mac */
  at: "vault" | "outposts" | "this_mac" | null;
  /** why the last change did not happen, in the page's words; never a word of what was typed */
  error: string | null;
  /** what the last change did */
  notice: string | null;
}

export const CONN_START: ConnUi = { ask: null, busy: false, at: null, error: null, notice: null };

export type ConnAction =
  | { type: "add" }
  | { type: "addField"; field: "site" | "username" | "password"; text: string }
  | { type: "address"; index: number; text: string }
  | { type: "addressMore" }
  | { type: "addressLess"; index: number }
  | { type: "change"; signIn: string }
  | { type: "who"; signIn: string; members: string[] }
  | { type: "member"; member: string }
  | { type: "rename"; outpost: string; name: string; at?: "this_mac" }
  | { type: "remove"; outpost: string; at?: "this_mac" }
  | { type: "draft"; text: string }
  | { type: "cancel" }
  | { type: "begin" }
  | { type: "done"; notice: string }
  | { type: "failed"; message: string; close: boolean }
  | { type: "reset" };

/** The members ticked with `member` ticked or unticked, in the team's order. Only a member a sign-in may name is ever ticked. */
function toggled(on: readonly string[], member: string): string[] {
  if (!SIGN_IN_MEMBERS.includes(member)) return [...on];
  return SIGN_IN_MEMBERS.filter((m) => (m === member ? !on.includes(m) : on.includes(m)));
}

/** The open Add a sign-in's draft changed by `change`, or the state as it was when that question is not open or a change is
 *  on its way. */
function withDraft(s: ConnUi, change: (d: AddDraft) => AddDraft): ConnUi {
  return !s.busy && s.ask?.kind === "add" ? { ...s, ask: { kind: "add", draft: change(s.ask.draft) } } : s;
}

/** Moves the tab between asking, waiting on the runtime and done. One question at a time, and none while a change is on its
 *  way, so the owner cannot ask twice. A change's words show where its question was asked: the vault, the shop's list, or
 *  this Mac's own row. */
export function connReduce(s: ConnUi, a: ConnAction): ConnUi {
  switch (a.type) {
    case "add":
      return s.busy ? s : { ...s, ask: { kind: "add", draft: addStart() }, at: "vault", error: null, notice: null };
    case "addField":
      return withDraft(s, (d) => ({ ...d, [a.field]: a.text }));
    case "address":
      return withDraft(s, (d) => (a.index >= 0 && a.index < d.addresses.length ? { ...d, addresses: d.addresses.map((x, i) => (i === a.index ? a.text : x)) } : d));
    case "addressMore":
      return withDraft(s, (d) => (d.addresses.length < MAX_ORIGINS ? { ...d, addresses: [...d.addresses, ""] } : d));
    case "addressLess":
      return withDraft(s, (d) => (d.addresses.length > 1 ? { ...d, addresses: d.addresses.filter((_, i) => i !== a.index) } : d));
    case "change":
      return s.busy ? s : { ...s, ask: { kind: "password", signIn: a.signIn, draft: "" }, at: "vault", error: null, notice: null };
    case "who":
      return s.busy ? s : { ...s, ask: { kind: "members", signIn: a.signIn, members: SIGN_IN_MEMBERS.filter((m) => a.members.includes(m)) }, at: "vault", error: null, notice: null };
    case "member":
      if (s.busy) return s;
      if (s.ask?.kind === "members") return { ...s, ask: { ...s.ask, members: toggled(s.ask.members, a.member) } };
      return withDraft(s, (d) => ({ ...d, members: toggled(d.members, a.member) }));
    case "rename":
      return s.busy ? s : { ...s, ask: { kind: "rename", outpost: a.outpost, draft: a.name }, at: a.at ?? "outposts", error: null, notice: null };
    case "remove":
      return s.busy ? s : { ...s, ask: { kind: "remove", outpost: a.outpost }, at: a.at ?? "outposts", error: null, notice: null };
    case "draft":
      return !s.busy && (s.ask?.kind === "password" || s.ask?.kind === "rename") ? { ...s, ask: { ...s.ask, draft: a.text } } : s;
    case "cancel":
      return s.busy ? s : { ...s, ask: null, error: null };
    // The password leaves the page's state here, as it is sent: whatever comes back, nothing keeps it to send again. The
    // rest of a new sign-in stays, so a refusal can be fixed without typing it all again. The words stay where the question
    // was asked, which opening it set.
    case "begin":
      return { ...s, busy: true, at: s.ask === null ? null : s.at, error: null, notice: null, ask: withoutPassword(s.ask) };
    case "done":
      return { ask: null, busy: false, at: s.at, error: null, notice: a.notice };
    // A refusal keeps the question open, so the owner can read why and try again (a password typed again, a name fixed),
    // unless what it was about is gone.
    case "failed":
      return { ...s, busy: false, error: a.message, ask: a.close ? null : s.ask };
    case "reset":
      return CONN_START;
  }
}

/** The open question with any typed password taken out of it. */
function withoutPassword(ask: ConnAsk): ConnAsk {
  if (ask?.kind === "password") return { ...ask, draft: "" };
  if (ask?.kind === "add") return { kind: "add", draft: { ...ask.draft, password: "" } };
  return ask;
}

/** A password is ready to save once something is typed, up to what the vault takes. Spaces count: a password is typed
 *  exactly as the owner gave it. */
export const passwordReady = (draft: string): boolean => draft.length > 0 && draft.length <= MAX_PASSWORD;

/** What an address field holds, read as the vault would keep it: nothing yet, the site's origin (and whether that differs
 *  from what was typed, a path cut off say), or why it cannot be one. */
export type AddressRead =
  | { kind: "empty" }
  | { kind: "origin"; origin: string; changed: boolean }
  | { kind: "problem"; problem: "not_https" | "not_address" | "account" | "repeated" };

/** One address as the owner pasted it from the browser: its origin, which is what the vault keeps and what the outpost's
 *  browser is held to. A page's address keeps only its site's part. One that is not https is said plainly, as is one that
 *  holds an account's name or password, which is never sent: those go in their own fields. */
export function readAddress(text: string): AddressRead {
  const typed = text.trim();
  if (typed === "") return { kind: "empty" };
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return { kind: "problem", problem: "not_address" };
  }
  if (url.protocol !== "https:") return { kind: "problem", problem: "not_https" };
  if (url.username !== "" || url.password !== "") return { kind: "problem", problem: "account" };
  if (url.hostname === "" || url.origin.length > MAX_ORIGIN_LENGTH) return { kind: "problem", problem: "not_address" };
  return { kind: "origin", origin: url.origin, changed: url.origin !== typed };
}

/** Every address field read, a second one with the same origin as an earlier one said to be a repeat. */
export function readAddresses(addresses: readonly string[]): AddressRead[] {
  const seen = new Set<string>();
  return addresses.map((text) => {
    const read = readAddress(text);
    if (read.kind !== "origin") return read;
    if (seen.has(read.origin)) return { kind: "problem", problem: "repeated" };
    seen.add(read.origin);
    return read;
  });
}

/** What the page says about an address it cannot keep, in the owner's language. */
export function addressProblem(problem: Extract<AddressRead, { kind: "problem" }>["problem"]): string {
  if (problem === "not_https") return t("vault.add.notHttps");
  if (problem === "account") return t("vault.add.account");
  if (problem === "repeated") return t("vault.add.repeated");
  return t("vault.add.notAddress");
}

/** Whether the site's name says something the vault would not keep (too long, or a character no form takes), once anything
 *  is typed. An empty name is not a problem to point at: Add simply waits for one. */
export const siteProblem = (draft: AddDraft): boolean => draft.site.trim() !== "" && siteOf(draft.site) === null;
/** The same for the account's name. */
export const usernameProblem = (draft: AddDraft): boolean => draft.username.trim() !== "" && !usernameOk(draft.username.trim());

/** The new sign-in to send, once the vault would take it, or null while anything is missing or wrong: the site's name
 *  trimmed, the addresses' origins with empty fields left out, the account's name without the spaces a paste brings at its
 *  ends, the password exactly as typed, and the members in the team's order. */
export function addFields(draft: AddDraft): NewSignIn | null {
  const reads = readAddresses(draft.addresses);
  if (reads.some((r) => r.kind === "problem")) return null;
  const origins = reads.flatMap((r) => (r.kind === "origin" ? [r.origin] : []));
  const fields: NewSignIn = { site: draft.site.trim(), origins, username: draft.username.trim(), password: draft.password, members: [...draft.members] };
  return newSignInRefusal(fields) === null ? fields : null;
}

/** Who may use a sign-in is ready to save once at least one member is ticked and it differs from who may now. */
export function membersReady(chosen: readonly string[], current: readonly string[]): boolean {
  const now = new Set(current);
  return chosen.length > 0 && chosen.every((m) => SIGN_IN_MEMBERS.includes(m)) && (chosen.length !== now.size || chosen.some((m) => !now.has(m)));
}

/** The members named, as the team is named, joined as the owner's language joins them: "Nam and Ton". */
export const whoText = (members: readonly string[]): string => listText(members.map(memberName));

/** A name is ready once it is 1 to 80 letters once trimmed, with no control characters, and says something new. */
export function nameReady(draft: string, current: string): boolean {
  const name = draft.trim();
  return name !== "" && [...name].length <= MAX_OUTPOST_NAME && !/[\u0000-\u001f\u007f]/.test(name) && name !== current;
}

/** What the tab says to the runtime's refusals, by code, in the owner's language. Any other refusal is said in the runtime's
 *  own words. */
const REFUSALS = new Map<string, () => string>([
  ["owner_only", () => t("conn.err.ownerOnly")],
  ["invalid_password", () => t("conn.err.password", { max: MAX_PASSWORD })],
  ["sign_in_not_found", () => t("conn.err.signInGone")],
  ["invalid_name", () => t("conn.err.name", { max: MAX_OUTPOST_NAME })],
  ["outpost_not_found", () => t("conn.err.outpostGone")],
  ["invalid_site", () => t("conn.err.site", { max: MAX_SITE })],
  ["invalid_origins", () => t("conn.err.origins", { max: MAX_ORIGINS })],
  ["invalid_username", () => t("conn.err.username", { max: MAX_USERNAME })],
  ["invalid_members", () => t("conn.err.members")],
  ["too_many_sign_ins", () => t("conn.err.tooMany", { max: MAX_SIGN_INS })],
  ["vault_not_configured", () => t("conn.err.vaultKey")],
  ["no_shop", () => t("conn.err.noShop")],
]);

export function refusalText(code: string, message: string): string {
  return REFUSALS.get(code)?.() ?? message;
}

/** The five changes, which the tab sends through its own client of the runtime. */
export interface ConnectionsCalls {
  add(shop: string | null, fields: NewSignIn): Promise<{ signIn: VaultSignIn }>;
  password(shop: string | null, signIn: string, password: string): Promise<{ signIn: VaultSignIn }>;
  members(shop: string | null, signIn: string, members: string[]): Promise<{ signIn: VaultSignIn }>;
  rename(shop: string | null, outpost: string, name: string): Promise<{ outpost: ShopOutpost }>;
  remove(shop: string | null, outpost: string): Promise<{ outpost: string }>;
}

export type ConnDo =
  | { what: "add"; fields: NewSignIn }
  | { what: "password"; signIn: string; password: string }
  | { what: "members"; signIn: string; members: string[] }
  | { what: "rename"; outpost: string; name: string }
  | { what: "remove"; outpost: string };

/** The password a change carries, if it carries one. */
const passwordIn = (todo: ConnDo): string | null => (todo.what === "password" ? todo.password : todo.what === "add" ? todo.fields.password : null);

/** Asks the runtime to make the change, on the shop the lists were read for, and says what the lists are now and how the tab
 *  moves on. A row the runtime says is gone is dropped, since the owner is looking at a list that went out of date. */
export async function connectionsDo(calls: ConnectionsCalls, data: ShopConnections, todo: ConnDo): Promise<{ data: ShopConnections; action: ConnAction }> {
  try {
    switch (todo.what) {
      case "add": {
        const { signIn } = await calls.add(data.shop, todo.fields);
        return {
          data: { ...data, signIns: [...data.signIns.filter((s) => s.id !== signIn.id), signIn] },
          action: { type: "done", notice: t("vault.addedNotice", { site: signIn.site, who: whoText(signIn.members) }) },
        };
      }
      case "password": {
        const { signIn } = await calls.password(data.shop, todo.signIn, todo.password);
        return { data: { ...data, signIns: data.signIns.map((s) => (s.id === signIn.id ? signIn : s)) }, action: { type: "done", notice: t("vault.saved") } };
      }
      case "members": {
        const { signIn } = await calls.members(data.shop, todo.signIn, todo.members);
        return {
          data: { ...data, signIns: data.signIns.map((s) => (s.id === signIn.id ? signIn : s)) },
          action: { type: "done", notice: t("vault.whoSaved", { site: signIn.site, who: whoText(signIn.members) }) },
        };
      }
      case "rename": {
        const { outpost } = await calls.rename(data.shop, todo.outpost, todo.name);
        return { data: { ...data, outposts: data.outposts.map((o) => (o.id === outpost.id ? outpost : o)) }, action: { type: "done", notice: t("outposts.renamed", { name: outpost.name }) } };
      }
      case "remove": {
        const { outpost } = await calls.remove(data.shop, todo.outpost);
        const name = data.outposts.find((o) => o.id === outpost)?.name ?? "";
        return { data: { ...data, outposts: data.outposts.filter((o) => o.id !== outpost) }, action: { type: "done", notice: t("outposts.removed", { name }) } };
      }
    }
  } catch (e) {
    const why = unavailable(e);
    const code = why.kind === "unavailable" ? why.code : "internal";
    let message = why.kind === "unavailable" ? refusalText(code, why.message) : t("conn.err.failed");
    // Whatever a runtime says, the tab never shows the password it was sent.
    const password = passwordIn(todo);
    if (password !== null && message.includes(password)) message = t("conn.err.failed");
    if (code === "sign_in_not_found" && (todo.what === "password" || todo.what === "members")) {
      return { data: { ...data, signIns: data.signIns.filter((s) => s.id !== todo.signIn) }, action: { type: "failed", message, close: true } };
    }
    if (code === "outpost_not_found" && (todo.what === "rename" || todo.what === "remove")) {
      return { data: { ...data, outposts: data.outposts.filter((o) => o.id !== todo.outpost) }, action: { type: "failed", message, close: true } };
    }
    // A full vault takes no new sign-in, whatever is typed, so the question closes and the words say why.
    if (code === "too_many_sign_ins") return { data, action: { type: "failed", message, close: true } };
    return { data, action: { type: "failed", message, close: false } };
  }
}
