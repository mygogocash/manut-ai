// What the connected runtime says to the Customize page's ops. What the team knows is "not yet": the API serves a shop's
// memory to operators only (admin routes), and no session can read or change it. The routines are the shop's schedules as
// the runtime already reads them, shown and never changed. Nothing but reads ever reaches the API, and none of the memory
// ops or the routine writes reaches it at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import type { RoutineRow } from "../routines";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, iso, memoryVault, ORIGIN, scheduleJson, serveShop, storedSession, T0 } from "./testkit";

const NOW = T0 + 600_000;

async function connected(schedules?: unknown[]) {
  const api = fakeApi();
  serveShop(api, schedules ? { schedules } : {});
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), deviceId: () => "device-2" });
  const rt = new HttpRuntime(new HttpHost({ session }));
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params: unknown) => Promise<unknown>;
  return { api, rt, req };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what the team knows on the connected runtime", () => {
  it("cannot be shown yet, and says so in words that fit a read", async () => {
    const { req } = await connected();
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "not_yet", message: t("rt.notYetShow") });
    // a read's refusal is not the write's: it must not say that Connected only reads
    expect(t("rt.notYetShow")).not.toMatch(/only reads/);
  });

  it("cannot be changed yet, and says so as every other write does", async () => {
    const { req } = await connected();
    for (const [op, params] of [
      ["memory.remember", { text: "We ship on weekdays" }],
      ["memory.confirm", { fact: "f5" }],
      ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { fact: "f1" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "not_yet", message: t("rt.notYet") });
  });

  it("sends nothing to the API for any of them, so nothing the owner typed leaves the computer", async () => {
    const { api, req } = await connected();
    const sent = api.calls.length;
    for (const [op, params] of [
      ["memory.list", {}],
      ["memory.remember", { text: "We ship on weekdays" }],
      ["memory.confirm", { fact: "f5" }],
      ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { fact: "f1" }],
    ] as const)
      await refusal(req(op, params));
    expect(api.calls).toHaveLength(sent);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says the same in every language it is shown in", () => {
    for (const l of LANGS) for (const k of ["rt.notYet", "rt.notYetShow"] as const) expect(t(k, undefined, l).trim(), `${l} ${k}`).not.toBe("");
  });
});

describe("the team's routines on the connected runtime", () => {
  const routines = async (schedules?: unknown[]) => {
    const c = await connected(schedules);
    return { ...c, list: ((await c.req("routine.list", {})) as { routines: RoutineRow[] }).routines };
  };

  it("lists the shop's schedules as routines, each with its timing in words and its next run exact", async () => {
    const { list } = await routines();
    expect(list).toEqual([
      {
        id: "sched-1",
        name: "Morning brief",
        // the API counts Sunday as 1, so 2 to 6 are Monday to Friday
        when: "Every Monday, Tuesday, Wednesday, Thursday and Friday at 08:30",
        action: null,
        asksFirst: null,
        enabled: true,
        next: (T0 + 3600_000) / 1000,
        timeZone: "Asia/Bangkok",
      },
    ]);
  });

  it("says nothing about what a schedule does or whether it asks first, because the API does not say", async () => {
    const { list } = await routines();
    // null is "the runtime does not know": the page then shows no "Asks first", and no claim that it does not ask
    for (const r of list) expect([r.action, r.asksFirst]).toEqual([null, null]);
  });

  it("says a schedule that runs on all seven days runs every day", async () => {
    const { list } = await routines([scheduleJson({ weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 5 })]);
    expect(list[0].when).toBe("Every day at 07:05");
  });

  it("says a Sunday schedule is Sunday: the API's 1 is the package's 0", async () => {
    const { list } = await routines([scheduleJson({ weekdays: [1], hour: 18, minute: 0 })]);
    expect(list[0].when).toBe("Every Sunday at 18:00");
  });

  it("shows a schedule that is switched off as off, with no next run even when the API still names one", async () => {
    const { list } = await routines([scheduleJson({ enabled: false, nextFire: T0 + 7200_000 })]);
    expect(list[0]).toMatchObject({ enabled: false, next: null });
  });

  it("says so, in words of its own, when a schedule has no time it can use", async () => {
    const { list } = await routines([scheduleJson({ hour: null, minute: null, nextFire: null })]);
    expect(list[0].when).toBe(t("rt.whenUnknown"));
    expect(list[0].next).toBeNull();
  });

  it("names a schedule that has no name", async () => {
    const { list } = await routines([scheduleJson({ name: "" })]);
    expect(list[0].name).toBe(t("rt.untitled"));
  });

  it("keeps every schedule the API sent, in the order it sent them", async () => {
    const { list } = await routines([scheduleJson({ id: "a", name: "First" }), scheduleJson({ id: "b", name: "Second", weekdays: [3] }), scheduleJson({ id: "c", name: "Third", enabled: false })]);
    expect(list.map((r) => [r.id, r.name, r.enabled])).toEqual([
      ["a", "First", true],
      ["b", "Second", true],
      ["c", "Third", false],
    ]);
  });

  it("lists none when the shop has no schedules", async () => {
    const { list } = await routines([]);
    expect(list).toEqual([]);
  });

  it("reads the time in the schedule's own zone and counts its next run in seconds", async () => {
    const { list } = await routines([scheduleJson({ timeZone: "Europe/London", nextFire: Date.parse(iso(T0 + 86_400_000)) })]);
    expect(list[0]).toMatchObject({ timeZone: "Europe/London", next: (T0 + 86_400_000) / 1000 });
  });

  it("cannot add, pause or resume a routine yet, and says so as every other write does", async () => {
    const { req } = await connected();
    for (const [op, params] of [
      ["routine.create", { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } }],
      ["routine.pause", { routine: "sched-1" }],
      ["routine.resume", { routine: "sched-1" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "not_yet", message: t("rt.notYet") });
  });

  it("sends nothing to the API for a write, so a schedule is never changed from here", async () => {
    const { api, req } = await connected();
    await req("routine.list", {});
    const sent = api.calls.length;
    for (const [op, params] of [
      ["routine.create", { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } }],
      ["routine.pause", { routine: "sched-1" }],
      ["routine.resume", { routine: "sched-1" }],
    ] as const)
      await refusal(req(op, params));
    expect(api.calls).toHaveLength(sent);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says the words it adds in every language it is shown in", () => {
    for (const l of LANGS) expect(t("rt.whenUnknown", undefined, l).trim(), l).not.toBe("");
  });
});
