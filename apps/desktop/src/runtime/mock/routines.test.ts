// The team's routines on the in-process runtime (Practice). The rules are `@manut/routine-rules`': what a routine is, how
// its timing is said, when it runs next and that a routine which replies, sends, pays or deletes always asks first. These
// tests check that the runtime keeps to them through the operations the Customize page calls. The clock is pinned to
// Sunday 22 November 2026, 10:00 in Bangkok, the shop's own time zone, so each next run can be written out as a date.
import { describe, expect, it } from "vitest";
import type { ActionKind, Trigger } from "@manut/routine-rules";
import type { BridgeError } from "../../lib/protocol";
import { MAX_ROUTINES, newRoutineRefusal, type NewRoutine, type RoutineRow } from "../routines";
import { MockHost, MockRuntime } from "./index";
import { ROUTINE_SEED } from "./seed";
import { HELPED_SHOP, OWN_SHOP } from "./shops";

/** Seconds at `h:min` in Bangkok (UTC+7, no daylight saving) on a day of November 2026. */
const bkk = (day: number, h: number, min = 0) => Date.UTC(2026, 10, day, h - 7, min) / 1000;
const NOW = bkk(22, 10);

async function open(now: () => number = () => NOW) {
  const host = new MockHost({ now });
  const rt = new MockRuntime(host);
  await rt.connect();
  const rows = async () => (await rt.request("routine.list", {})).routines;
  const make = async (name: string, action: ActionKind, trigger: Trigger, asksFirst?: boolean) =>
    (await rt.request("routine.create", { shop: OWN_SHOP, name, action, trigger, ...(asksFirst === undefined ? {} : { asksFirst }) })).routine;
  return { rt, host, rows, make };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

describe("the staged routines", () => {
  it("lists the canvas's five, each as its timing and what it does, in the canvas's order", async () => {
    const { rows } = await open();
    expect((await rows()).map((r) => [r.when, r.name])).toEqual([
      ["Every day at 08:00", "Morning brief"],
      ["Every Monday at 08:00", "Weekly growth brief"],
      ["When stock drops under 5", "Tell me and draft a restock order"],
      ["On the last day of the month at 18:00", "Send the books to FlowAccount"],
      ["Every night after 21:00", "Answer order-status questions"],
    ]);
    expect(ROUTINE_SEED).toHaveLength(5);
  });

  it("asks first for the books and the night replies, which reach a service and customers, and for no brief or draft", async () => {
    const { rows } = await open();
    expect((await rows()).map((r) => [r.name, r.action, r.asksFirst])).toEqual([
      ["Morning brief", "brief", false],
      ["Weekly growth brief", "brief", false],
      ["Tell me and draft a restock order", "draft", false],
      ["Send the books to FlowAccount", "send", true],
      ["Answer order-status questions", "reply", true],
    ]);
  });

  it("has every one switched on, with its next run in seconds, and none for stock, which is an event", async () => {
    const { rows } = await open();
    const all = await rows();
    expect(all.every((r) => r.enabled)).toBe(true);
    expect(all.map((r) => r.next)).toEqual([bkk(23, 8), bkk(23, 8), null, bkk(30, 18), bkk(22, 21)]);
    for (const r of all) expect(r.timeZone, r.id).toBe("Asia/Bangkok");
  });

  it("gives every routine its own id and hands out copies, so a caller cannot change what the runtime keeps", async () => {
    const { rows } = await open();
    const first = await rows();
    expect(new Set(first.map((r) => r.id)).size).toBe(5);
    first[0].name = "changed by the caller";
    first.pop();
    expect((await rows())[0].name).toBe("Morning brief");
    expect(await rows()).toHaveLength(5);
  });
});

describe("each kind of routine: how its timing is said and when it runs next", () => {
  // Now is Sunday 22 November 10:00, so a run at exactly 10:00 today is not "next": the next one is strictly later.
  const CASES: { kind: string; trigger: Trigger; when: string; next: number | null }[] = [
    { kind: "daily", trigger: { kind: "daily", at: "09:30" }, when: "Every day at 09:30", next: bkk(23, 9, 30) },
    { kind: "daily, later today", trigger: { kind: "daily", at: "21:15" }, when: "Every day at 21:15", next: bkk(22, 21, 15) },
    { kind: "weekly, one day", trigger: { kind: "weekly", weekdays: [0], at: "10:00" }, when: "Every Sunday at 10:00", next: bkk(29, 10) },
    { kind: "weekly, two days", trigger: { kind: "weekly", weekdays: [4, 1], at: "09:30" }, when: "Every Monday and Thursday at 09:30", next: bkk(23, 9, 30) },
    { kind: "weekly, three days", trigger: { kind: "weekly", weekdays: [1, 3, 5], at: "07:00" }, when: "Every Monday, Wednesday and Friday at 07:00", next: bkk(23, 7) },
    { kind: "weekly, all seven days", trigger: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], at: "06:00" }, when: "Every day at 06:00", next: bkk(23, 6) },
    { kind: "monthly, on a day", trigger: { kind: "monthly", day: 15, at: "09:00" }, when: "On the 15th of each month at 09:00", next: Date.UTC(2026, 11, 15, 2, 0) / 1000 },
    { kind: "monthly, on the 1st", trigger: { kind: "monthly", day: 1, at: "09:00" }, when: "On the 1st of each month at 09:00", next: Date.UTC(2026, 11, 1, 2, 0) / 1000 },
    { kind: "monthly, the last day", trigger: { kind: "monthly", day: "last", at: "18:00" }, when: "On the last day of the month at 18:00", next: bkk(30, 18) },
    { kind: "a window across midnight", trigger: { kind: "window", from: "21:00", to: "08:00" }, when: "Every night after 21:00", next: bkk(22, 21) },
    { kind: "a window within a day", trigger: { kind: "window", from: "09:00", to: "17:00" }, when: "Every day from 09:00 to 17:00", next: bkk(23, 9) },
    { kind: "stock", trigger: { kind: "stockBelow", threshold: 3 }, when: "When stock drops under 3", next: null },
  ];

  for (const c of CASES) {
    it(`${c.kind}: "${c.when}"`, async () => {
      const { make, rows } = await open();
      const made = await make("Draft something", "draft", c.trigger);
      expect(made).toMatchObject({ when: c.when, next: c.next, enabled: true });
      expect((await rows()).at(-1)).toEqual(made);
    });
  }

  it("runs a time in the shop's own zone, not the computer's", async () => {
    const { make } = await open(() => Date.UTC(2026, 10, 22, 20, 0) / 1000); // 03:00 on Monday in Bangkok
    expect((await make("Early", "draft", { kind: "daily", at: "08:00" })).next).toBe(bkk(23, 8));
  });

  it("moves each next run on as the runtime's clock does", async () => {
    let now = NOW;
    const { rows } = await open(() => now);
    now = bkk(23, 8, 30); // Monday, after the morning brief
    const all = await rows();
    expect(all[0].next).toBe(bkk(24, 8));
    expect(all[1].next).toBe(bkk(30, 8));
  });
});

describe("a routine the owner adds", () => {
  it("is built with the package and comes back as the row the list shows, last, switched on, its name trimmed", async () => {
    const { make, rows } = await open();
    const made = await make("  Remind me about parcels  ", "draft", { kind: "daily", at: "15:00" });
    expect(made).toEqual({ id: made.id, name: "Remind me about parcels", when: "Every day at 15:00", action: "draft", asksFirst: false, enabled: true, next: bkk(22, 15), timeZone: "Asia/Bangkok", removable: true });
    expect(await rows()).toHaveLength(6);
    expect((await rows()).at(-1)?.id).toBe(made.id);
    expect(new Set((await rows()).map((r) => r.id)).size).toBe(6);
  });

  it("always asks first when it replies or sends, and shows that without being told to", async () => {
    const { make } = await open();
    expect(await make("Answer parcel questions", "reply", { kind: "daily", at: "09:00" })).toMatchObject({ action: "reply", asksFirst: true });
    expect(await make("Send the weekly post", "send", { kind: "weekly", weekdays: [5], at: "10:00" })).toMatchObject({ action: "send", asksFirst: true });
  });

  it("asks first even for the kinds the page does not offer, because the package forces it", async () => {
    const { make } = await open();
    expect(await make("Pay a supplier", "pay", { kind: "monthly", day: 1, at: "09:00" })).toMatchObject({ asksFirst: true });
    expect(await make("Clear old drafts", "delete", { kind: "monthly", day: 1, at: "09:00" })).toMatchObject({ asksFirst: true });
  });

  it("refuses to let a routine that replies, sends, pays or deletes skip asking, and says why", async () => {
    const { rt, rows } = await open();
    for (const action of ["reply", "send", "pay", "delete"] as const) {
      const err = await refusal(rt.request("routine.create", { shop: OWN_SHOP, name: "Do it quietly", action, trigger: { kind: "daily", at: "09:00" }, asksFirst: false }));
      expect(err, action).toMatchObject({ code: "must_ask_first" });
      expect(err?.message.trim(), action).not.toBe("");
    }
    expect(await rows()).toHaveLength(5);
  });

  it("lets the owner ask first for a brief or a draft, which would otherwise run on their own", async () => {
    const { make } = await open();
    expect(await make("Brief me, but ask", "brief", { kind: "daily", at: "07:00" }, true)).toMatchObject({ asksFirst: true });
    expect(await make("Brief me", "brief", { kind: "daily", at: "07:30" }, false)).toMatchObject({ asksFirst: false });
  });

  it("refuses what the package refuses, each with its own code, and adds nothing", async () => {
    const { rt, rows } = await open();
    const daily: Trigger = { kind: "daily", at: "09:00" };
    const cases: [string, Record<string, unknown>, string][] = [
      ["a blank name", { name: "   ", action: "draft", trigger: daily }, "invalid_name"],
      ["an 81 character name", { name: "x".repeat(81), action: "draft", trigger: daily }, "invalid_name"],
      ["an action it does not know", { name: "Juggle", action: "juggle", trigger: daily }, "invalid_action"],
      ["a time not written HH:MM", { name: "Early", action: "draft", trigger: { kind: "daily", at: "8:00" } }, "invalid_time"],
      ["no days of the week", { name: "Weekly", action: "draft", trigger: { kind: "weekly", weekdays: [], at: "09:00" } }, "invalid_weekdays"],
      ["a day of the week past Saturday", { name: "Weekly", action: "draft", trigger: { kind: "weekly", weekdays: [7], at: "09:00" } }, "invalid_weekdays"],
      ["the 29th of the month", { name: "Monthly", action: "draft", trigger: { kind: "monthly", day: 29, at: "09:00" } }, "invalid_day"],
      ["a window that starts where it ends", { name: "Window", action: "draft", trigger: { kind: "window", from: "09:00", to: "09:00" } }, "invalid_window"],
      ["a stock number of 0", { name: "Stock", action: "draft", trigger: { kind: "stockBelow", threshold: 0 } }, "invalid_threshold"],
      ["a stock number that is not whole", { name: "Stock", action: "draft", trigger: { kind: "stockBelow", threshold: 2.5 } }, "invalid_threshold"],
      ["a kind of timing it does not know", { name: "Yearly", action: "draft", trigger: { kind: "yearly" } }, "invalid_trigger"],
      ["no timing at all", { name: "Never", action: "draft" }, "invalid_trigger"],
    ];
    for (const [what, params, code] of cases) {
      const err = await refusal(rt.request("routine.create", { shop: OWN_SHOP, ...params } as never));
      expect(err, what).toMatchObject({ code });
      expect(err?.message.trim(), what).not.toBe("");
    }
    expect(await rows()).toHaveLength(5);
  });

  it("counts characters, not bytes: an 80 letter Thai name fits and an 81 letter one does not", async () => {
    const { make, rt } = await open();
    await make("ก".repeat(80), "draft", { kind: "daily", at: "09:00" });
    expect(await refusal(rt.request("routine.create", { shop: OWN_SHOP, name: "ข".repeat(81), action: "draft", trigger: { kind: "daily", at: "09:00" } }))).toMatchObject({ code: "invalid_name" });
  });
});

describe("Pause and Resume a routine", () => {
  it("pauses one: it is switched off and has no next run, and says the same when asked again", async () => {
    const { rt, rows } = await open();
    const paused = (await rt.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" })).routine;
    expect(paused).toMatchObject({ id: "morning-brief", enabled: false, next: null, when: "Every day at 08:00", name: "Morning brief" });
    expect((await rows())[0]).toEqual(paused);
    expect((await rt.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" })).routine).toEqual(paused);
    // the others carry on
    expect((await rows()).slice(1).every((r) => r.enabled)).toBe(true);
  });

  it("resumes it: switched on again, with the next run it would have had", async () => {
    const { rt, rows } = await open();
    const before = (await rows())[3];
    await rt.request("routine.pause", { shop: OWN_SHOP, routine: before.id });
    const resumed = (await rt.request("routine.resume", { shop: OWN_SHOP, routine: before.id })).routine;
    expect(resumed).toEqual(before);
    expect((await rows())[3]).toEqual(before);
    expect((await rt.request("routine.resume", { shop: OWN_SHOP, routine: before.id })).routine).toEqual(before);
  });

  it("works out the next run from the time it is resumed, not from when it was paused", async () => {
    let now = NOW;
    const { rt } = await open(() => now);
    await rt.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" });
    now = bkk(25, 12); // Wednesday noon
    expect((await rt.request("routine.resume", { shop: OWN_SHOP, routine: "morning-brief" })).routine.next).toBe(bkk(26, 8));
  });

  it("keeps an event's routine without a next run whether it is on or off", async () => {
    const { rt } = await open();
    expect((await rt.request("routine.pause", { shop: OWN_SHOP, routine: "restock-alert" })).routine).toMatchObject({ enabled: false, next: null });
    expect((await rt.request("routine.resume", { shop: OWN_SHOP, routine: "restock-alert" })).routine).toMatchObject({ enabled: true, next: null });
  });

  it("pauses and resumes a routine the owner added", async () => {
    const { rt, make } = await open();
    const made = await make("Remind me about parcels", "draft", { kind: "daily", at: "15:00" });
    expect((await rt.request("routine.pause", { shop: OWN_SHOP, routine: made.id })).routine.enabled).toBe(false);
    expect((await rt.request("routine.resume", { shop: OWN_SHOP, routine: made.id })).routine).toEqual(made);
  });

  it("refuses a routine it does not have, and a request that names none", async () => {
    const { rt } = await open();
    for (const op of ["routine.pause", "routine.resume"] as const) {
      expect(await refusal(rt.request(op, { shop: OWN_SHOP, routine: "no-such-routine" })), op).toMatchObject({ code: "not_found" });
      expect(await refusal(rt.request(op, { shop: OWN_SHOP } as { shop: string; routine: string })), op).toMatchObject({ code: "bad_request" });
    }
  });
});

describe("what Pause everyone says about routines", () => {
  const waiting = async (rt: MockRuntime) => (await rt.request("team.state", {})).routines;

  it("counts the routines that are on, so a routine the owner switches off or adds changes it", async () => {
    const { rt, make } = await open();
    expect(await waiting(rt)).toBe(5);
    await rt.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" });
    expect(await waiting(rt)).toBe(4);
    await make("Remind me about parcels", "draft", { kind: "daily", at: "15:00" });
    expect(await waiting(rt)).toBe(5);
    await rt.request("routine.resume", { shop: OWN_SHOP, routine: "morning-brief" });
    expect(await waiting(rt)).toBe(6);
  });

  it("does not stop the owner changing a routine while the team is paused: nothing runs, so nothing is lost", async () => {
    const { rt } = await open();
    await rt.request("team.pause", {});
    expect((await rt.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" })).routine.enabled).toBe(false);
    expect((await rt.request("routine.resume", { shop: OWN_SHOP, routine: "morning-brief" })).routine.enabled).toBe(true);
  });
});

describe("the routines of a runtime that starts again", () => {
  it("go back to the staged five, with what the owner added gone and what they switched off back on", async () => {
    const { rt, host, make, rows } = await open();
    const first = await rows();
    await make("Remind me about parcels", "draft", { kind: "daily", at: "15:00" });
    await rt.request("routine.pause", { shop: OWN_SHOP, routine: "monthly-books" });
    host.reset();
    expect(await rows()).toEqual(first);
  });

  it("are shared by every client of the host, as the shop's routines are", async () => {
    const host = new MockHost({ now: () => NOW });
    const one = new MockRuntime(host);
    const two = new MockRuntime(host);
    await one.connect();
    await two.connect();
    await one.request("routine.pause", { shop: OWN_SHOP, routine: "morning-brief" });
    expect((await two.request("routine.list", {})).routines.find((r: RoutineRow) => r.id === "morning-brief")?.enabled).toBe(false);
  });
});

describe("removing a routine", () => {
  it("takes the routine away, answers which one went, and holds none of it", async () => {
    const { rt, rows } = await open();
    const before = await rows();
    const answer = await rt.request("routine.remove", { shop: OWN_SHOP, routine: "weekly-growth-brief" });
    expect(answer).toEqual({ routine: "weekly-growth-brief" });
    expect((await rows()).map((r) => r.id)).toEqual(before.filter((r) => r.id !== "weekly-growth-brief").map((r) => r.id));
    // it is gone for good: it cannot be paused, resumed or removed again
    for (const op of ["routine.pause", "routine.resume", "routine.remove"] as const)
      expect(await refusal(rt.request(op, { shop: OWN_SHOP, routine: "weekly-growth-brief" })), op).toMatchObject({ code: "not_found" });
  });

  it("says every routine of the team can be removed", async () => {
    const { rows } = await open();
    expect((await rows()).every((r) => r.removable)).toBe(true);
  });

  it("stops counting a routine it removed in what Pause everyone would hold", async () => {
    const { rt } = await open();
    expect((await rt.request("team.state", {})).routines).toBe(5);
    await rt.request("routine.remove", { shop: OWN_SHOP, routine: "morning-brief" });
    expect((await rt.request("team.state", {})).routines).toBe(4);
  });

  it("refuses a routine it does not have, and a request that names none", async () => {
    const { rt, rows } = await open();
    const before = await rows();
    expect(await refusal(rt.request("routine.remove", { shop: OWN_SHOP, routine: "no-such-routine" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(rt.request("routine.remove", { shop: OWN_SHOP } as { shop: string; routine: string }))).toMatchObject({ code: "bad_request" });
    expect(await rows()).toEqual(before);
  });
});

describe("a shop's own team", () => {
  const make = { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } } as const;

  it("lists the routines for the shop the person is viewing, and names it", async () => {
    const { rt } = await open();
    expect((await rt.request("routine.list", {})).shop).toBe(OWN_SHOP);
  });

  it("refuses every change at a shop the person only helps at, as the API refuses a helper, and changes nothing", async () => {
    const { rt, rows } = await open();
    const before = await rows();
    const asked = [
      rt.request("routine.create", { shop: HELPED_SHOP, ...make }),
      rt.request("routine.pause", { shop: HELPED_SHOP, routine: "morning-brief" }),
      rt.request("routine.resume", { shop: HELPED_SHOP, routine: "morning-brief" }),
      rt.request("routine.remove", { shop: HELPED_SHOP, routine: "morning-brief" }),
    ];
    for (const out of await Promise.all(asked.map(refusal))) expect(out).toMatchObject({ code: "owner_only" });
    expect(await rows()).toEqual(before);
  });

  it("refuses to show a shop the person only helps at: it is its owner's", async () => {
    const { rt } = await open();
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    expect(await refusal(rt.request("routine.list", {}))).toMatchObject({ code: "owner_only" });
  });

  it("refuses a shop that is not the person's, and a request that names none, without making anything", async () => {
    const { rt, rows } = await open();
    const before = await rows();
    for (const shop of ["practice:someone-elses", null] as const) {
      expect(await refusal(rt.request("routine.create", { shop, ...make })), String(shop)).toMatchObject({ code: "not_found" });
      expect(await refusal(rt.request("routine.remove", { shop, routine: "morning-brief" })), String(shop)).toMatchObject({ code: "not_found" });
    }
    expect(await rows()).toEqual(before);
  });

  it("answers for a shop the person made here with the demo team, as every page shows it", async () => {
    const { rt } = await open();
    const { shop } = await rt.request("shops.make", { name: "Baan Fon", ownerName: "Fon", template: null });
    expect((await rt.request("routine.list", {})).shop).toBe(shop.id);
    const made = (await rt.request("routine.create", { shop: shop.id, ...make })).routine;
    expect((await rt.request("routine.remove", { shop: shop.id, routine: made.id })).routine).toBe(made.id);
  });
});

describe("what the team keeps", () => {
  it("keeps at most the 50 routines the API keeps, and refuses the next as `full` until one is removed", async () => {
    const { rt, make, rows } = await open();
    for (let i = (await rows()).length; i < MAX_ROUTINES; i += 1) await make(`Routine number ${i}`, "brief", { kind: "daily", at: "08:00" });
    expect(await rows()).toHaveLength(MAX_ROUTINES);
    expect(await refusal(rt.request("routine.create", { shop: OWN_SHOP, name: "One too many", action: "brief", trigger: { kind: "daily", at: "08:00" } }))).toMatchObject({ code: "full" });
    expect(await rows()).toHaveLength(MAX_ROUTINES);
    await rt.request("routine.remove", { shop: OWN_SHOP, routine: (await rows())[0].id });
    await make("One more", "brief", { kind: "daily", at: "08:00" });
    expect(await rows()).toHaveLength(MAX_ROUTINES);
  });

  it("says the shape a routine has before it is made by the rule the connected runtime sends nothing for", async () => {
    const { rt, rows } = await open();
    const before = await rows();
    const cases: [string, Parameters<typeof newRoutineRefusal>[0]][] = [
      ["invalid_name", { name: "  ", action: "brief", trigger: { kind: "daily", at: "08:00" } }],
      ["invalid_action", { name: "x", action: "juggle", trigger: { kind: "daily", at: "08:00" } }],
      ["invalid_time", { name: "x", action: "brief", trigger: { kind: "daily", at: "8am" } }],
      ["invalid_weekdays", { name: "x", action: "brief", trigger: { kind: "weekly", weekdays: [], at: "08:00" } }],
      ["invalid_day", { name: "x", action: "brief", trigger: { kind: "monthly", day: 29, at: "08:00" } }],
      ["invalid_window", { name: "x", action: "brief", trigger: { kind: "window", from: "08:00", to: "08:00" } }],
      ["invalid_threshold", { name: "x", action: "brief", trigger: { kind: "stockBelow", threshold: 0 } }],
      ["invalid_trigger", { name: "x", action: "brief", trigger: { kind: "hourly" } }],
      ["must_ask_first", { name: "x", action: "pay", trigger: { kind: "daily", at: "08:00" }, asksFirst: false }],
      // the API's own: whether to ask first is true or false, and nothing else
      ["invalid_request", { name: "x", action: "brief", trigger: { kind: "daily", at: "08:00" }, asksFirst: "no" }],
    ];
    for (const [code, params] of cases) {
      expect(newRoutineRefusal(params), code).toBe(code);
      expect(await refusal(rt.request("routine.create", { shop: OWN_SHOP, ...params } as never)), code).toMatchObject({ code });
    }
    // and what the rule takes, Practice makes
    const takes: NewRoutine[] = [
      { name: "x", action: "brief", trigger: { kind: "daily", at: "08:00" } },
      { name: "x", action: "send", trigger: { kind: "weekly", weekdays: [1, 3], at: "08:00" } },
      { name: "x", action: "reply", trigger: { kind: "monthly", day: "last", at: "08:00" } },
      { name: "x", action: "draft", trigger: { kind: "window", from: "21:00", to: "08:00" } },
      { name: "x", action: "brief", trigger: { kind: "stockBelow", threshold: 3 } },
    ];
    for (const params of takes) {
      expect(newRoutineRefusal(params), JSON.stringify(params)).toBeNull();
      await rt.request("routine.create", { shop: OWN_SHOP, ...params });
    }
    expect(await rows()).toHaveLength(before.length + 5);
  });
});
