// The connected runtime end to end over a fake API: what it reads, what it shows through the app's protocol, how it
// stays current, and how it reports being signed out, offline or facing an API that does not answer. It writes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { HttpHost, POLL_MS } from "./host";
import { HTTP_CAPABILITIES, HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  actionJson,
  attentionJson,
  fakeApi,
  memoryVault,
  ORIGIN,
  scheduleJson,
  serveShop,
  storedSession,
  T0,
  taskJson,
  tokens,
  WRITE_OPS,
  type FakeApi,
} from "./testkit";

const NOW = T0 + 600_000;

function setup(opts: { signedIn?: boolean } = {}) {
  const api = fakeApi();
  const vault = memoryVault(opts.signedIn === false ? null : storedSession(NOW));
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, deviceId: () => "device-2" });
  const host = new HttpHost({ session });
  const events: BridgeEvent[] = [];
  const statuses: string[] = [];
  const rt = new HttpRuntime(host);
  rt.onAny((ev) => events.push(ev));
  rt.onStatus((s) => statuses.push(s));
  return { api, vault, session, host, rt, events, statuses };
}

/** What a refused request carries. */
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
const gets = (api: FakeApi) => api.calls.filter((c) => c.method === "GET").map((c) => c.path);
/** Lets every answer already given run on (no timer moves). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connecting", () => {
  it("reads the shop when its first client connects, and opens", async () => {
    const { api, rt, host, statuses } = setup();
    serveShop(api);
    expect(rt.kind).toBe("http");
    expect(rt.capabilities).toEqual(HTTP_CAPABILITIES);
    expect(rt.status).toBe("closed");
    await rt.connect();
    expect(rt.status).toBe("open");
    expect(host.link).toBe("open");
    expect(statuses).toEqual(["connecting", "open"]);
    expect(gets(api).sort()).toEqual(["/v1/inbound/attention", "/v1/schedules", "/v1/tenant/export"]);
    for (const call of api.calls) expect(call.bearer).toBe("access-1");
  });

  it("answers hello and lists Buddy as the team", async () => {
    const { api, rt } = setup();
    serveShop(api, { tasks: [taskJson({ task: { state: "running" } })] });
    await rt.connect();
    expect(await rt.request("hello", {})).toEqual({ bridge: "real", version: "manut-api/v1", hermes: { home: "" } });
    expect(await rt.request("bots.list", {})).toEqual({
      bots: [{ name: "buddy", display_name: "Buddy", is_default: true, description: "", status: "online", running: true, model: "", provider: "", avatar_rev: null }],
    });
  });

  it("shares one host and one read between the app's clients", async () => {
    const { api, host } = setup();
    serveShop(api);
    const a = new HttpRuntime(host);
    const b = new HttpRuntime(host);
    await Promise.all([a.connect(), b.connect()]);
    expect(gets(api)).toHaveLength(3);
  });

  it("waits signed out, closed, until someone signs in, then reads and opens", async () => {
    const { api, rt, host, session } = setup({ signedIn: false });
    serveShop(api).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    let opened = false;
    void rt.connect().then(() => (opened = true));
    await settle();
    expect(host.link).toBe("signed_out");
    expect(rt.status).toBe("closed");
    expect(opened).toBe(false);
    const threads = rt.request.bind(rt) as unknown as (op: string, p: unknown) => Promise<unknown>;
    expect(await refusal(threads("thread.list", { bot: "buddy" }))).toEqual({ code: "signed_out", message: t("rt.signedOut") });
    expect(api.calls).toEqual([]);
    await session.signIn("eyJ.eyJ.sig", "nonce");
    await settle();
    expect(opened).toBe(true);
    expect(host.link).toBe("open");
  });

  it("says offline when the API cannot be reached, and tries again until it can", async () => {
    const { api, rt, host } = setup();
    serveShop(api).on("GET", "/v1/schedules", "offline");
    let opened = false;
    void rt.connect().then(() => (opened = true));
    await settle();
    expect(host.link).toBe("offline");
    expect(rt.status).toBe("closed");
    expect(await refusal(rt.request("hello", {}))).toEqual({ code: "offline", message: t("rt.offline") });
    serveShop(api);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opened).toBe(true);
    expect(host.link).toBe("open");
  });

  it("shows a 5xx as an API that is not answering, and backs off between tries", async () => {
    const { api, rt, host } = setup();
    serveShop(api).on("GET", "/v1/tenant/export", { status: 503, json: { error: "storage_unavailable" } });
    void rt.connect();
    await settle();
    expect(host.link).toBe("unavailable");
    expect(await refusal(rt.request("bots.list", {}))).toEqual({ code: "unavailable", message: t("rt.unavailable") });
    const tries = () => api.to("GET", "/v1/tenant/export").length;
    expect(tries()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tries()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tries()).toBe(2); // the next wait is longer
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tries()).toBe(3);
  });

  it("refreshes the session on a 401 and tries once more before giving up", async () => {
    const { api, rt, host } = setup();
    serveShop(api)
      .on("GET", "/v1/schedules", { status: 401, json: { error: "unauthorized" } }, { status: 200, json: { schedules: [scheduleJson()] } })
      .on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    await rt.connect();
    expect(host.link).toBe("open");
    expect(api.to("POST", "/v1/auth/refresh")).toHaveLength(1);
    expect(api.to("GET", "/v1/schedules").map((c) => c.bearer)).toEqual(["access-1", "access-2"]);
  });
});

describe("reading", () => {
  it("lists the shop's tasks as Buddy's threads, and opens one as its notes", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    const threads = rt.request.bind(rt) as unknown as (op: string, p: unknown) => Promise<unknown>;
    expect(await threads("thread.list", { bot: "buddy" })).toEqual({
      threads: [expect.objectContaining({ thread: "task-1", title: "Reply to Khun Mali", needs: true, running: false })],
    });
    const open = (await threads("thread.open", { bot: "buddy", thread: "task-1" })) as { messages: { text: string }[] };
    expect(open.messages.map((m) => m.text)).toEqual([
      "**Reply to Khun Mali**\n\nAnswer her question about delivery",
      "Send on LINE: “Your order ships tomorrow morning.” (waiting for you)",
      "Now: waiting for your approval",
    ]);
    expect(await refusal(threads("thread.open", { bot: "buddy", thread: "task-9" }))).toEqual({ code: "not_found", message: t("rt.notFound") });
  });

  it("opens Buddy's chat with the attention notes, then asks again what waits for the owner", async () => {
    const { api, rt, events } = setup();
    serveShop(api);
    await rt.connect();
    const chat = await rt.request("chat.open", { bot: "buddy" });
    expect(chat).toEqual({
      session_id: "main-buddy",
      messages: [{ id: "attention:att-1", role: "assistant", text: "A Linear issue was changed (issue-9).", ts: (T0 + 30_000) / 1000 }],
      running: false,
      model: "",
      provider: "",
      reasoning: "",
    });
    expect(events).toEqual([]);
    await settle();
    expect(events).toEqual([
      {
        event: "approval.request",
        bot: "buddy",
        request_id: "action-1",
        title: "Reply to Khun Mali",
        command: "Send on LINE: “Your order ships tomorrow morning.”",
        choices: ["once", "deny"],
      },
    ]);
  });

  it("lists the schedules on the Automations page and in Buddy's Schedule tab", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    expect(await rt.request("automations.list", {})).toEqual({
      automations: [expect.objectContaining({ id: "sched-1", bot: "buddy", name: "Morning brief", schedule: "30 8 * * 1-5", paused: false, next_run_at: (T0 + 3600_000) / 1000 })],
    });
    expect(await rt.request("routines.list", { bot: "buddy" })).toEqual({
      routines: [{ id: "sched-1", name: "Morning brief", schedule: "30 8 * * 1-5", next_run_at: (T0 + 3600_000) / 1000, last_run_at: null, last_status: null, enabled: true }],
    });
    expect(await rt.request("bots.info", { bot: "buddy" })).toEqual({ places: {}, first_active: T0 / 1000, last_active: (T0 + 120_000) / 1000, skills: 0, routines: 1 });
  });

  it("answers every other read the screens make, empty, without asking the API", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    const before = api.calls.length;
    const req = rt.request.bind(rt) as unknown as (op: string, p: unknown) => Promise<unknown>;
    const reads: [string, Record<string, unknown>][] = [
      ["bots.ready", { bot: "buddy" }],
      ["models.options", { bot: "buddy" }],
      ["skills.list", { bot: "buddy" }],
      ["commands.list", { bot: "buddy" }],
      ["bots.avatar", { bot: "buddy" }],
      ["elsewhere.list", { bot: "buddy" }],
      ["links.places", { bot: "buddy" }],
      ["panel.terminal", { bot: "buddy" }],
      ["panel.worktrees", { bot: "buddy" }],
      ["runs.list", { bot: "buddy" }],
      ["runs.prs", { bot: "buddy", run: "r" }],
      ["runs.cli", {}],
      ["runs.node_session", { bot: "buddy" }],
      ["cli.title", { agent: "claude", session: "s" }],
      ["tasks.linear", { bot: "buddy" }],
      ["usage.read", {}],
      ["accounts.list", {}],
      ["plugins.list", { bot: "buddy" }],
      ["plugins.catalog", { bot: "buddy" }],
      ["bots.restart_scope", { bot: "buddy" }],
    ];
    for (const [op, params] of reads) await expect(req(op, params), op).resolves.toBeDefined();
    expect(await req("bots.ready", { bot: "buddy" })).toEqual({ ok: true, provider: "", model: "", error: "", unknown: true });
    for (const op of ["panel.diff", "runs.get", "elsewhere.peek", "media.read"])
      expect((await refusal(req(op, { bot: "buddy", path: "x", run: "r", session_id: "s" })))?.code, op).toBe("not_found");
    expect(api.calls.length).toBe(before);
  });

  it("knows no member but Buddy, and no op it was not written for", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    expect((await refusal(rt.request("chat.open", { bot: "nam" })))?.code).toBe("unknown_bot");
    expect((await refusal((rt.request.bind(rt) as unknown as (op: string) => Promise<unknown>)("weather.read")))?.code).toBe("unknown_op");
  });

  it("reads the shop again for a list asked for a while after the last read, and not before", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    await rt.request("automations.list", {});
    expect(gets(api)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20_000);
    await rt.request("automations.list", {});
    expect(gets(api)).toHaveLength(6);
  });
});

describe("writing", () => {
  it("answers every write with a clear not yet, and sends nothing to the API", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    const req = rt.request.bind(rt) as unknown as (op: string, p: unknown) => Promise<unknown>;
    for (const op of WRITE_OPS)
      expect(await refusal(req(op, { bot: "buddy", request_id: "action-1", choice: "once", text: "hi", job: "sched-1" })), op).toEqual({
        code: "not_yet",
        message: t("rt.notYet"),
      });
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("staying current", () => {
  it("reads again every minute and tells the app what changed", async () => {
    const { api, rt, events } = setup();
    serveShop(api);
    await rt.connect();
    serveShop(api, {
      tasks: [
        taskJson({ task: { state: "running" }, actions: [actionJson({ state: "confirmed" }), actionJson({ id: "action-2", payload: { text: "It is on its way." } })] }),
        taskJson({ task: { id: "task-2", title: "Weekend post" }, actions: [] }),
      ],
      schedules: [scheduleJson({ enabled: false, revision: 3 })],
      attention: [attentionJson()],
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "approval.request", request_id: "action-2", command: "Send on LINE: “It is on its way.”" }),
        { event: "prompt.expired", bot: "buddy", request_id: "action-1", reason: "resolved" },
        { event: "thread.added", bot: "buddy", thread: "task-2", title: "Weekend post" },
        { event: "routines.update", bot: "buddy" },
        { event: "bots.update", bot: "buddy" },
      ]),
    );
    expect(events).toHaveLength(5);
  });

  it("takes an action that expired out of Needs you as timed out, and a task that went away out of the list", async () => {
    const { api, rt, events } = setup();
    serveShop(api, { tasks: [taskJson(), taskJson({ task: { id: "task-2" }, actions: [] })] });
    await rt.connect();
    serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "expired" })] })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events).toEqual([
      { event: "prompt.expired", bot: "buddy", request_id: "action-1", reason: "timeout" },
      { event: "thread.removed", bot: "buddy", thread: "task-2" },
    ]);
  });

  it("tells a new attention item in Buddy's chat as it arrives", async () => {
    const { api, rt, events } = setup();
    serveShop(api);
    await rt.connect();
    serveShop(api, { attention: [attentionJson({ id: "att-2", eventType: "linear.issue.create", issueId: "issue-10" }), attentionJson()] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events).toEqual([{ event: "message", bot: "buddy", id: "attention:att-2", text: "A Linear issue was created (issue-10)." }]);
  });

  it("takes an ask out of Needs you as cancelled when its whole task is gone", async () => {
    const { api, rt, events } = setup();
    serveShop(api);
    await rt.connect();
    serveShop(api, { tasks: [] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(events).toEqual([
      { event: "prompt.expired", bot: "buddy", request_id: "action-1", reason: "cancelled" },
      { event: "thread.removed", bot: "buddy", thread: "task-1" },
    ]);
  });

  it("keeps showing the last read when a read fails while open, and when the API answers again closes and opens once with nothing to replay: the app reads everything again", async () => {
    const { api, rt, events, statuses, host } = setup();
    serveShop(api);
    await rt.connect();
    api.on("GET", "/v1/tenant/export", { status: 500, json: { error: "export_incomplete", failed: ["index"] } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.link).toBe("unavailable");
    // the last good read stands in for the shop, so the screens keep what they show (offline.test.ts)
    expect(rt.status).toBe("open");
    expect(statuses).toEqual(["connecting", "open"]);
    serveShop(api, { tasks: [taskJson({ actions: [actionJson({ id: "action-3" })] })] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rt.status).toBe("open");
    expect(statuses).toEqual(["connecting", "open", "closed", "open"]);
    expect(events).toEqual([]);
  });

  it("closes signed out when the API ends the session, and says so", async () => {
    const { api, rt, host, vault } = setup();
    serveShop(api);
    await rt.connect();
    api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(host.link).toBe("signed_out");
    expect(rt.status).toBe("closed");
    expect(vault.value).toBeNull();
    expect((await refusal(rt.request("bots.list", {})))?.code).toBe("signed_out");
  });
});

describe("closing", () => {
  it("stops reading once its last client closes", async () => {
    const { api, rt } = setup();
    serveShop(api);
    await rt.connect();
    rt.close();
    expect(rt.status).toBe("closed");
    expect((await refusal(rt.request("bots.list", {})))?.code).toBe("disconnected");
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(api.calls.length).toBe(before);
  });

  it("refuses a connect still waiting when its client closes", async () => {
    const { rt } = setup({ signedIn: false });
    const waiting = refusal(rt.connect());
    await settle();
    rt.close();
    expect((await waiting)?.code).toBe("disconnected");
  });
});
