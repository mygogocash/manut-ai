// What the connected runtime says to Mission Control's ops for the signed-in tenant, the read of a person in no shop. Its
// jobs and activity log are its tasks, as a shop's are (owned.test.ts has a shop the person owns). It has no team the API
// knows: the team's state is refused in words that fit a read, Pause everyone as every write is, and nothing is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { actionJson, fakeApi, iso, memoryVault, ORIGIN, serveShop, storedSession, T0, taskJson } from "./testkit";

const NOW = T0 + 600_000;

async function connected(over: Parameters<typeof serveShop>[1] = {}) {
  const api = fakeApi();
  serveShop(api, over);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), deviceId: () => "device-2" });
  const rt = new HttpRuntime(new HttpHost({ session }));
  await rt.connect();
  return { api, rt, req: rt.request.bind(rt) as unknown as (op: string, params: unknown) => Promise<any> };
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

describe("Mission Control for the signed-in tenant", () => {
  it("lists its tasks as Buddy's jobs: one waiting for the owner is proposed, one whose reply went out is sent", async () => {
    const sent = taskJson({
      task: { id: "task-2", title: "Reply to Khun Nok", state: "completed", updatedAt: iso(T0 + 400_000) },
      actions: [actionJson({ id: "action-2", state: "confirmed", approval: { by: "owner-session", at: iso(T0 + 300_000) }, dispatch: { at: iso(T0 + 301_000) } })],
    });
    const { req } = await connected({ tasks: [taskJson(), sent] });
    const { jobs } = await req("jobs.list", {});
    expect(jobs.map((j: { id: string; bot: string; stage: string }) => [j.id, j.bot, j.stage])).toEqual([
      ["task-2", "buddy", "sent"],
      ["task-1", "buddy", "proposed"],
    ]);
    const job = await req("jobs.get", { job: "task-2" });
    expect(job.steps.map((s: { stage: string; at: number }) => [s.stage, s.at])).toEqual([
      ["proposed", (T0 + 90_000) / 1000],
      ["approved", (T0 + 300_000) / 1000],
      ["sent", (T0 + 301_000) / 1000],
    ]);
    // no run reported a cost, so the job costs nothing it can say, and its trace is empty
    expect(job).toMatchObject({ costSatang: 0, tookSeconds: null, trace: [], recipients: [] });
  });

  it("logs a reply waiting for the owner and one that went out, the customer's words private", async () => {
    const sent = taskJson({
      task: { id: "task-2", title: "Reply to Khun Nok", state: "completed" },
      actions: [actionJson({ id: "action-2", state: "confirmed", payload: { text: "It left today." }, approval: { by: "owner-session", at: iso(T0 + 300_000) }, dispatch: { at: iso(T0 + 301_000) } })],
    });
    const { req } = await connected({ tasks: [taskJson(), sent] });
    const { events, keptMonths } = await req("activity.list", {});
    expect(keptMonths).toBeNull();
    expect(events.map((e: { id: string; status: string; title: string; approval: string }) => [e.id, e.status, e.title, e.approval])).toEqual([
      ["task-2:action-2", "sent", t("rt.ev.sentReply", { who: "Buddy" }), t("rt.ev.youApproved")],
      ["task-1:action-1", "needs_you", t("rt.ev.askReply", { who: "Buddy" }), t("rt.ev.waiting")],
    ]);
    expect(events[0]).toMatchObject({ kind: "msg", where: t("rt.ev.line"), undo: t("rt.ev.undoLine"), text: { body: "It left today.", private: true } });
    // the title never holds the customer's words: a hidden message cannot be found by them
    for (const e of events) expect(e.title).not.toMatch(/It left today|ships tomorrow/);
  });

  it("cannot show the team's state, which the API keeps for a shop and not for a person, and says so in words that fit a read", async () => {
    const { req } = await connected();
    expect(await refusal(req("team.state", {}))).toEqual({ code: "not_yet", message: t("rt.notYetShow") });
    // a read's refusal is not the write's: it must not say that Connected only reads
    expect(t("rt.notYetShow")).not.toMatch(/only reads/);
  });

  it("cannot pause or resume a team it is not told of, or change a schedule, and says so as every other write does", async () => {
    const { req } = await connected();
    for (const op of ["team.pause", "team.resume"]) expect(await refusal(req(op, {})), op).toEqual({ code: "not_yet", message: t("rt.notYet") });
    expect(await refusal(req("routine.pause", { routine: "sched-1" })), "routine.pause").toEqual({ code: "not_yet", message: t("rt.notYet") });
    expect(await refusal(req("automations.pause", { bot: "buddy", job: "sched-1" }))).toEqual({ code: "not_yet", message: t("rt.notYet") });
  });

  it("sends nothing to the API for any of them, and lists no member, paused or not", async () => {
    const { api, rt, req } = await connected();
    const sent = api.calls.length;
    for (const op of ["jobs.list", "jobs.get", "activity.list", "team.state", "team.pause", "team.resume", "routine.pause"]) await refusal(req(op, { job: "task-1", routine: "sched-1" }));
    expect(api.calls.slice(sent).every((c) => c.method === "GET")).toBe(true);
    const { bots } = await rt.request("bots.list", {});
    expect(bots.map((b) => b.name)).toEqual(["buddy"]);
    expect(bots.some((b) => b.paused)).toBe(false);
  });

  it("says the same in every language it is shown in, and says what Connected now changes", () => {
    for (const l of ["en", "ko", "ja", "zh"] as const) {
      expect(t("rt.notYetShow", undefined, l).trim()).not.toBe("");
      expect(t("rt.notYet", undefined, l).trim()).not.toBe("");
    }
    expect(t("rt.notYet", undefined, "en")).toMatch(/pauses your team’s routines and looks after Connections/);
  });
});
