// Settings › People for the shop's owner (people.ts, PeoplePane.tsx): the canvas's list, its form, its question and its cover drawn
// with react-dom/server in each state the boards draw, the words for each answer the routes can give, the roles table held to
// approval-core's own rule, and above all that a change goes to the shop its list was read for and a refusal is said in plain words.
// The views use no hooks, so a test calls them as plain functions to read the handlers a string render leaves out.
import { mayDecide, type ApprovalKind } from "@manut/approval-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { DICT, LANGS, setLang, t } from "../i18n";
import type { ShopAway, ShopHelper, ShopInvite, ShopPeople } from "../runtime/people";
import { LOADING } from "./load";
import {
  canText,
  contactKind,
  countLine,
  coverLine,
  coverReady,
  devicesLine,
  endOfDay,
  helperLines,
  helperShopWords,
  identityOf,
  inviteLines,
  inviteReady,
  nameTooLong,
  ownerLine,
  PEOPLE_START,
  peopleDo,
  peopleReduce,
  refusalText,
  removedNotice,
  roleRows,
  todayField,
  weekdayDay,
  type PeopleAction,
  type PeopleCalls,
  type PeopleUi,
} from "./people";
import { PeopleView, peopleOffered, RolesPane, SafetyPane, toneOf, type PeopleProps } from "./PeoplePane";

/** Tuesday 24 November 2026, 10:00 on this computer's clock. */
const NOW = new Date(2026, 10, 24, 10, 0).getTime();
const at = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime() / 1000;
const SHOP = "pilot:baan-mali";

const mint: ShopHelper = { id: "helper-mint", name: "Mint", identity: { kind: "email", address: "mint@example.com" }, joinedAt: at(11, 2, 9), devices: 2 };
const beam: ShopInvite = { id: "inv-beam", name: "Beam", identity: { kind: "line", id: "beam.baanmali" }, state: "pending", createdAt: at(11, 24, 9, 20), expiresAt: at(12, 1, 9, 20), link: "https://dev.manut.xyz/join/token-beam" };
const tum: ShopInvite = { id: "inv-tum", name: "Tum", identity: { kind: "email", address: "tum@example.com" }, state: "pending", createdAt: at(11, 22, 14, 5), expiresAt: at(11, 29, 14, 5), link: "https://dev.manut.xyz/join/token-tum" };
const old: ShopInvite = { id: "inv-old", name: "Ice", identity: { kind: "email", address: "ice@example.com" }, state: "expired", createdAt: at(11, 10, 9), expiresAt: at(11, 17, 9), link: null };
const people = (over: Partial<ShopPeople> = {}): ShopPeople => ({ shop: SHOP, owner: { name: "Fon", devices: 1 }, helpers: [mint], invites: [beam], away: null, ...over });
const covering: ShopAway = { helperId: "helper-mint", name: "Mint", until: at(11, 27, 23, 59), inForce: true };

const props = (over: Partial<PeopleProps> = {}): PeopleProps => ({
  state: { kind: "ready", value: people() },
  ui: PEOPLE_START,
  nowMs: NOW,
  shop: "Baan Mali",
  only: null,
  dispatch: () => {},
  onInvite: () => {},
  onRemove: () => {},
  onCancel: () => {},
  onCopy: () => {},
  onCover: () => {},
  onEndCover: () => {},
  onRetry: () => {},
  ...over,
});
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const view = (p: PeopleProps) => renderToString(<PeopleView p={p} />);

/** Every element a view draws, with its own components expanded. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const tree = (p: PeopleProps) => drawn(PeopleView({ p }));
const byTestId = (p: PeopleProps, id: string) => tree(p).filter((e) => e.props["data-testid"] === id);
const ui = (...actions: PeopleAction[]): PeopleUi => actions.reduce(peopleReduce, PEOPLE_START);

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("how the people are said", () => {
  it("counts the owner and the helpers as people, and an invite that waits as invited, not an invite that ran out", () => {
    expect(countLine({ helpers: [], invites: [] })).toBe("1 person");
    expect(countLine({ helpers: [mint], invites: [] })).toBe("2 people");
    expect(countLine({ helpers: [mint], invites: [beam] })).toBe("2 people, 1 invited");
    expect(countLine({ helpers: [mint], invites: [beam, tum, old] })).toBe("2 people, 2 invited");
    expect(countLine({ helpers: [mint], invites: [old] })).toBe("2 people");
  });

  it("says on how many devices someone is signed in", () => {
    expect([0, 1, 2].map(devicesLine)).toEqual(["Not signed in on any device", "Signed in on 1 device", "Signed in on 2 devices"]);
    expect(ownerLine({ owner: { name: "Fon", devices: 1 } })).toBe("Signed in on 1 device");
    expect(ownerLine({ owner: { name: "Fon", devices: null } })).toBe("");
  });

  it("says when a helper joined and which account they signed in with, as the canvas does", () => {
    expect(helperLines(mint, NOW)).toEqual(["Helper since 2 November", "mint@example.com. Signed in on 2 devices."]);
    expect(helperLines({ ...mint, identity: { kind: "line", id: "mint.line" }, devices: 0 }, NOW)[1]).toBe("LINE ID mint.line. Not signed in on any device.");
  });

  it("says when an invite was made and until when it works, and for a LINE ID that nobody can open it yet", () => {
    expect(inviteLines(beam, NOW)).toEqual(["Invite made today at 09:20. It works once, until Tuesday 1 December.", "Nobody can open a LINE invite yet: signing in with LINE is not built."]);
    expect(inviteLines(tum, NOW)).toEqual(["Invite made 22 November at 14:05. It works once, until Sunday 29 November."]);
    expect(inviteLines(old, NOW)).toEqual(["This invite ran out on Tuesday 17 November. Invite again for a new link."]);
  });

  it("writes a day with its weekday, with the year when it is not this year", () => {
    expect(weekdayDay(at(11, 27, 23, 59), NOW)).toBe("Friday 27 November");
    expect(weekdayDay(new Date(2027, 0, 3, 12).getTime() / 1000, NOW)).toBe("Sunday 3 January 2027");
  });

  it("says who covers and until when, or that the cover is over, or nothing when it was never set", () => {
    expect(coverLine(covering, NOW)).toBe("You are away until Friday 27 November. Mint is covering messages.");
    expect(coverLine({ ...covering, inForce: false, until: at(11, 20, 23, 59) }, NOW)).toBe("The cover for Mint ended on Friday 20 November. Nobody is covering now.");
    expect(coverLine({ ...covering, name: "" }, NOW)).toBe("You are away until Friday 27 November. Helper is covering messages.");
    expect(coverLine(null, NOW)).toBeNull();
  });

  it("says what a removal did: signed out everywhere, then only what the API says it also did, and how to bring them back", () => {
    expect(removedNotice("Mint", { helper: "h", sessionsEnded: 2, invitesRevoked: 0, coverEnded: false })).toBe(
      "Mint was removed and signed out on every device. To let Mint back, invite them again.",
    );
    expect(removedNotice("Mint", { helper: "h", sessionsEnded: 2, invitesRevoked: 1, coverEnded: true })).toBe(
      "Mint was removed and signed out on every device. 1 pending invite for them was cancelled. Their cover has ended. To let Mint back, invite them again.",
    );
    expect(removedNotice("Mint", { helper: "h", sessionsEnded: 0, invitesRevoked: 3, coverEnded: false })).toContain("3 pending invites for them were cancelled.");
    // Japanese and Chinese run their sentences on after the full stop
    setLang("ja");
    expect(removedNotice("ミント", { helper: "h", sessionsEnded: 1, invitesRevoked: 0, coverEnded: false })).toBe(`${t("people.removed", { name: "ミント" })}${t("people.removedAgain", { name: "ミント" })}`);
  });

  it("says no Undo: a removal ends every session of theirs, so the notice says they can be invited again instead", () => {
    const notice = removedNotice("Mint", { helper: "h", sessionsEnded: 2, invitesRevoked: 0, coverEnded: false });
    expect(notice).not.toMatch(/undo/i);
    for (const lang of LANGS) {
      setLang(lang);
      const text = removedNotice("Mint", { helper: "h", sessionsEnded: 2, invitesRevoked: 0, coverEnded: false });
      expect(text, lang).toContain("Mint");
      expect(text, lang).not.toMatch(/undo|元に戻|되돌|撤销/i);
    }
  });
});

describe("what each role can do", () => {
  const rows = () => Object.fromEntries(roleRows().map((r) => [r.id, [r.owner, r.helper]]));

  it("reads the approval rows from approval-core's own rule, so they cannot say something it does not", () => {
    const pairs: [string, ApprovalKind[]][] = [
      ["messages", ["message", "reply"]],
      ["money", ["money"]],
      ["posts", ["public_post"]],
      ["payments", ["payment_confirmation"]],
    ];
    for (const [id, kinds] of pairs) {
      const [owner, helper] = rows()[id]!;
      expect(owner, id).toBe(kinds.every((k) => mayDecide("owner", k)) ? "yes" : "no");
      expect(helper, id).toBe(kinds.every((k) => mayDecide("helper", k)) ? "yes" : "asks");
    }
    // and says what the canvas says: a helper decides messages and replies, and asks the owner about money, posts and payments
    expect(rows().messages).toEqual(["yes", "yes"]);
    expect(rows().money).toEqual(["yes", "asks"]);
    expect(rows().posts).toEqual(["yes", "asks"]);
    expect(rows().payments).toEqual(["yes", "asks"]);
  });

  it("holds only rows that are true of the app as built, and leaves out the canvas's Code, sales and pricing rows", () => {
    expect(roleRows().map((r) => r.id)).toEqual(["messages", "money", "posts", "payments", "see", "knows", "change"]);
    // what a helper's session reaches: the requests that wait, and nothing of what the team knows or does (403 owner_only)
    expect(rows().see).toEqual(["yes", "yes"]);
    expect(rows().knows).toEqual(["yes", "no"]);
    expect(rows().change).toEqual(["yes", "no"]);
    const html = words(renderToString(<RolesPane />));
    expect(html).not.toMatch(/Use Code|sales|AI budget|the plan|free, up to|example|Usually online/i);
    expect(html).toBe(
      "What each role can do What Owner Helper " +
        "Approve messages and replies to customers Yes Yes " +
        "Approve money: refunds, discounts, payments Yes No, asks you " +
        "Approve public posts Yes No, asks you " +
        "Confirm that a payment arrived Yes No, asks you " +
        "See the requests that wait for an answer Yes Yes " +
        "See what the team knows and its past work Yes No " +
        "Change the team, rules, connections and settings Yes No " +
        "A request a helper can't approve waits for you. A helper can pass it on to you with a note.",
    );
    expect([canText("yes"), canText("no"), canText("asks")]).toEqual(["Yes", "No", "No, asks you"]);
  });

  it("makes no claim about a helper in any language that is not the English one", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const text = words(renderToString(<RolesPane />));
      expect(text, lang).not.toMatch(/\{\w+\}/);
      for (const key of ["people.role.messages", "people.role.change", "people.roles.hint"] as const) expect(text, `${lang} ${key}`).toContain(DICT[lang][key]);
    }
  });
});

describe("sign-in and safety", () => {
  it("says what is true of how everyone signs in, which is Apple, and not what the canvas says of LINE", () => {
    const text = words(renderToString(<SafetyPane />));
    expect(text).toBe("Sign-in and safety Everyone signs in with their own Apple ID. Nobody shares a password. Signing in with LINE is not available yet. Every approval is recorded with who made it.");
    expect(text).not.toMatch(/LINE or email|Security/);
  });
});

describe("what is typed", () => {
  it("reads one box as a LINE ID or an email, as the canvas has one box for both", () => {
    expect(identityOf("  beam.baanmali ")).toEqual({ kind: "line", id: "beam.baanmali" });
    expect(identityOf(" tum@example.com ")).toEqual({ kind: "email", address: "tum@example.com" });
    expect([contactKind(""), contactKind("  "), contactKind("beam"), contactKind("a@b.co")]).toEqual([null, null, "line", "email"]);
  });

  it("is ready to send only with a name the shop keeps and an account the rules accept", () => {
    expect(inviteReady("Beam", "beam.baanmali")).toBe(true);
    expect(inviteReady("Beam", "beam@example.com")).toBe(true);
    for (const [name, contact] of [["", "beam"], ["  ", "beam"], ["Beam", ""], ["Beam", "   "], ["Beam", "no-at@"], ["Beam", "a b@c.com"], ["x".repeat(81), "beam"], ["Beam\u0007", "beam"]]) {
      expect(inviteReady(name, contact), `${name} / ${contact}`).toBe(false);
    }
    expect([nameTooLong("x".repeat(80)), nameTooLong("x".repeat(81)), nameTooLong("🙂".repeat(80)), nameTooLong("🙂".repeat(81)), nameTooLong("")]).toEqual([false, true, false, true, false]);
  });

  it("makes the end of the chosen day on this computer's calendar, and refuses what is not a day", () => {
    expect(endOfDay("2026-11-27")).toBe(new Date(2026, 10, 27, 23, 59, 59).getTime() / 1000);
    for (const bad of ["", "27/11/2026", "2026-02-30", "2026-13-01", "2026-11-31", "tomorrow", "2026-1-5"]) expect(endOfDay(bad), bad).toBeNull();
    expect(todayField(NOW)).toBe("2026-11-24");
    // The last day of February in a leap year exists; in another year it does not.
    expect(endOfDay("2028-02-29")).not.toBeNull();
    expect(endOfDay("2026-02-29")).toBeNull();
  });

  it("is ready to set cover only with a helper and a day that has not passed", () => {
    expect(coverReady("helper-mint", "2026-11-27", NOW)).toBe(true);
    expect(coverReady("helper-mint", "2026-11-24", NOW)).toBe(true); // today: it lasts to the end of today
    expect(coverReady("helper-mint", "2026-11-23", NOW)).toBe(false);
    expect(coverReady("", "2026-11-27", NOW)).toBe(false);
    expect(coverReady("helper-mint", "", NOW)).toBe(false);
    expect(coverReady("helper-mint", "2026-02-30", NOW)).toBe(false);
  });
});

describe("how the page moves between asking, waiting and done", () => {
  it("opens the form with empty fields, takes what is typed only while it is open, and closes it on Cancel", () => {
    expect(ui({ type: "name", text: "x" }).ask).toBeNull();
    const open = ui({ type: "openInvite" }, { type: "name", text: "Beam" }, { type: "contact", text: "beam.baanmali" });
    expect(open.ask).toEqual({ kind: "invite", name: "Beam", contact: "beam.baanmali" });
    expect(open.at).toBe("who");
    expect(peopleReduce(open, { type: "cancel" }).ask).toBeNull();
  });

  it("asks one question at a time, and none while a change is on its way", () => {
    const asking = ui({ type: "askRemove", helper: "helper-mint" });
    expect(asking.ask).toEqual({ kind: "remove", helper: "helper-mint" });
    const busy = peopleReduce(asking, { type: "begin", at: "who" });
    expect(busy.busy).toBe(true);
    for (const a of [{ type: "openInvite" }, { type: "askRemove", helper: "x" }, { type: "cancel" }, { type: "coverHelper", helper: "x" }, { type: "coverDay", day: "2026-11-27" }] as PeopleAction[]) {
      expect(peopleReduce(busy, a), a.type).toBe(busy);
    }
    expect(peopleReduce(busy, { type: "name", text: "typed while busy" })).toBe(busy);
  });

  it("closes the question and says what was done when a change is done, and keeps the invite whose link is open", () => {
    const sent = ui({ type: "openInvite" }, { type: "begin", at: "who" });
    const done = peopleReduce(sent, { type: "done", notice: "The invite is ready.", made: "inv-1" });
    expect(done).toMatchObject({ ask: null, busy: false, error: null, notice: "The invite is ready.", made: "inv-1" });
    // a later change that names no invite leaves the open link as it was; naming none closes it
    expect(peopleReduce(done, { type: "done", notice: "Removed." }).made).toBe("inv-1");
    expect(peopleReduce(done, { type: "done", notice: "Cancelled.", made: null }).made).toBeNull();
    expect(peopleReduce(done, { type: "dismiss" }).made).toBeNull();
  });

  it("keeps the form open when a refusal comes, so it can be fixed, unless what it was about is gone", () => {
    const sent = peopleReduce(ui({ type: "openInvite" }, { type: "name", text: "Beam" }), { type: "begin", at: "who" });
    const kept = peopleReduce(sent, { type: "failed", message: "That did not work.", close: false });
    expect(kept).toMatchObject({ busy: false, error: "That did not work.", notice: null });
    expect(kept.ask).toEqual({ kind: "invite", name: "Beam", contact: "" });
    expect(peopleReduce(sent, { type: "failed", message: "Gone.", close: true }).ask).toBeNull();
  });

  it("shows a change's words where it was asked, and keeps the cover's fields until the cover is set", () => {
    const typed = ui({ type: "coverHelper", helper: "helper-mint" }, { type: "coverDay", day: "2026-11-27" });
    expect(typed.cover).toEqual({ helper: "helper-mint", day: "2026-11-27" });
    expect(peopleReduce(typed, { type: "begin", at: "cover" }).at).toBe("cover");
    expect(peopleReduce(typed, { type: "done", notice: "x", resetCover: true }).cover).toEqual({ helper: "", day: "" });
    expect(peopleReduce(typed, { type: "failed", message: "x", close: false }).cover).toEqual({ helper: "helper-mint", day: "2026-11-27" });
  });

  it("marks a link as copied for a moment, and starts again on reset", () => {
    const copied = peopleReduce(PEOPLE_START, { type: "copied", invite: "inv-beam" });
    expect(copied.copied).toBe("inv-beam");
    expect(peopleReduce(copied, { type: "uncopy" }).copied).toBeNull();
    expect(peopleReduce(ui({ type: "openInvite" }, { type: "begin", at: "who" }), { type: "reset" })).toBe(PEOPLE_START);
  });
});

/** The calls a fake runtime answers, each recording the shop it was sent for. */
function calls(over: Partial<PeopleCalls> = {}) {
  const sent: { op: string; shop: string }[] = [];
  const note = (op: string, shop: string) => sent.push({ op, shop });
  const fake: PeopleCalls = {
    invite: async (shop, name, identity) => (note("invite", shop), { invite: { ...tum, id: "inv-new", name, identity, link: "https://dev.manut.xyz/join/new" } }),
    cancelInvite: async (shop, invite) => (note("cancel", shop), { invite }),
    remove: async (shop, helper) => (note("remove", shop), { helper, sessionsEnded: 2, invitesRevoked: 0, coverEnded: false }),
    setAway: async (shop, helper, until) => (note("away", shop), { away: { helperId: helper, name: "Mint", until, inForce: true } }),
    clearAway: async (shop) => (note("back", shop), { away: null }),
    ...over,
  };
  return { fake, sent };
}
/** An error as the runtime throws it. */
const refused = (code: string, message = "words") => Object.assign(new Error(message), { code, message });

describe("making a change", () => {
  it("names the shop the list was read for in every change, never another", async () => {
    const data = people({ away: covering });
    const { fake, sent } = calls();
    await peopleDo(fake, data, { what: "invite", name: "Tum", contact: "tum@example.com" });
    await peopleDo(fake, data, { what: "cancel", invite: "inv-beam" });
    await peopleDo(fake, data, { what: "remove", helper: "helper-mint" });
    await peopleDo(fake, data, { what: "away", helper: "helper-mint", until: at(11, 27, 23, 59) });
    await peopleDo(fake, data, { what: "back" });
    expect(sent).toEqual([
      { op: "invite", shop: SHOP },
      { op: "cancel", shop: SHOP },
      { op: "remove", shop: SHOP },
      { op: "away", shop: SHOP },
      { op: "back", shop: SHOP },
    ]);
  });

  it("puts a new invite first in the list, opens its link, and says it is ready", async () => {
    const step = await peopleDo(calls().fake, people(), { what: "invite", name: "Tum", contact: "tum@example.com" });
    expect(step.data.invites.map((i) => i.id)).toEqual(["inv-new", "inv-beam"]);
    expect(step.action).toEqual({ type: "done", notice: "The invite for Tum is ready.", made: "inv-new" });
    expect(step.reread).toBe(false);
  });

  it("takes a cancelled invite out of the list, names it in the words, and closes its link", async () => {
    const step = await peopleDo(calls().fake, people({ invites: [beam, tum] }), { what: "cancel", invite: "inv-beam" });
    expect(step.data.invites.map((i) => i.id)).toEqual(["inv-tum"]);
    expect(step.action).toEqual({ type: "done", notice: "The invite for Beam was cancelled.", made: null });
  });

  it("takes a removed helper out, with the invites that waited for their account and their cover, as many as the API counted", async () => {
    const mintInvite: ShopInvite = { ...tum, id: "inv-mint", name: "Mint", identity: { kind: "email", address: "MINT@example.com" } };
    const data = people({ invites: [beam, mintInvite], away: covering });
    const { fake } = calls({ remove: async (_shop, helper) => ({ helper, sessionsEnded: 2, invitesRevoked: 1, coverEnded: true }) });
    const step = await peopleDo(fake, data, { what: "remove", helper: "helper-mint" });
    expect(step.data.helpers).toEqual([]);
    // the invite for Mint's account (compared without case) goes; Beam's, for another account, stays
    expect(step.data.invites.map((i) => i.id)).toEqual(["inv-beam"]);
    expect(step.data.away).toBeNull();
    expect(step.action).toMatchObject({ type: "done" });
    expect((step.action as { notice: string }).notice).toBe(
      "Mint was removed and signed out on every device. 1 pending invite for them was cancelled. Their cover has ended. To let Mint back, invite them again.",
    );
    // with none counted, nothing else is taken out of the list
    const plain = await peopleDo(calls().fake, data, { what: "remove", helper: "helper-mint" });
    expect(plain.data.invites.map((i) => i.id)).toEqual(["inv-beam", "inv-mint"]);
    expect(plain.data.away).toEqual(covering);
  });

  it("sets the cover to what the API answers and says until when, and ends it", async () => {
    const until = at(11, 27, 23, 59);
    const step = await peopleDo(calls().fake, people(), { what: "away", helper: "helper-mint", until }, NOW);
    expect(step.data.away).toEqual({ helperId: "helper-mint", name: "Mint", until, inForce: true });
    expect(step.action).toEqual({ type: "done", notice: "Mint covers messages until Friday 27 November.", resetCover: true });
    const back = await peopleDo(calls().fake, people({ away: covering }), { what: "back" });
    expect(back.data.away).toBeNull();
    expect(back.action).toEqual({ type: "done", notice: "The cover has ended." });
  });

  it("says each refusal of the routes in plain words, and leaves the list as it was", async () => {
    const cases: [string, string][] = [
      ["already_invited", t("people.err.alreadyInvited")],
      ["already_helper", t("people.err.alreadyHelper")],
      ["bad_identity", t("people.err.identity")],
      ["invalid_name", t("people.err.name", { max: 80 })],
      ["invalid_request", t("people.err.invite")],
      ["unknown_invite", t("people.err.inviteGone")],
      ["not_pending", t("people.err.notPending")],
      ["not_a_helper", t("people.err.notHelper")],
      ["bad_date", t("people.err.date")],
      ["owner_only", t("people.err.ownerOnly")],
      ["no_shop", t("people.err.noShop")],
      ["not_found", t("people.err.notFound")],
    ];
    for (const [code, message] of cases) {
      const data = people();
      const { fake } = calls({ invite: async () => Promise.reject(refused(code, "the runtime's own words")) });
      const step = await peopleDo(fake, data, { what: "invite", name: "Tum", contact: "tum@example.com" });
      expect(step.data, code).toBe(data);
      expect(step.action, code).toMatchObject({ type: "failed", message });
    }
  });

  it("closes the question and reads the list again when what it was about is gone, and for a refusal that says the list moved on", async () => {
    for (const code of ["not_a_helper", "unknown_invite", "not_pending"]) {
      const { fake } = calls({ remove: async () => Promise.reject(refused(code)), cancelInvite: async () => Promise.reject(refused(code)) });
      for (const todo of [{ what: "remove", helper: "helper-mint" }, { what: "cancel", invite: "inv-beam" }] as const) {
        const step = await peopleDo(fake, people(), todo);
        expect(step.action, `${code} ${todo.what}`).toMatchObject({ type: "failed", close: true });
        expect(step.reread, `${code} ${todo.what}`).toBe(true);
      }
    }
    for (const code of ["already_invited", "already_helper"]) {
      const { fake } = calls({ invite: async () => Promise.reject(refused(code)) });
      const step = await peopleDo(fake, people(), { what: "invite", name: "Tum", contact: "tum@example.com" });
      expect(step.action).toMatchObject({ type: "failed", close: false });
      expect(step.reread).toBe(true);
    }
  });

  it("reads the list again when a change's outcome is unknown, and not when nothing was sent", async () => {
    const unknown = calls({ remove: async () => Promise.reject(refused("unavailable", t("rt.change.noReply"))) });
    const step = await peopleDo(unknown.fake, people(), { what: "remove", helper: "helper-mint" });
    expect(step.action).toEqual({ type: "failed", message: t("rt.change.noReply"), close: false });
    expect(step.reread).toBe(true);
    for (const code of ["offline", "signed_out", "bad_identity", "owner_only", "bad_date"]) {
      const none = calls({ invite: async () => Promise.reject(refused(code)) });
      expect((await peopleDo(none.fake, people(), { what: "invite", name: "Tum", contact: "tum@example.com" })).reread, code).toBe(false);
    }
  });

  it("says a failure it has no words for as the page's own, and a refusal it does not know in the runtime's words", async () => {
    const plain = await peopleDo(calls({ clearAway: async () => Promise.reject(new TypeError("boom")) }).fake, people(), { what: "back" });
    expect(plain.action).toMatchObject({ type: "failed", message: t("people.err.failed") });
    const other = await peopleDo(calls({ clearAway: async () => Promise.reject(refused("offline", "Offline: the Manut AI API cannot be reached.")) }).fake, people(), { what: "back" });
    expect(other.action).toMatchObject({ type: "failed", message: "Offline: the Manut AI API cannot be reached." });
    expect(refusalText("something_else", "its words")).toBe("its words");
  });

  it("says the same refusal in every language, with no slot left open", async () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const code of ["already_invited", "bad_date", "not_a_helper", "owner_only", "invalid_name"]) expect(refusalText(code, "x"), `${lang} ${code}`).not.toMatch(/\{\w+\}|^x$/);
    }
  });
});

describe("the page, drawn", () => {
  it("draws the canvas's list: the owner marked you, each helper with when they joined, then the invites that wait", () => {
    const html = words(view(props()));
    expect(html.startsWith("People Invite a helper Who can use Manut AI for Baan Mali 2 people, 1 invited ")).toBe(true);
    expect(html).toContain("F Fon (you) Signed in on 1 device Owner");
    expect(html).toContain("M Mint Helper since 2 November mint@example.com. Signed in on 2 devices. Helper Remove");
    expect(html).toContain("B Beam Invite made today at 09:20. It works once, until Tuesday 1 December. Nobody can open a LINE invite yet: signing in with LINE is not built. Invited Copy link Cancel invite");
    // the canvas's words for what the page could not say as built are not on it
    expect(html).not.toMatch(/Usually online|Undo|We send the invite|Send invite|Helpers are free|Use Code|Security/);
  });

  it("names the shop in the heading, or says your shop when none names it", () => {
    expect(words(view(props({ shop: "" })))).toContain("Who can use Manut AI for your shop");
    expect(words(view(props({ shop: "Suan Dok Mai" })))).toContain("Who can use Manut AI for Suan Dok Mai");
  });

  it("says there is nobody else yet, and offers to invite", () => {
    const html = words(view(props({ state: { kind: "ready", value: people({ helpers: [], invites: [] }) } })));
    expect(html).toContain("1 person");
    expect(html).toContain("No helpers yet. Invite a helper to let someone else approve messages and replies.");
  });

  it("shows an invite that ran out as one that ran out, with neither Copy link nor Cancel invite", () => {
    const p = props({ state: { kind: "ready", value: people({ invites: [old] }) } });
    const html = words(view(p));
    expect(html).toContain("Ice This invite ran out on Tuesday 17 November. Invite again for a new link. Expired");
    expect(byTestId(p, "people-copy")).toHaveLength(0);
    expect(byTestId(p, "people-cancel-invite")).toHaveLength(0);
    // the owner and Mint are the two people; an invite that ran out is not invited
    expect(words(view(p))).toContain("Who can use Manut AI for Baan Mali 2 people F Fon");
  });

  it("says plainly that Manut AI does not send the invite, in the form and beside the link", () => {
    const form = props({ ui: ui({ type: "openInvite" }) });
    const formHtml = words(view(form));
    expect(formHtml).toContain("Invite a helper Name 1 to 80 letters. This is how you will see them here. LINE ID or email Manut AI does not send the invite. You get a link to send them yourself. It works once, for 7 days.");
    expect(formHtml).not.toContain("We send");
    const made = props({ ui: ui({ type: "begin", at: "who" }, { type: "done", notice: t("people.inv.made", { name: "Beam" }), made: "inv-beam" }) });
    const madeHtml = words(view(made));
    expect(madeHtml).toContain("The invite for Beam is ready.");
    expect(madeHtml).toContain("Send this link to Beam yourself. Manut AI does not send it.");
    expect(madeHtml).toContain("Copy link");
    const link = byTestId(made, "people-link")[0]!;
    expect([link.props.value, link.props.readOnly]).toEqual(["https://dev.manut.xyz/join/token-beam", true]);
  });

  it("says what the kind of account typed needs: a LINE ID cannot be opened yet, an email only by an Apple ID that uses it", () => {
    const note = (contact: string) => {
      const p = props({ ui: ui({ type: "openInvite" }, { type: "contact", text: contact }) });
      return byTestId(p, "people-contact-note").map((e) => words(renderToString(e.props.children as ReactNode)));
    };
    expect(note("")).toEqual([]);
    expect(note("beam.baanmali")).toEqual(["Signing in with LINE is not built yet, so an invite for a LINE ID cannot be opened until it is. To invite someone now, use their email address."]);
    expect(note("beam@example.com")).toEqual(["This invite opens only for someone who signs in with an Apple ID that uses this address."]);
  });

  it("says in the invite row that nobody can open a LINE invite yet, and not for an email", () => {
    const p = props({ state: { kind: "ready", value: people({ invites: [tum, beam] }) } });
    const rows = byTestId(p, "people-invite-row");
    const lines = rows.map((r) => drawn(r.props.children as ReactNode).filter((e) => e.props["data-testid"] === "people-invite-line").length);
    expect(lines).toEqual([1, 2]);
  });

  it("is not ready to make a link until there is a name and an account the rules accept, and is when there is", () => {
    const make = (name: string, contact: string) =>
      byTestId(props({ ui: ui({ type: "openInvite" }, { type: "name", text: name }, { type: "contact", text: contact }) }), "people-make")[0]!.props.disabled;
    expect([make("", ""), make("Beam", ""), make("", "beam"), make("Beam", "beam"), make("Beam", "beam@example.com")]).toEqual([true, true, true, false, false]);
  });

  it("makes the link only from a form that is ready, on Enter or on the button, and cancels on Escape", () => {
    const onInvite = vi.fn();
    const dispatch = vi.fn();
    const p = props({ ui: ui({ type: "openInvite" }, { type: "name", text: "Beam" }, { type: "contact", text: "beam" }), onInvite, dispatch });
    const form = byTestId(p, "people-invite-form")[0]!;
    const submit = form.props.onSubmit as (e: { preventDefault(): void }) => void;
    const preventDefault = vi.fn();
    submit({ preventDefault });
    expect([preventDefault.mock.calls.length, onInvite.mock.calls.length]).toEqual([1, 1]);
    // not ready: an Enter in the form sends nothing
    const empty = props({ ui: ui({ type: "openInvite" }), onInvite });
    (byTestId(empty, "people-invite-form")[0]!.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault });
    expect(onInvite).toHaveBeenCalledTimes(1);
    (form.props.onKeyDown as (e: { key: string; preventDefault(): void }) => void)({ key: "Escape", preventDefault });
    expect(dispatch).toHaveBeenCalledWith({ type: "cancel" });
    // typing goes to the page's state
    (byTestId(p, "people-name")[0]!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "Beam B" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "name", text: "Beam B" });
  });

  it("asks about removing a helper in the helper's row, with the canvas's words, and the safe answer holding the focus", () => {
    const p = props({ ui: ui({ type: "askRemove", helper: "helper-mint" }) });
    const html = words(view(p));
    expect(html).toContain(
      "Remove Mint? Mint can no longer sign in to Baan Mali. Requests Mint was looking at go back to you. What Mint approved stays as it was. Manut AI keeps Mint's name with it. Remove Mint Keep Mint",
    );
    // the question stands in the row: the row's own buttons are not drawn beside it
    expect(byTestId(p, "people-helper")).toHaveLength(0);
    const keep = byTestId(p, "people-remove-keep")[0]!;
    expect(keep.props.autoFocus).toBe(true);
    expect(byTestId(p, "people-remove-yes")[0]!.props.autoFocus).toBeUndefined();
    expect(words(view(props({ ui: ui({ type: "askRemove", helper: "helper-mint" }), shop: "" })))).toContain("Mint can no longer sign in to this shop.");
  });

  it("removes only when the owner says so, and Keep and Escape change nothing", () => {
    const onRemove = vi.fn();
    const dispatch = vi.fn();
    const p = props({ ui: ui({ type: "askRemove", helper: "helper-mint" }), onRemove, dispatch });
    (byTestId(p, "people-remove-yes")[0]!.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
    (byTestId(p, "people-remove-keep")[0]!.props.onClick as () => void)();
    expect(dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
    (byTestId(p, "people-remove-question")[0]!.props.onKeyDown as (e: { key: string; preventDefault(): void }) => void)({ key: "Escape", preventDefault: () => {} });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("asks nothing and offers nothing while a change is on its way or a question is open", () => {
    const busy = props({ ui: ui({ type: "begin", at: "who" }) });
    expect([byTestId(busy, "people-remove")[0]!.props.disabled, byTestId(busy, "people-cancel-invite")[0]!.props.disabled, byTestId(busy, "people-invite")[0]!.props.disabled]).toEqual([true, true, true]);
    const asking = props({ ui: ui({ type: "askRemove", helper: "helper-mint" }) });
    expect(byTestId(asking, "people-cancel-invite")[0]!.props.disabled).toBe(true);
    expect(byTestId(asking, "people-invite")[0]!.props.disabled).toBe(true);
    const idle = props();
    expect([byTestId(idle, "people-remove")[0]!.props.disabled, byTestId(idle, "people-cancel-invite")[0]!.props.disabled]).toEqual([false, false]);
  });

  it("draws Copy link for an invite with a link, says so when it has none, and copies exactly that link", () => {
    const onCopy = vi.fn();
    const p = props({ onCopy, state: { kind: "ready", value: people({ invites: [beam, { ...tum, link: null }] }) } });
    const [copy] = byTestId(p, "people-copy");
    (copy!.props.onClick as () => void)();
    expect(onCopy).toHaveBeenCalledWith("inv-beam", "https://dev.manut.xyz/join/token-beam");
    expect(byTestId(p, "people-copy")).toHaveLength(1);
    expect(words(view(p))).toContain("The link could not be read. Cancel this invite and make a new one.");
    // a link just made says it was copied for a moment
    const made = props({ ui: ui({ type: "done", notice: "x", made: "inv-beam" }, { type: "copied", invite: "inv-beam" }) });
    expect(words(renderToString(<PeopleView p={made} />))).toContain("Copied");
  });

  it("keeps each person's colour when the list around them changes, and gives the owner the board's first", () => {
    const colour = (html: string, initial: string) => new RegExp(`background:(#[0-9A-F]{6})[^>]*>${initial}<`).exec(html)?.[1];
    const before = view(props({ state: { kind: "ready", value: people({ helpers: [mint], invites: [beam, tum] }) } }));
    // Mint is removed and Tum's invite cancelled: Beam keeps the colour it had
    const after = view(props({ state: { kind: "ready", value: people({ helpers: [], invites: [beam] }) } }));
    expect(colour(before, "B")).toBeDefined();
    expect(colour(after, "B")).toBe(colour(before, "B"));
    expect(colour(before, "M")).toBe(colour(view(props()), "M"));
    expect(colour(before, "F")).toBe("#EFD3CC");
    for (const id of ["a", "helper-mint", "inv-beam", "x".repeat(300), ""]) {
      expect(toneOf(id), id).toBe(toneOf(id));
      expect(toneOf(id)).toBeGreaterThanOrEqual(0);
      expect(toneOf(id)).toBeLessThan(5);
    }
  });

  it("marks the helper who covers while the cover is in force, and not once it is over", () => {
    const on = props({ state: { kind: "ready", value: people({ away: covering }) } });
    expect(byTestId(on, "people-covering")).toHaveLength(1);
    const over = props({ state: { kind: "ready", value: people({ away: { ...covering, inForce: false } }) } });
    expect(byTestId(over, "people-covering")).toHaveLength(0);
  });
});

describe("while you are away, drawn", () => {
  const away = (state: Partial<ShopPeople>, over: Partial<PeopleProps> = {}) => props({ state: { kind: "ready", value: people(state) }, ...over });

  it("offers one helper and a day, with the canvas's line that money, posts and settings still wait", () => {
    const html = words(view(away({})));
    expect(html).toContain("While you are away Choose one helper to cover messages until a day you choose. Money, public posts and settings still wait for you. Helper who covers Choose a helper Mint Away until Cover lasts to the end of that day. Set cover");
  });

  it("is not ready until a helper and a day that has not passed are chosen, then sets the cover", () => {
    const onCover = vi.fn();
    const set = (helper: string, day: string) => byTestId(away({}, { ui: ui({ type: "coverHelper", helper }, { type: "coverDay", day }), onCover }), "people-cover-set")[0]!.props.disabled;
    expect([set("", ""), set("helper-mint", ""), set("", "2026-11-27"), set("helper-mint", "2026-11-23"), set("helper-mint", "2026-11-27")]).toEqual([true, true, true, true, false]);
    const p = away({}, { ui: ui({ type: "coverHelper", helper: "helper-mint" }, { type: "coverDay", day: "2026-11-27" }), onCover });
    const preventDefault = vi.fn();
    (byTestId(p, "people-cover-form")[0]!.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault });
    expect(onCover).toHaveBeenCalledTimes(1);
    // the date field's earliest day is today, on this computer
    expect(byTestId(p, "people-cover-day")[0]!.props.min).toBe("2026-11-24");
  });

  it("says who covers and offers to end it, while it is in force, with no form beside it", () => {
    const onEndCover = vi.fn();
    const p = away({ away: covering }, { onEndCover });
    expect(words(view(p))).toContain("You are away until Friday 27 November. Mint is covering messages. End cover");
    expect(byTestId(p, "people-cover-form")).toHaveLength(0);
    (byTestId(p, "people-cover-end")[0]!.props.onClick as () => void)();
    expect(onEndCover).toHaveBeenCalledTimes(1);
  });

  it("says the cover is over once its day has passed, and offers the form again", () => {
    const p = away({ away: { ...covering, inForce: false, until: at(11, 20, 23, 59) } });
    const html = words(view(p));
    expect(html).toContain("The cover for Mint ended on Friday 20 November. Nobody is covering now.");
    expect(byTestId(p, "people-cover-end")).toHaveLength(0);
    expect(byTestId(p, "people-cover-form")).toHaveLength(1);
  });

  it("asks for a helper first when there is none to cover", () => {
    const p = away({ helpers: [] });
    expect(words(view(p))).toContain("Invite a helper first. Cover is one of your helpers, until a day you choose.");
    expect(byTestId(p, "people-cover-form")).toHaveLength(0);
  });

  it("shows what the last change said in the part it was made in, and nowhere else", () => {
    const cover = away({}, { ui: ui({ type: "begin", at: "cover" }, { type: "failed", message: "Choose a day that has not passed yet.", close: false }) });
    expect(byTestId(cover, "people-cover-error")).toHaveLength(1);
    expect(byTestId(cover, "people-who-error")).toHaveLength(0);
    const who = away({}, { ui: ui({ type: "begin", at: "who" }, { type: "done", notice: "Mint was removed." }) });
    expect(byTestId(who, "people-who-notice")).toHaveLength(1);
    expect(byTestId(who, "people-cover-notice")).toHaveLength(0);
  });
});

describe("when the list cannot be shown", () => {
  it("says it is reading, and shows no list, no roles and no Invite a helper", () => {
    const html = words(view(props({ state: LOADING })));
    expect(html).toBe("People Reading who can use Manut AI…");
  });

  it("says each refusal in words of its own, and offers Try again only where trying again can help", () => {
    const shown = (code: string, message = "the runtime's words") => view(props({ state: { kind: "unavailable", code, message } }));
    expect(words(shown("owner_only"))).toContain("Only the shop's owner sees and changes who can use Manut AI for it.");
    expect(words(shown("no_shop"))).toContain("No shop is linked to your account yet, so there is nobody to manage here.");
    expect(words(shown("not_found"))).toContain("There is no list of people for this shop.");
    expect(words(shown("offline", "Offline: the Manut AI API cannot be reached."))).toContain("Offline: the Manut AI API cannot be reached. Try again");
    expect(words(shown("unavailable", t("people.err.unavailable")))).toContain("The people list did not answer. Try again. Try again");
    for (const code of ["owner_only", "no_shop", "not_found"]) expect(shown(code), code).not.toContain("people-retry");
    for (const code of ["offline", "unavailable", "signed_out", "unlinked"]) expect(shown(code), code).toContain("people-retry");
    for (const code of ["owner_only", "offline"]) expect(words(shown(code)), code).not.toMatch(/Invite a helper|What each role can do/);
  });

  it("asks again with Try again", () => {
    const onRetry = vi.fn();
    const p = props({ state: { kind: "unavailable", code: "unavailable", message: "x" }, onRetry });
    (byTestId(p, "people-retry")[0]!.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says a shop the person only helps at is its owner's, in the owner's name, and shows nothing else", () => {
    const only = helperShopWords({ name: "Ran Pa Noi", owner: "Noi" });
    expect(only).toBe("Only Noi can see and change who can use Manut AI for Ran Pa Noi. Ask Noi if someone should be added or removed.");
    const p = props({ only, state: LOADING });
    const html = words(view(p));
    expect(html).toBe(`People ${only}`);
    expect(helperShopWords({ name: "", owner: "" })).toContain("this shop");
    // even a list that had been read for another shop is not shown while this one is
    expect(words(view(props({ only })))).toBe(`People ${only}`);
  });
});

describe("where People is offered", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is offered on Practice and Connected, and not on the loopback bridge the Playwright suite uses, which logs what it is sent", () => {
    expect(peopleOffered()).toBe(true);
    vi.stubGlobal("window", { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=e2e" });
    expect(peopleOffered()).toBe(false);
    // a page that asks for its own runtime has People even where the suite's bridge is configured
    vi.stubGlobal("window", { __MANUT_BRIDGE_URL__: async () => "ws://127.0.0.1:1/?token=e2e", __MANUT_IN_PROCESS__: true });
    expect(peopleOffered()).toBe(true);
  });
});

describe("in every language", () => {
  it("draws every state of the page with no key missing and no slot left open", () => {
    const states: PeopleProps[] = [
      props(),
      props({ ui: ui({ type: "openInvite" }, { type: "name", text: "Tum" }, { type: "contact", text: "tum@example.com" }) }),
      props({ ui: ui({ type: "openInvite" }, { type: "contact", text: "beam.line" }) }),
      props({ ui: ui({ type: "askRemove", helper: "helper-mint" }) }),
      props({ ui: ui({ type: "done", notice: "ok", made: "inv-beam" }) }),
      props({ state: { kind: "ready", value: people({ away: covering, invites: [beam, tum, old] }) } }),
      props({ state: { kind: "ready", value: people({ helpers: [], invites: [] }) } }),
      props({ state: { kind: "unavailable", code: "unavailable", message: "x" } }),
      props({ only: helperShopWords({ name: "Ran Pa Noi", owner: "Noi" }) }),
      props({ state: LOADING }),
    ];
    for (const lang of LANGS) {
      setLang(lang);
      for (const [n, p] of states.entries()) {
        const html = words(view(p));
        expect(html, `${lang} state ${n}`).not.toMatch(/\{\w+\}|undefined|\[object/);
        expect(html, `${lang} state ${n}`).toContain(DICT[lang]["set.people"]);
      }
    }
  });

  it("keeps the product's name and the invitee's in the words about who sends the link, in each language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(t("people.form.contactHelp"), lang).toContain("Manut AI");
      expect(t("people.inv.send", { name: "Beam" }), lang).toContain("Beam");
      expect(t("people.inv.send", { name: "Beam" }), lang).toContain("Manut AI");
    }
  });
});
