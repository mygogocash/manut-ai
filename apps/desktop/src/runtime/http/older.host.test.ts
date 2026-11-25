// Show older on the connected runtime (docs/runtime-adapter.md, "Older tasks"): a shop with more tasks than the newest 50 says so in
// the lists that show them, `jobs.older` reads the next page of 25 from the cursor the minute's read stopped at with the shop's own
// session, the older pages stay while the shop is read again every minute, and none of them reaches the offline cache. The rules that
// keep the pages whole (older.ts) are in older.test.ts; this is the runtime end to end over a fake API that answers the task list as
// apps/api does, newest first with a cursor that is a task's id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { CACHE_VERSION, ShopCache, cacheKey } from "./cache";
import { HttpHost, POLL_MS } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { LinkDown, type FetchLike } from "./shell";
import {
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  serveShop,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  taskJson,
  workerTaskJson,
  type FakeAnswer,
  type FakeApi,
  type ShopJson,
  type ShopWorkJson,
} from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
/** A second shop the person owns. */
const SHOP_C: ShopJson = { id: "pilot:shop-c", name: "Baan Din", ownerName: "Fon", role: "owner" };

/** The shop's `i`th task, `t1` the oldest, each made a second after the one before, with a draft a member wrote on it (so each is one
 *  job and one event of the activity log). */
const shopTask = (i: number, over: Record<string, unknown> = {}) =>
  taskJson({
    task: { id: `t${i}`, title: `Task ${i}`, state: "completed", updatedAt: iso(T0 + i * 1000), ...over },
    actions: [],
    drafts: [{ attemptId: `a${i}`, member: "nam", job: "reply", text: `Draft ${i}`, at: iso(T0 + i * 1000) }],
  });
const tasks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => shopTask(from + i));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** The numbers of the tasks a list of jobs holds, oldest first. */
const nums = (jobs: { id: string }[]) => jobs.map((j) => Number(j.id.slice(1))).sort((a, b) => a - b);
/** A task as the fake API holds it, to change what a later read finds. */
type Held = { task: { id: string; title: string } };

/** The network between the session and the fake API, which a test can take down, make answer a request of the task list its own way,
 *  or hold a page back on its way. Every request that is not taken down still reaches the API's log. */
interface Net {
  /** every request fails to reach the API, as when the computer is offline */
  down: boolean;
  /** what to answer a request of the task list with in place of the API's, given its cursor; undefined lets the API's answer stand */
  force: ((cursor: string | null) => FakeAnswer | undefined) | null;
  /** holds the answer to a request of the task list back until the promise it returns is done; null holds nothing */
  hold: ((cursor: string | null) => Promise<void> | null) | null;
}

const through =
  (net: Net) =>
  (api: FakeApi): FetchLike =>
  async (url, init) => {
    if (net.down) throw new LinkDown("offline");
    const u = new URL(url);
    const cursor = u.pathname === "/v1/tasks" ? u.searchParams.get("cursor") : null;
    const real = await api.fetch(url, init);
    const waiting = u.pathname === "/v1/tasks" ? net.hold?.(cursor) : null;
    if (waiting) await waiting;
    const forced = u.pathname === "/v1/tasks" ? net.force?.(cursor) : undefined;
    if (forced === undefined) return real;
    if (forced === "offline" || forced === "failed") throw new LinkDown(forced);
    const body = forced.text ?? JSON.stringify(forced.json ?? {});
    return { status: forced.status, text: async () => body };
  };

interface Options {
  /** the shops the person is in, Baan Mali (owned) alone by default; none for a person in no shop, whose own tenant is read */
  list?: ShopJson[];
  /** the work of other shops than Baan Mali, by shop id */
  work?: Record<string, Partial<ShopWorkJson>>;
}

/** The runtime over a shop of `n` tasks, `shopTasks` being the shop's index as the fake API holds it: a test pushes a task to make
 *  one, and takes one out to delete it. With no shop listed, the person's own tenant has them, as an API from before shops. */
async function opened(n: number, opts: Options = {}) {
  const net: Net = { down: false, force: null, hold: null };
  const api = fakeApi();
  const list = opts.list ?? [SHOP_A];
  const shopTasks = tasks(n);
  const shops = list.length ? serveShops(api, list, {}, () => NOW, { [SHOP_A.id]: { tasks: shopTasks }, ...opts.work }) : null;
  if (!shops) serveShop(api, { tasks: shopTasks, approvals: [] });
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  const session = new ApiSession({ origin: ORIGIN, fetch: through(net)(api), vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
  return { api, net, shops, shopTasks, disk, host, rt, req, events, session };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
const settle = () => vi.advanceTimersByTimeAsync(0);
/** The shop is read again, as it is every minute. */
const minute = () => vi.advanceTimersByTimeAsync(POLL_MS);
/** The requests for a page after a cursor that the API was asked for, each as its query and the bearer it carried. */
const pagesAsked = (api: FakeApi) => api.to("GET", "/v1/tasks").filter((c) => new URL(c.url).searchParams.has("cursor")).map((c) => `${new URL(c.url).search} ${c.bearer}`);
/** What a request for the page after `cursor` looks like in `pagesAsked`. */
const after = (cursor: string, bearer: string) => `?limit=25&cursor=${cursor} ${bearer}`;
/** The cursor of the last page the API was asked for. */
const lastCursor = (api: FakeApi) => new URL(api.to("GET", "/v1/tasks").at(-1)!.url).searchParams.get("cursor");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("knowing there are more", () => {
  it("says so in the jobs and the activity log when the shop has more tasks than the newest 50", async () => {
    const { req } = await opened(80);
    const jobs = await req("jobs.list", {});
    expect(jobs.older).toBe("more");
    expect(nums(jobs.jobs)).toEqual(range(31, 80));
    const log = await req("activity.list", {});
    expect(log.older).toBe("more");
    expect(log.events).toHaveLength(50);
    // 51 is one more than the newest 50
    expect((await (await opened(51)).req("jobs.list", {})).older).toBe("more");
  });

  it("says nothing when the shop has 50 tasks or fewer: every one is shown, and the answers are as they were", async () => {
    for (const n of [50, 30, 0]) {
      const { req } = await opened(n);
      const jobs = await req("jobs.list", {});
      expect(Object.keys(jobs), `${n} tasks`).toEqual(["jobs"]);
      expect(jobs.jobs, `${n} tasks`).toHaveLength(n);
      expect(Object.keys(await req("activity.list", {})).sort(), `${n} tasks`).toEqual(["events", "keptMonths"]);
    }
  });

  it("says so for a person in no shop, whose own tasks are read from the same list", async () => {
    const { req } = await opened(80, { list: [] });
    expect((await req("jobs.list", {})).older).toBe("more");
    expect((await req("activity.list", {})).older).toBe("more");
  });

  it("says nothing for a shop the person only helps at, which lists no tasks, and refuses Show older there", async () => {
    const { req } = await opened(80, { list: [SHOP_A, SHOP_B] });
    await req("shops.switch", { shop: SHOP_B.id });
    expect(await req("jobs.list", {})).toEqual({ jobs: [] });
    expect(await refusal(req("jobs.older", {}))).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" }) });
  });
});

describe("reading the next page", () => {
  it("reads the page after the cursor the minute's read stopped at, with the shop's own session, and lists those tasks with the newest", async () => {
    const { api, req, events } = await opened(80);
    // the minute's read: two pages, the second from the first's cursor
    expect(api.to("GET", "/v1/tasks").map((c) => new URL(c.url).search)).toEqual(["?limit=25", "?limit=25&cursor=t56"]);
    const before = events.length;
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    // the cursor it stopped at is the last task it looked at, the oldest of the newest 50: t31
    expect(pagesAsked(api)).toEqual([after("t56", OWNER_A), after("t31", OWNER_A)]);
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 80));
    expect(jobs.older).toBe("more");
    const log = await req("activity.list", {});
    expect(log.events.map((e: { id: string }) => e.id).sort()).toEqual(range(6, 80).map((i) => `t${i}:draft`).sort());
    expect(log.older).toBe("more");
    // an older task is the shop's work, not a new thread or message: nothing in the app is told of it, and Buddy's threads are the same
    expect(events.slice(before)).toEqual([]);
    expect((await req("thread.list", { bot: "buddy" })).threads).toHaveLength(50);
  });

  it("reads the page after that when pressed again, and says it has shown everything once the list has no more", async () => {
    const { api, req } = await opened(80);
    await req("jobs.older", {});
    // 80 tasks: the newest 50, the page of 25 after them, and the 5 that are left
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(lastCursor(api)).toBe("t6");
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(1, 80));
    expect(jobs.older).toBe("end");
    expect((await req("activity.list", {})).older).toBe("end");
    // there is nothing more to ask for: a press asks nothing and the screen still says everything is shown
    const asked = api.calls.length;
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(api.calls.length).toBe(asked);
  });

  it("reads the same way for a person in no shop, with their own sign-in", async () => {
    const { api, req } = await opened(80, { list: [] });
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    expect(pagesAsked(api)).toEqual([after("t56", "access-1"), after("t31", "access-1")]);
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 80));
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(1, 80));
  });

  it("reads one page for two presses at once", async () => {
    const { api, req } = await opened(80);
    const both = await Promise.all([req("jobs.older", {}), req("jobs.older", {})]);
    expect(both).toEqual([{ older: "more" }, { older: "more" }]);
    expect(pagesAsked(api).filter((p) => p.includes("cursor=t31"))).toHaveLength(1);
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 80));
  });

  it("asks nothing for a shop whose newest read held every task it has, and says everything is shown", async () => {
    const { api, req } = await opened(30);
    const asked = api.calls.length;
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(api.calls.length).toBe(asked);
  });

  it("reads each shop's pages for that shop, with that shop's own session, and keeps them while the other is viewed", async () => {
    const { api, req, shops } = await opened(80, { list: [SHOP_A, SHOP_C], work: { [SHOP_C.id]: { tasks: tasks(70) } } });
    await req("jobs.older", {});
    await req("shops.switch", { shop: SHOP_C.id });
    // Baan Din's own newest read: 70 tasks, 50 of them (the same ids are not Baan Mali's)
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(21, 70));
    expect((await req("jobs.list", {})).older).toBe("more");
    const tokenC = shopToken(SHOP_C.id, "owner");
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(pagesAsked(api).filter((p) => p.endsWith(tokenC)).at(-1)).toBe(after("t21", tokenC));
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(1, 70));
    // back at Baan Mali, its older pages are still there, and none of its pages was read with Baan Din's session
    await req("shops.switch", { shop: SHOP_A.id });
    const mali = await req("jobs.list", {});
    expect(nums(mali.jobs)).toEqual(range(6, 80));
    expect(mali.older).toBe("more");
    expect(pagesAsked(api).filter((p) => p.endsWith(OWNER_A))).toEqual([after("t56", OWNER_A), after("t31", OWNER_A)]);
    expect(shops!.opened[SHOP_A.id]).toBe(1);
  });
});

describe("keeping them while the shop is read again", () => {
  it("keeps the older pages through the minute's read, which reads its two pages and nothing more", async () => {
    const { api, req } = await opened(80);
    await req("jobs.older", {});
    const before = api.to("GET", "/v1/tasks").length;
    await minute();
    expect(api.to("GET", "/v1/tasks").length - before).toBe(2);
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 80));
    expect(jobs.older).toBe("more");
    expect((await req("activity.list", {})).events).toHaveLength(75);
  });

  it("keeps a task made while the person pages, and skips and repeats none: the one that falls out of the newest 50 joins the older ones", async () => {
    const { api, req, shopTasks, events } = await opened(80);
    await req("jobs.older", {}); // t6 .. t80
    shopTasks.push(...tasks(3, 81));
    const before = events.length;
    await minute();
    // the newest read now holds t34 .. t83: the ones that fell out of it (t31 .. t33) are the first of the older ones
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 83));
    expect(new Set(jobs.jobs.map((j: { id: string }) => j.id)).size).toBe(78);
    // as before this slice, a task that falls out of the newest 50 is no thread of Buddy's, and a new one is: the jobs and the log keep it
    const named = (kind: string) => events.slice(before).filter((e) => e.event === kind).map((e) => (e as unknown as { thread: string }).thread).sort();
    expect(named("thread.added")).toEqual(["t81", "t82", "t83"]);
    expect(named("thread.removed")).toEqual(["t31", "t32", "t33"]);
    // the next page picks up where the last one ended, which no task made since has moved
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(lastCursor(api)).toBe("t6");
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(1, 83));
    expect((await req("activity.list", {})).events).toHaveLength(83);
  });

  it("keeps the tasks a minute's read pushes out while the first page is still on its way, and the page joins them", async () => {
    const { api, net, req, shopTasks } = await opened(80);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    net.hold = (cursor) => (cursor === "t31" ? held : null);
    const press = req("jobs.older", {});
    await settle(); // the page is asked for, and its answer held back
    expect(pagesAsked(api).filter((p) => p.includes("cursor=t31"))).toHaveLength(1);
    // two tasks are made, and the minute's read lands before the page does
    shopTasks.push(...tasks(2, 81));
    await minute();
    release();
    expect(await press).toEqual({ older: "more" });
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 82));
  });

  it("lists a task once, as the newer read has it, when tasks are deleted and the newest read reaches into the older pages", async () => {
    const { req, shopTasks } = await opened(80);
    await req("jobs.older", {}); // t6 .. t80
    shopTasks.splice(74, 6); // t75 .. t80 are deleted: the newest read now holds t25 .. t74
    (shopTasks[29] as Held).task.title = "Renamed since";
    await minute();
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 74));
    expect(jobs.jobs.filter((j: { id: string }) => j.id === "t30")).toEqual([expect.objectContaining({ title: "Renamed since" })]);
    expect(jobs.older).toBe("more");
    // a task deleted from the newest read is gone, and not carried among the older ones
    shopTasks.splice(60, 1); // t61
    await minute();
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 74).filter((i) => i !== 61));
  });

  it("lets the older pages go when 50 or more tasks were made since the last read, and the next page starts from the new cursor", async () => {
    const { api, req, shopTasks } = await opened(80);
    await req("jobs.older", {});
    shopTasks.push(...tasks(60, 81));
    await minute();
    // the newest read holds t91 .. t140 and shares none of the tasks the last one held: the tasks between are unread
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(91, 140));
    expect(jobs.older).toBe("more");
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    expect(lastCursor(api)).toBe("t91");
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(66, 140));
  });

  it("lets the older pages go, and offers none, when the shop shrinks to what the newest read holds", async () => {
    const { req, shopTasks } = await opened(80);
    await req("jobs.older", {});
    shopTasks.splice(0, 40); // 40 tasks are left
    await minute();
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(41, 80));
    expect(Object.keys(jobs)).toEqual(["jobs"]);
  });

  it("shows an older task as it was when it was read: only the newest read is read again", async () => {
    const { req, shopTasks } = await opened(80);
    await req("jobs.older", {});
    (shopTasks[9] as Held).task.title = "Changed in the shop"; // t10, which was read as an older task
    (shopTasks[69] as Held).task.title = "Changed in the newest"; // t70
    await minute();
    const jobs = (await req("jobs.list", {})).jobs as { id: string; title: string }[];
    expect(jobs.find((j) => j.id === "t10")?.title).toBe("Task 10");
    expect(jobs.find((j) => j.id === "t70")?.title).toBe("Changed in the newest");
  });
});

describe("what is live is only the newest read's", () => {
  it("does not make a member work, or a job run, for an older task that was working when it was read", async () => {
    // t28 is an older task, one of Nam's, whose run could still act when it was read
    const working = workerTaskJson({ id: "t28", member: "nam", claimedAt: NOW - 30_000, finishedAt: null, draft: null });
    const all = tasks(80).map((x, i) => (i === 27 ? working : x));
    const { req } = await opened(80, { work: { [SHOP_A.id]: { tasks: all } } });
    const nam = async () => (await req("bots.list", {})).bots.find((b: { name: string }) => b.name === "nam").running;
    expect(await nam()).toBe(false);
    expect(await refusal(req("jobs.get", { job: "t28" }))).not.toBeNull();
    await req("jobs.older", {});
    // the older task is listed, as the job it is, and nobody is made to work for it
    expect(nums((await req("jobs.list", {})).jobs)).toContain(28);
    expect(await nam()).toBe(false);
    expect((await req("team.state", {})).running).toEqual([]);
    // and it opens as a job
    expect((await req("jobs.get", { job: "t28" })).id).toBe("t28");
  });
});

describe("when a page cannot be read", () => {
  it("leaves what is shown and says so, whether the API did not answer, was down, or sent what is no page, and reads the page when pressed again", async () => {
    const { net, req } = await opened(80);
    const bad: [FakeAnswer, string, string][] = [
      [{ status: 503, json: { error: "tasks_unavailable" } }, "unavailable", t("older.failed")],
      [{ status: 500, text: "Internal error" }, "unavailable", t("older.failed")],
      ["offline", "offline", t("older.offline")],
      ["failed", "unavailable", t("older.failed")],
      // a 200 that is not a page is never an empty page, and never the end of the list
      [{ status: 200, json: { error: "oops" } }, "unavailable", t("older.failed")],
      [{ status: 200, json: { tasks: "none", next: null } }, "unavailable", t("older.failed")],
      [{ status: 200, json: { tasks: [], next: 7 } }, "unavailable", t("older.failed")],
      [{ status: 200, json: { tasks: [] } }, "unavailable", t("older.failed")],
      [{ status: 403, json: { error: "owner_only" } }, "unavailable", t("older.failed")],
      [{ status: 404, json: { error: "tenant_deleted" } }, "unavailable", t("older.failed")],
    ];
    for (const [answer, code, message] of bad) {
      net.force = (cursor) => (cursor === "t31" ? answer : undefined);
      expect(await refusal(req("jobs.older", {})), JSON.stringify(answer)).toEqual({ code, message });
      await settle();
      const jobs = await req("jobs.list", {});
      expect(nums(jobs.jobs), JSON.stringify(answer)).toEqual(range(31, 80));
      expect(jobs.older, JSON.stringify(answer)).toBe("more");
    }
    // Try again: the page is read now, from the same cursor
    net.force = null;
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 80));
  });

  it("leaves the pages already read as they were when the page after them cannot be read", async () => {
    const { net, req } = await opened(80);
    await req("jobs.older", {});
    net.force = (cursor) => (cursor === "t6" ? { status: 503, json: { error: "tasks_unavailable" } } : undefined);
    expect(await refusal(req("jobs.older", {}))).toMatchObject({ code: "unavailable" });
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 80));
    expect(jobs.older).toBe("more");
  });

  it("treats a 401 as the minute's read does: the shop's session is opened again once and the page is sent once more", async () => {
    const { api, req, shops } = await opened(80);
    shops!.refused.add(OWNER_A);
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    expect(shops!.opened[SHOP_A.id]).toBe(2);
    expect(pagesAsked(api).filter((p) => p.includes("cursor=t31"))).toEqual([after("t31", OWNER_A), after("t31", shopToken(SHOP_A.id, "owner", 2))]);
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 80));
  });

  it("treats the end of the person's place in the shop as the minute's read does: it ends here, the shop leaves, and the page is not sent again", async () => {
    const { api, req, shops, host } = await opened(80);
    shops!.ended[SHOP_A.id] = { error: "unlinked", at: iso(NOW - 60_000) };
    expect(await refusal(req("jobs.older", {}))).toMatchObject({ code: "unlinked" });
    expect(pagesAsked(api).filter((p) => p.includes("cursor=t31"))).toHaveLength(1);
    expect((await req("shops.list", {})).left).toMatchObject([{ id: SHOP_A.id, why: "unlinked" }]);
    expect(host.link).toBe("open");
  });

  it("treats a sign-in that has ended as the minute's read does: the person is signed out", async () => {
    const { api, req, host } = await opened(80, { list: [] });
    api.on("GET", "/v1/tasks", { status: 401, json: { error: "unauthorized" } }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "invalid_grant" } });
    expect(await refusal(req("jobs.older", {}))).toMatchObject({ code: "signed_out" });
    expect(host.link).toBe("signed_out");
  });

  it("lets a cursor the API no longer knows go, so the next press reads from the newest read's cursor again", async () => {
    const { api, req, shopTasks } = await opened(80);
    await req("jobs.older", {}); // t6 .. t80, and the cursor is t6
    shopTasks.splice(5, 1); // t6 is deleted
    expect(await refusal(req("jobs.older", {}))).toEqual({ code: "unavailable", message: t("older.failed") });
    expect(pagesAsked(api).filter((p) => p.startsWith("?limit=25&cursor=t6 "))).toHaveLength(1);
    // the shop is read again, and what was read of the older pages is let go with the cursor that named a task no more
    await settle();
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(31, 80));
    expect(await req("jobs.older", {})).toEqual({ older: "more" });
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(5, 80).filter((i) => i !== 6));
  });
});

describe("offline", () => {
  it("says Show older needs a connection while only a kept read is shown, asks nothing, and keeps the older pages already read", async () => {
    const { api, net, req, host } = await opened(80);
    await req("jobs.older", {});
    net.down = true;
    await minute();
    expect(host.cache.kind).toBe("showing");
    const asked = api.calls.length;
    expect(await refusal(req("jobs.older", {}))).toEqual({ code: "offline", message: t("older.offline") });
    expect(api.calls.length).toBe(asked);
    // what was read stays in memory: the read shown is this run's last good one, older pages and all, and it still says there are more
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(6, 80));
    expect(jobs.older).toBe("more");
  });

  it("says the same when the page cannot be reached before the host has noticed, and leaves what is shown", async () => {
    const { net, req } = await opened(80);
    net.down = true;
    expect(await refusal(req("jobs.older", {}))).toEqual({ code: "offline", message: t("older.offline") });
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(31, 80));
  });

  it("keeps the older pages through an outage and the read that ends it, and Show older then reads the page after them", async () => {
    const { api, net, req, shopTasks, host } = await opened(80);
    await req("jobs.older", {});
    net.down = true;
    await minute();
    expect(host.cache.kind).toBe("showing");
    // the API is back, with a task more
    net.down = false;
    shopTasks.push(shopTask(81));
    await minute();
    expect(host.cache.kind).toBe("none");
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(6, 81));
    expect(await req("jobs.older", {})).toEqual({ older: "end" });
    expect(lastCursor(api)).toBe("t6");
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(1, 81));
  });

  it("says nothing of older tasks for a read kept by an earlier run, which holds no cursor, and says Show older needs a connection", async () => {
    const first = await opened(80, { list: [] });
    await settle();
    const files = Object.fromEntries(first.disk.files);
    expect(Object.keys(files)).toEqual([cacheKey(ORIGIN, "apple:owner-1")]);
    // a new run, started with no network, shows what the earlier one kept
    const net: Net = { down: true, force: null, hold: null };
    const cache = new ShopCache(memoryCacheStore(files));
    const session = new ApiSession({ origin: ORIGIN, fetch: through(net)(fakeApi()), vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
    const host = new HttpHost({ session, cache });
    const rt = new HttpRuntime(host);
    void rt.connect().catch(() => undefined);
    await vi.waitFor(() => expect(host.cache.kind).toBe("showing"), { timeout: 10_000, interval: 10 });
    const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
    const jobs = await req("jobs.list", {});
    expect(nums(jobs.jobs)).toEqual(range(31, 80));
    expect(Object.keys(jobs)).toEqual(["jobs"]);
    expect(await refusal(req("jobs.older", {}))).toEqual({ code: "offline", message: t("older.offline") });
  });
});

describe("the offline cache", () => {
  it("is left as it is: the newest 50 only, version 5, and no older page or cursor is ever written to disk", async () => {
    const { req, disk, host } = await opened(80);
    await req("jobs.older", {});
    await req("jobs.older", {});
    await minute();
    await settle();
    expect(nums((await req("jobs.list", {})).jobs)).toEqual(range(1, 80));
    expect(host.cache.kind).toBe("none");
    const text = [...disk.files.values()][0];
    const file = JSON.parse(text);
    expect(file.v).toBe(CACHE_VERSION);
    expect(CACHE_VERSION).toBe(5);
    const work = file.snapshot.shops[0].work;
    expect(Object.keys(work).sort()).toEqual(["attention", "routines", "schedules", "tasks", "team"]);
    expect(work.tasks.map((x: { id: string }) => x.id)).toEqual(range(31, 80).map((i) => `t${i}`));
    for (const i of range(1, 30)) expect(text, `t${i}`).not.toContain(`"t${i}"`);
    for (const key of ["older", "more", "cursor"]) expect(text, key).not.toContain(`"${key}"`);
  });

  it("keeps a person in no shop's own read the same way", async () => {
    const own = await opened(80, { list: [] });
    await own.req("jobs.older", {});
    await minute();
    await settle();
    const file = JSON.parse([...own.disk.files.values()][0]);
    expect(file.v).toBe(5);
    expect(file.snapshot.tasks.map((x: { id: string }) => x.id)).toEqual(range(31, 80).map((i) => `t${i}`));
    expect(Object.keys(file.snapshot).sort()).toEqual(["approvals", "attention", "attentionOff", "readAt", "schedules", "tasks"]);
  });
});
