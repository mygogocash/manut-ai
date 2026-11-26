// Making and removing the team's routines on the connected runtime (docs/runtime-adapter.md, "A shop the person owns"; the routes are
// docs/pilot-api.md, "Routines"): `POST /v1/routines` and `POST /v1/routines/remove` with the shop's own owner session. A fake of the API
// answers as apps/api does, through `@manut/routine-rules` itself. Each is checked for the request it sends, every refusal it can get and
// the words each is said in, a shop the person only helps at, the shop the change names, while only a kept read is shown, and a change
// that got no answer, which is never sent again. What the New routine form offers is checked against what the API accepts, since the
// owner must be offered nothing the API refuses.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import apiRoutineSetup from "../../../../api/src/routine-setup.ts?raw";
import { LANGS, setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { FORM_ACTIONS, FORM_START, FORM_WHENS, formParams, type RoutineForm } from "../../pages/routines";
import { createStore } from "../../state/store";
import { MAX_ROUTINES } from "../routines";
import { ShopCache } from "./cache";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, iso, memoryCacheStore, memoryVault, ORIGIN, routineJson, serveShop, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, T0, type FakeApi, type ShopWorkJson } from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
const SHOP_C = { id: "pilot:shop-c", name: "Baan Suk", ownerName: "Fon", role: "owner" as const };
const OWNER_C = shopToken(SHOP_C.id, "owner");

/** Baan Mali's team: Ton's morning brief, switched on, and the books on the last day of the month, switched off. */
const TEAM = (): Partial<ShopWorkJson> => ({
  routines: [
    routineJson(),
    routineJson({ id: "rt-0003-books", name: "The books", action: "send", asksFirst: true, member: "ton", trigger: { kind: "monthly", day: "last", at: "18:00" }, when: "On the last day of the month at 18:00", paused: true, next: null }),
  ],
  schedules: [{ id: "sched-own", tenant: SHOP_A.id, roleId: "buddy", name: "Stock check", prompt: "Count the candles", hour: 18, minute: 0, weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "Asia/Bangkok", funding: "managedAI", enabled: true, hasSchedulingConsent: true, revision: 1, nextFire: NOW + 3600_000, createdAt: iso(T0) }],
});

async function opened(list = [SHOP_A, SHOP_B], more: Record<string, Partial<ShopWorkJson>> = {}) {
  const api = fakeApi();
  const shops = serveShops(api, list, {}, () => NOW, { [SHOP_A.id]: TEAM(), ...more });
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
  return { api, shops, disk, host, rt, req };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
/** Every request that is not a GET, apart from opening a shop: what the owner's changes sent. */
const sent = (api: FakeApi) => api.calls.filter((c) => c.method !== "GET" && c.path !== "/v1/shops/session").map((c) => [c.method, c.path, c.bearer, c.body]);
const daily = { kind: "daily", at: "15:00" } as const;
const make = (over: Record<string, unknown> = {}) => ({ shop: SHOP_A.id, name: "Remind me about parcels", action: "draft", trigger: daily, ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("making a routine", () => {
  it("sends POST /v1/routines with exactly { name, action, trigger } and the shop's own session, and no time zone, member or shop", async () => {
    const { api, req } = await opened();
    const before = sent(api).length;
    const { routine } = await req("routine.create", make({ name: "  Remind me about parcels  " }));
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/routines", OWNER_A, { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } }]]);
    // the answer is the routine as the API made it, switched on, with its timing in the API's words and its next run exact
    expect(routine).toMatchObject({ name: "Remind me about parcels", when: "Every day at 15:00", action: "draft", asksFirst: false, enabled: true, timeZone: "Asia/Bangkok", removable: true });
    expect(routine.id).toMatch(/^rt-/);
    expect(routine.next).toBeGreaterThan(NOW / 1000);
  });

  it("sends whether to ask first only when it is said, and a reply or a send that does not say asks first", async () => {
    const { api, req } = await opened();
    const reply = (await req("routine.create", make({ name: "Answer questions", action: "reply" }))).routine;
    expect(reply).toMatchObject({ action: "reply", asksFirst: true });
    expect(sent(api).at(-1)![3]).not.toHaveProperty("asksFirst");
    const quiet = (await req("routine.create", make({ name: "Brief that asks", action: "brief", asksFirst: true }))).routine;
    expect(quiet.asksFirst).toBe(true);
    expect(sent(api).at(-1)![3]).toEqual({ name: "Brief that asks", action: "brief", trigger: daily, asksFirst: true });
  });

  it("sends the timing with only the fields of its kind", async () => {
    const { api, req } = await opened();
    await req("routine.create", make({ trigger: { kind: "weekly", weekdays: [1, 4], at: "09:30", extra: "x" } }));
    expect(sent(api).at(-1)![3]).toMatchObject({ trigger: { kind: "weekly", weekdays: [1, 4], at: "09:30" } });
    expect(JSON.stringify(sent(api).at(-1)![3])).not.toContain("extra");
  });

  it("lists it at once, last and switched on, reads the shop again, and has it among the team's routines the API holds", async () => {
    const { api, shops, req } = await opened();
    const reads = api.to("GET", "/v1/routines").length;
    const { routine } = await req("routine.create", make());
    const listed = await req("routine.list", {});
    expect(listed.shop).toBe(SHOP_A.id);
    expect(listed.routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief", "rt-0003-books", routine.id, "sched-own"]);
    await vi.advanceTimersByTimeAsync(5);
    expect(api.to("GET", "/v1/routines").length).toBeGreaterThan(reads);
    expect(shops.work[SHOP_A.id].routines.map((r) => r.id)).toContain(routine.id);
    expect((await req("routine.list", {})).routines.find((r: { id: string }) => r.id === routine.id)).toMatchObject({ enabled: true });
  });

  it("tells the screens the routines changed, and the team's own members' Schedule tabs list it", async () => {
    const { rt, req } = await opened();
    const heard: string[] = [];
    rt.on("routines.update", () => heard.push("routines.update"));
    const { routine } = await req("routine.create", make({ name: "Remind me about parcels" }));
    await vi.advanceTimersByTimeAsync(5);
    expect(heard).toContain("routines.update");
    expect((await req("routines.list", { bot: "ton" })).routines.map((r: { id: string }) => r.id)).toContain(routine.id);
  });

  it("works through the app's own store: the list names the shop, and the change names it back", async () => {
    const { rt } = await opened();
    const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
    await store.actions.init();
    const { shop } = await store.actions.routineList();
    const { routine } = await store.actions.routineCreate(shop, { name: "Remind me about parcels", action: "draft", trigger: daily });
    expect(routine.name).toBe("Remind me about parcels");
    expect(await store.actions.routineRemove(shop, routine.id)).toEqual({ routine: routine.id });
  });
});

describe("what the form offers is what the API accepts", () => {
  /** A form that says each kind of time with the fields it uses, and every kind of work. */
  const filled = (over: Partial<RoutineForm>): RoutineForm => ({ ...FORM_START, weekdays: [1, 4], name: "Do the thing", ...over });

  it("is taken by the API whole: every kind of work the form offers, at every kind of time it offers, with the member the API chooses", async () => {
    const { api, req } = await opened();
    let made = 0;
    for (const action of FORM_ACTIONS) {
      for (const when of FORM_WHENS) {
        const params = formParams(filled({ action, when }));
        const { routine } = await req("routine.create", { shop: SHOP_A.id, ...params });
        made += 1;
        expect(routine, `${action} ${when}`).toMatchObject({ name: "Do the thing", action, enabled: true });
        // a routine that replies or sends asks first, as the form says before it is added; a brief or a draft does not
        expect(routine.asksFirst, `${action} ${when}`).toBe(action === "reply" || action === "send");
        // the body was exactly what the form builds, plus nothing
        expect(Object.keys(sent(api).at(-1)![3] as object).sort(), `${action} ${when}`).toEqual(["action", "name", "trigger"]);
        // keep the team under its limit while every one is tried
        if (made % 10 === 0) for (const r of (await req("routine.list", {})).routines) if (r.id.startsWith("rt-made-")) await req("routine.remove", { shop: SHOP_A.id, routine: r.id });
      }
    }
    expect(made).toBe(FORM_ACTIONS.length * FORM_WHENS.length);
  });

  it("offers kinds of work the API gives to a member who does them, whoever it chooses by default", () => {
    // apps/api/src/routine-setup.ts: Nam drafts replies; Pim drafts posts; Ton drafts the owner's briefs, the books, and anything that pays or deletes.
    const work = (member: string) => new RegExp(`${member}: \\[([^\\]]*)\\]`).exec(apiRoutineSetup)?.[1]?.split(",").map((a) => a.trim().replace(/"/g, ""));
    expect(work("nam")).toEqual(["reply"]);
    expect(work("pim")).toEqual(["draft", "send"]);
    expect(work("ton")).toEqual(["brief", "draft", "send", "pay", "delete"]);
    // with no member given, Nam does a reply and Ton the rest, so each kind the form offers has a member who does it
    expect(apiRoutineSetup).toMatch(/defaultMember\(action: ActionKind\): WorkerMember \{\s*return action === "reply" \? "nam" : "ton";/);
    for (const action of FORM_ACTIONS) expect(work(action === "reply" ? "nam" : "ton"), action).toContain(action);
  });

  it("says plainly, in the form, what a stock routine does while there is no stock feed, which the API still says it has none of", () => {
    // The API takes a stock routine and gives it no clock: it waits for a feed that does not exist (`waitsFor: "stock_feed"`).
    // When that stops being said, the form's note under the stock number is wrong, and this fails to say it must go.
    expect(apiRoutineSetup).toMatch(/routine\.trigger\.kind === "stockBelow" \? \{ waitsFor: "stock_feed" as const \}/);
    expect(t("routines.form.stockNote")).toMatch(/not connected yet/);
  });

  it("makes a stock routine the API holds as waiting, never running, with no next run", async () => {
    const { req } = await opened();
    const { routine } = await req("routine.create", { shop: SHOP_A.id, ...formParams(filled({ when: "stock", action: "brief" })) });
    expect(routine).toMatchObject({ when: "When stock drops under 5", enabled: true, next: null });
  });
});

describe("a new routine's shape, checked before anything is sent", () => {
  const refused: [string, Record<string, unknown>][] = [
    ["invalid_name", { name: "   " }],
    ["invalid_name", { name: "x".repeat(81) }],
    ["invalid_action", { action: "juggle" }],
    ["invalid_trigger", { trigger: { kind: "hourly" } }],
    ["invalid_trigger", { trigger: null }],
    ["invalid_time", { trigger: { kind: "daily", at: "8:00" } }],
    ["invalid_weekdays", { trigger: { kind: "weekly", weekdays: [], at: "08:00" } }],
    ["invalid_day", { trigger: { kind: "monthly", day: 29, at: "08:00" } }],
    ["invalid_window", { trigger: { kind: "window", from: "08:00", to: "08:00" } }],
    ["invalid_threshold", { trigger: { kind: "stockBelow", threshold: 0 } }],
    ["must_ask_first", { action: "reply", asksFirst: false }],
    ["must_ask_first", { action: "pay", asksFirst: false }],
    ["invalid_request", { asksFirst: "no" }],
  ];

  it.each(refused)("refuses %s with nothing sent, and says it in words", async (code, over) => {
    const { api, req } = await opened();
    const before = api.calls.length;
    const out = await refusal(req("routine.create", make(over)));
    expect(out?.code).toBe(code);
    expect(out?.message.trim()).not.toBe("");
    expect(api.calls).toHaveLength(before);
  });

  it("says each of those in the form's own words, and a call that went wrong in general ones", async () => {
    const { req } = await opened();
    const words = async (over: Record<string, unknown>) => (await refusal(req("routine.create", make(over))))?.message;
    expect(await words({ name: " " })).toBe(t("routines.problem.name"));
    expect(await words({ trigger: { kind: "weekly", weekdays: [], at: "08:00" } })).toBe(t("routines.problem.weekdays"));
    expect(await words({ trigger: { kind: "daily", at: "8" } })).toBe(t("routines.problem.time"));
    expect(await words({ trigger: { kind: "monthly", day: 31, at: "08:00" } })).toBe(t("routines.problem.day"));
    expect(await words({ trigger: { kind: "window", from: "09:00", to: "09:00" } })).toBe(t("routines.problem.window"));
    expect(await words({ trigger: { kind: "stockBelow", threshold: -1 } })).toBe(t("routines.problem.threshold"));
    expect(await words({ action: "reply", asksFirst: false })).toBe(t("routines.problem.mustAsk"));
    expect(await words({ action: "juggle" })).toBe(t("routines.problem.action"));
    expect(await words({ trigger: { kind: "hourly" } })).toBe(t("routines.problem.trigger"));
    expect(await words({ asksFirst: 1 })).toBe(t("rt.change.refused"));
  });
});

describe("a shop's own team", () => {
  it("names the shop each change is for, and sends it with that shop's session although the switcher shows another by now", async () => {
    const { api, shops, req } = await opened([SHOP_A, SHOP_B, SHOP_C], { [SHOP_C.id]: { routines: [routineJson({ id: "rt-c-0001", name: "Baan Suk brief" })] } });
    const listedForA = await req("routine.list", {});
    await req("shops.switch", { shop: SHOP_C.id });
    const { routine } = await req("routine.create", make({ shop: listedForA.shop }));
    expect(sent(api).at(-1)).toEqual(["POST", "/v1/routines", OWNER_A, { name: "Remind me about parcels", action: "draft", trigger: daily }]);
    expect(shops.work[SHOP_A.id].routines.map((r) => r.id)).toContain(routine.id);
    // Baan Suk, which is what the person is looking at, is as it was, and no request carried its session
    expect(shops.work[SHOP_C.id].routines.map((r) => r.id)).toEqual(["rt-c-0001"]);
    expect((await req("routine.list", {})).routines.map((r: { id: string }) => r.id)).toEqual(["rt-c-0001"]);
    expect(api.to("POST", "/v1/routines").every((c) => c.bearer !== OWNER_C)).toBe(true);
    // and the same for a removal
    await req("routine.remove", { shop: listedForA.shop, routine: routine.id });
    expect(sent(api).at(-1)).toEqual(["POST", "/v1/routines/remove", OWNER_A, { routineId: routine.id }]);
    expect((await req("routine.list", {})).routines.map((r: { id: string }) => r.id)).toEqual(["rt-c-0001"]);
  });

  it("refuses a shop the person only helps at, owner_only, with nothing sent and the owner's name in the words", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    const words = t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" });
    expect(await refusal(req("routine.create", make({ shop: SHOP_B.id })))).toEqual({ code: "owner_only", message: words });
    expect(await refusal(req("routine.remove", { shop: SHOP_B.id, routine: "rt-0001-brief" }))).toEqual({ code: "owner_only", message: words });
    expect(api.calls).toHaveLength(before);
    expect(JSON.stringify(api.calls)).not.toContain("Remind me about parcels");
  });

  it("refuses a shop that is not the person's, no shop at all, and a person's own tenant while they are in shops, nothing sent", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const shop of ["pilot:someone-elses", null, undefined, 7]) {
      expect(await refusal(req("routine.create", make({ shop }))), `create ${String(shop)}`).toEqual({ code: "not_found", message: t("rt.notFound") });
      expect(await refusal(req("routine.remove", { shop, routine: "rt-0001-brief" })), `remove ${String(shop)}`).toEqual({ code: "not_found", message: t("rt.notFound") });
    }
    expect(api.calls).toHaveLength(before);
  });

  it("has no team for a person who is in no shops, and sends nothing", async () => {
    const api = fakeApi();
    serveShop(api);
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
    const rt = new HttpRuntime(new HttpHost({ session }));
    await rt.connect();
    const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
    const before = api.calls.length;
    expect(await refusal(req("routine.create", make({ shop: null })))).toEqual({ code: "no_shop", message: t("routines.err.noShop") });
    expect(await refusal(req("routine.remove", { shop: null, routine: "sched-1" }))).toEqual({ code: "no_shop", message: t("routines.err.noShop") });
    expect(api.calls).toHaveLength(before);
    // their own schedules are shown and never changed, as before
    expect((await req("routine.list", {})).shop).toBeNull();
  });
});

describe("while only a kept read of the shop is shown", () => {
  it("sends neither change, queues none, and sends none when the API is back", async () => {
    const { api, host, req } = await opened();
    api.on("GET", "/v1/shops", "offline");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(host.cache.kind).toBe("showing");
    const before = api.calls.length;
    expect(await refusal(req("routine.create", make()))).toEqual({ code: "offline", message: t("rt.offline") });
    expect(await refusal(req("routine.remove", { shop: SHOP_A.id, routine: "rt-0001-brief" }))).toEqual({ code: "offline", message: t("rt.offline") });
    expect(api.calls).toHaveLength(before);
    api.on("GET", "/v1/shops", { status: 200, json: { shops: [SHOP_A, SHOP_B] } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent(api)).toEqual([]);
  });
});

describe("what the API refuses when a routine is made, said in words", () => {
  it("says its limit of 50, and a team that is full can make one once it removes one", async () => {
    const { shops, req } = await opened();
    const w = shops.work[SHOP_A.id];
    // the read is of a team that already has 50
    while (w.routines.length < MAX_ROUTINES) w.routines.push(routineJson({ id: `rt-fill-${w.routines.length}`, name: `Fill ${w.routines.length}` }));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await refusal(req("routine.create", make()))).toEqual({ code: "full", message: t("routines.err.full", { max: MAX_ROUTINES }) });
    expect(w.routines).toHaveLength(MAX_ROUTINES);
    await req("routine.remove", { shop: SHOP_A.id, routine: "rt-fill-5" });
    await req("routine.create", make());
    expect(w.routines).toHaveLength(MAX_ROUTINES);
  });

  it("says every refusal the API gives for the route: the package's, the member's, its owner-only rule and a shop it has no record of", async () => {
    const { api, req } = await opened();
    const says = async (status: number, error: string) => {
      api.on("POST", "/v1/routines", { status, json: { error } });
      return refusal(req("routine.create", make()));
    };
    // what the API refuses for reasons of its own (the rules the desktop already checked, moved on, or a member the form never names)
    for (const [error, key] of [
      ["invalid_name", "routines.problem.name"],
      ["invalid_action", "routines.problem.action"],
      ["invalid_time_zone", "routines.problem.zone"],
      ["invalid_trigger", "routines.problem.trigger"],
      ["invalid_time", "routines.problem.time"],
      ["invalid_weekdays", "routines.problem.weekdays"],
      ["invalid_day", "routines.problem.day"],
      ["invalid_window", "routines.problem.window"],
      ["invalid_threshold", "routines.problem.threshold"],
      ["must_ask_first", "routines.problem.mustAsk"],
      ["unknown_member", "routines.problem.member"],
      ["wrong_member", "routines.problem.member"],
    ] as const)
      expect(await says(400, error), error).toEqual({ code: error, message: t(key) });
    expect(await says(400, "invalid_request")).toEqual({ code: "invalid_request", message: t("rt.change.refused") });
    expect(await says(409, "full")).toEqual({ code: "full", message: t("routines.err.full", { max: MAX_ROUTINES }) });
    expect(await says(403, "owner_only")).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Fon", shop: "Baan Mali" }) });
    expect(await says(404, "not_found")).toEqual({ code: "not_found", message: t("rt.notFound") });
    expect(await says(404, "shop_not_found")).toEqual({ code: "not_found", message: t("rt.notFound") });
  });

  it("says each of those words in every language, none empty", () => {
    for (const l of LANGS)
      for (const k of ["routines.problem.name", "routines.problem.action", "routines.problem.trigger", "routines.problem.zone", "routines.problem.weekdays", "routines.problem.time", "routines.problem.day", "routines.problem.window", "routines.problem.threshold", "routines.problem.mustAsk", "routines.problem.member", "routines.err.noShop", "routines.err.full", "rt.ownerOnly", "rt.notFound", "rt.change.refused", "rt.change.noReply", "rt.change.unreadable"] as const)
        expect(t(k, { max: MAX_ROUTINES, owner: "Fon", shop: "Baan Mali" }, l).trim(), `${l} ${k}`).not.toBe("");
  });
});

describe("removing a routine", () => {
  it("sends POST /v1/routines/remove with exactly { routineId } and the shop's own session, and answers which routine went", async () => {
    const { api, shops, req } = await opened();
    const before = sent(api).length;
    const answer = await req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" });
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/routines/remove", OWNER_A, { routineId: "rt-0003-books" }]]);
    expect(answer).toEqual({ routine: "rt-0003-books" });
    // it names the routine that went and holds none of it
    expect(JSON.stringify(answer)).not.toContain("The books");
    expect(shops.work[SHOP_A.id].routines.map((r) => r.id)).toEqual(["rt-0001-brief"]);
  });

  it("takes it out of the list at once, reads the shop again, and tells the screens the routines changed", async () => {
    const { api, rt, req } = await opened();
    const heard: string[] = [];
    rt.on("routines.update", () => heard.push("routines.update"));
    const reads = api.to("GET", "/v1/routines").length;
    await req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" });
    expect((await req("routine.list", {})).routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief", "sched-own"]);
    await vi.advanceTimersByTimeAsync(5);
    expect(api.to("GET", "/v1/routines").length).toBeGreaterThan(reads);
    expect(heard).toContain("routines.update");
    expect((await req("routines.list", { bot: "ton" })).routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief"]);
  });

  it("sends only a routine the read lists for that shop, never a schedule of the shop's own, and sends nothing for any other", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const routine of ["rt-9999-none", "sched-own", "", undefined, 5]) expect(await refusal(req("routine.remove", { shop: SHOP_A.id, routine })), String(routine)).toEqual({ code: "not_found", message: t("rt.notFound") });
    expect(api.calls).toHaveLength(before);
  });

  it("says a routine that is gone already is gone, reads the shop again, and shows it no more", async () => {
    const { shops, req } = await opened();
    // another device removed it since the page's list was read
    shops.work[SHOP_A.id].routines = shops.work[SHOP_A.id].routines.filter((r) => r.id !== "rt-0003-books");
    expect(await refusal(req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" }))).toEqual({ code: "not_found", message: t("rt.notFound") });
    await vi.advanceTimersByTimeAsync(5);
    expect((await req("routine.list", {})).routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief", "sched-own"]);
  });

  it("is not taken as done when the answer does not name the routine", async () => {
    const { api, req } = await opened();
    for (const json of [{}, { removed: "rt-0001-brief" }, { removed: true }, null] as const) {
      api.on("POST", "/v1/routines/remove", { status: 200, json });
      expect(await refusal(req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" })), JSON.stringify(json)).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    }
  });
});

describe("a change that got no answer", () => {
  const ways = [
    [{ status: 503, json: { error: "routines_unavailable" } }, t("rt.change.noReply")],
    [{ status: 503, json: { error: "clock_unavailable" } }, t("rt.change.noReply")],
    [{ status: 503, json: { error: "shop_unavailable" } }, t("rt.change.noReply")],
    [{ status: 502, text: "<html>bad gateway</html>" }, t("rt.change.noReply")],
    ["failed", t("rt.change.noReply")],
    ["offline", t("rt.offline")],
  ] as const;

  it("is said as no reply, never as done, and is sent once and never again from here: not for a 5xx, not offline, not too slow", async () => {
    for (const [answer, words] of ways) {
      const { api, req } = await opened();
      api.on("POST", "/v1/routines", answer).on("POST", "/v1/routines/remove", answer);
      const made = await refusal(req("routine.create", make()));
      const removed = await refusal(req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" }));
      for (const out of [made, removed]) {
        expect(out?.message, JSON.stringify(answer)).toBe(words);
        expect(out?.code, JSON.stringify(answer)).toMatch(/^(unavailable|offline)$/);
      }
      // one request each, and none later: the API may have it, and the read that follows says
      await vi.advanceTimersByTimeAsync(130_000);
      expect(api.to("POST", "/v1/routines"), JSON.stringify(answer)).toHaveLength(1);
      expect(api.to("POST", "/v1/routines/remove"), JSON.stringify(answer)).toHaveLength(1);
    }
  });

  it("is read again before it says so, so the list asked for next says whether it happened: a routine made whose answer was lost", async () => {
    const { api, shops, req } = await opened();
    api.on("POST", "/v1/routines", (call) => {
      // the API makes the routine, and the answer never comes
      const { name } = call.body as { name: string };
      shops.work[SHOP_A.id].routines.push(routineJson({ id: "rt-made-lost", name }));
      return "failed";
    });
    expect((await refusal(req("routine.create", make({ name: "Remind me about parcels" }))))?.message).toBe(t("rt.change.noReply"));
    const { routines } = await req("routine.list", {});
    expect(routines.map((r: { id: string }) => r.id)).toContain("rt-made-lost");
    expect(api.to("POST", "/v1/routines")).toHaveLength(1);
  });

  it("is read again before it says so, and a routine removed whose answer was lost is gone from the next list", async () => {
    const { api, shops, req } = await opened();
    api.on("POST", "/v1/routines/remove", () => {
      shops.work[SHOP_A.id].routines = shops.work[SHOP_A.id].routines.filter((r) => r.id !== "rt-0003-books");
      return { status: 503, json: { error: "routines_unavailable" } };
    });
    expect((await refusal(req("routine.remove", { shop: SHOP_A.id, routine: "rt-0003-books" })))?.message).toBe(t("rt.change.noReply"));
    expect((await req("routine.list", {})).routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief", "sched-own"]);
  });

  it("is not taken as made when the answer is no routine, however the API said it", async () => {
    const { api, req } = await opened();
    for (const json of [{}, { routine: null }, { routine: "rt-1" }, { routine: { name: "x" } }, null] as const) {
      api.on("POST", "/v1/routines", { status: 200, json });
      expect(await refusal(req("routine.create", make())), JSON.stringify(json)).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    }
  });

  it("is sent again after a 401 only, as every shop request is: the session opens again once and the same body goes with it", async () => {
    const { api, shops, req } = await opened();
    const first = shopToken(SHOP_A.id, "owner", 1);
    shops.refused.add(first);
    await req("routine.create", make());
    const posts = api.to("POST", "/v1/routines");
    expect(posts.map((c) => c.bearer)).toEqual([first, shopToken(SHOP_A.id, "owner", 2)]);
    expect(posts.map((c) => c.body)).toEqual([{ name: "Remind me about parcels", action: "draft", trigger: daily }, { name: "Remind me about parcels", action: "draft", trigger: daily }]);
    expect(shops.work[SHOP_A.id].routines.filter((r) => r.name === "Remind me about parcels")).toHaveLength(1);
  });
});
