// Customize › Connections for the shop's owner, kept apart from the page so it can be tested without one: how a vault
// sign-in and an outpost are said, how the in-place questions move (Change, Rename, Remove), and how a change reaches the
// runtime. The design canvas's boards are "Customize: connections" (Connections.dc.html) and "States: customize"
// (StatesCustomize.dc.html). The rules are the API's: the runtime applies them (src/runtime/connections.ts), and nothing
// here decides who may see or change what.
//
// The typed password is the one thing here that must not stay. It lives in the open Change question's draft only while the
// owner types; it leaves the page's state the moment Save is pressed (`begin`), goes once to the runtime through the tab's
// own client (ConnectionsPane.tsx, never the store), and is not put back when the send fails: the owner types it again. No
// word the page shows holds it, a refusal's included.
import { hhmm, sameDay } from "../app/time";
import { listText, t } from "../i18n";
import { MAX_OUTPOST_NAME, MAX_PASSWORD, type ShopConnections, type ShopOutpost, type VaultSignIn } from "../runtime/connections";
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

/** The one question open in the tab: a new password for a sign-in, a new name for an outpost, or whether to remove one.
 *  Nothing is changed until the owner answers it. */
export type ConnAsk = { kind: "password"; signIn: string; draft: string } | { kind: "rename"; outpost: string; draft: string } | { kind: "remove"; outpost: string } | null;

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
  | { type: "change"; signIn: string }
  | { type: "rename"; outpost: string; name: string; at?: "this_mac" }
  | { type: "remove"; outpost: string; at?: "this_mac" }
  | { type: "draft"; text: string }
  | { type: "cancel" }
  | { type: "begin" }
  | { type: "done"; notice: string }
  | { type: "failed"; message: string; close: boolean }
  | { type: "reset" };

/** Moves the tab between asking, waiting on the runtime and done. One question at a time, and none while a change is on its
 *  way, so the owner cannot ask twice. A change's words show where its question was asked: the vault, the shop's list, or
 *  this Mac's own row. */
export function connReduce(s: ConnUi, a: ConnAction): ConnUi {
  switch (a.type) {
    case "change":
      return s.busy ? s : { ...s, ask: { kind: "password", signIn: a.signIn, draft: "" }, at: "vault", error: null, notice: null };
    case "rename":
      return s.busy ? s : { ...s, ask: { kind: "rename", outpost: a.outpost, draft: a.name }, at: a.at ?? "outposts", error: null, notice: null };
    case "remove":
      return s.busy ? s : { ...s, ask: { kind: "remove", outpost: a.outpost }, at: a.at ?? "outposts", error: null, notice: null };
    case "draft":
      return !s.busy && (s.ask?.kind === "password" || s.ask?.kind === "rename") ? { ...s, ask: { ...s.ask, draft: a.text } } : s;
    case "cancel":
      return s.busy ? s : { ...s, ask: null, error: null };
    // The password leaves the page's state here, as it is sent: whatever comes back, nothing keeps it to send again. The
    // words stay where the question was asked, which opening it set.
    case "begin":
      return { ...s, busy: true, at: s.ask === null ? null : s.at, error: null, notice: null, ask: s.ask?.kind === "password" ? { ...s.ask, draft: "" } : s.ask };
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

/** A password is ready to save once something is typed, up to what the vault takes. Spaces count: a password is typed
 *  exactly as the owner gave it. */
export const passwordReady = (draft: string): boolean => draft.length > 0 && draft.length <= MAX_PASSWORD;

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
]);

export function refusalText(code: string, message: string): string {
  return REFUSALS.get(code)?.() ?? message;
}

/** The three changes, which the tab sends through its own client of the runtime. */
export interface ConnectionsCalls {
  password(shop: string | null, signIn: string, password: string): Promise<{ signIn: VaultSignIn }>;
  rename(shop: string | null, outpost: string, name: string): Promise<{ outpost: ShopOutpost }>;
  remove(shop: string | null, outpost: string): Promise<{ outpost: string }>;
}

export type ConnDo = { what: "password"; signIn: string; password: string } | { what: "rename"; outpost: string; name: string } | { what: "remove"; outpost: string };

/** Asks the runtime to make the change, on the shop the lists were read for, and says what the lists are now and how the tab
 *  moves on. A row the runtime says is gone is dropped, since the owner is looking at a list that went out of date. */
export async function connectionsDo(calls: ConnectionsCalls, data: ShopConnections, todo: ConnDo): Promise<{ data: ShopConnections; action: ConnAction }> {
  try {
    switch (todo.what) {
      case "password": {
        const { signIn } = await calls.password(data.shop, todo.signIn, todo.password);
        return { data: { ...data, signIns: data.signIns.map((s) => (s.id === signIn.id ? signIn : s)) }, action: { type: "done", notice: t("vault.saved") } };
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
    if (todo.what === "password" && message.includes(todo.password)) message = t("conn.err.failed");
    if (code === "sign_in_not_found" && todo.what === "password") {
      return { data: { ...data, signIns: data.signIns.filter((s) => s.id !== todo.signIn) }, action: { type: "failed", message, close: true } };
    }
    if (code === "outpost_not_found" && todo.what !== "password") {
      return { data: { ...data, outposts: data.outposts.filter((o) => o.id !== todo.outpost) }, action: { type: "failed", message, close: true } };
    }
    return { data, action: { type: "failed", message, close: false } };
  }
}
