// Mission Control's ops on the in-process runtime: the staged jobs, the activity log and Pause everyone. The pause is
// the one thing here that acts, so most of these tests are about what it stops, what it leaves waiting and what it
// never touches (what was sent stays sent).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "../../lib/protocol";
import { ACTIVITY_KINDS, OWNER } from "../mission";
import { MockHost, MockRuntime } from "./index";
import { ACTIVITY_KEPT_MONTHS, ACTIVITY_SEED, BOT_SEED, JOB_SEED, ROUTINE_SEED } from "./seed";

const T0 = 1_800_000_000;

/** A fresh runtime with its own clock, connected, and every event it sends. */
async function open() {
  const host = new MockHost({ now: () => T0 });
  const rt = new MockRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((e) => events.push(e));
  await rt.connect();
  return { rt, host, events, names: () => events.map((e) => e.event) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the staged jobs", () => {
  it("lists every job, newest first, each with who did it and where it stands", async () => {
    const { rt } = await open();
    const { jobs } = await rt.request("jobs.list", {});
    expect(jobs).toHaveLength(JOB_SEED.length);
    expect(jobs.map((j) => j.at)).toEqual([...jobs.map((j) => j.at)].sort((a, b) => b - a));
    for (const j of jobs) {
      expect(Object.keys(j).sort()).toEqual(["at", "bot", "id", "stage", "title"]);
      expect(BOT_SEED.some((b) => b.name === j.bot && !b.is_default), `${j.id} belongs to a team member`).toBe(true);
      expect(j.at).toBeLessThanOrEqual(T0);
    }
    expect(jobs.find((j) => j.title === "Replies about late parcels")).toMatchObject({ bot: "nam", stage: "checked" });
  });

  it("gives one job whole: its goal, timeline, what happened, who it went to, cost and trace", async () => {
    const { rt } = await open();
    const job = await rt.request("jobs.get", { job: "late-parcels" });
    expect(job).toMatchObject({
      id: "late-parcels",
      title: "Replies about late parcels",
      goal: "Reply to customers whose parcels are late.",
      bot: "nam",
      stage: "checked",
      costSatang: 120,
      tookSeconds: 40,
    });
    expect(job.steps.map((s) => s.stage)).toEqual(["proposed", "approved", "sent", "checked"]);
    expect(job.summary.length).toBeGreaterThan(0);
    expect(job.recipients.map((r) => [r.name, r.status])).toEqual([
      ["Khun Ploy", "read"],
      ["Khun Mint", "read"],
      ["Khun Tee", "delivered"],
    ]);
    expect(job.trace.map((s) => s.tool)).toEqual(["shopee.list_orders", "carrier.track × 3", "draft_reply", "approval.wait", "line.send × 3", "verify.delivery"]);
  });

  it("refuses a job it does not have", async () => {
    const { rt } = await open();
    await expect(rt.request("jobs.get", { job: "no-such-job" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.request("jobs.get", {} as { job: string })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("keeps its numbers whole: integer satang that add up, steps in order, a stage that is the last step's", async () => {
    const { rt } = await open();
    for (const row of (await rt.request("jobs.list", {})).jobs) {
      const job = await rt.request("jobs.get", { job: row.id });
      expect(Number.isInteger(job.costSatang) && job.costSatang >= 0, `${job.id} cost`).toBe(true);
      const parts = job.trace.map((s) => s.costSatang ?? 0);
      expect(parts.every((c) => Number.isInteger(c) && c >= 0), `${job.id} step costs`).toBe(true);
      expect(parts.reduce((a, b) => a + b, 0), `${job.id} cost is its steps' sum`).toBe(job.costSatang);
      const times = job.steps.map((s) => s.at);
      expect(times, `${job.id} timeline`).toEqual([...times].sort((a, b) => a - b));
      expect(job.steps.at(-1)?.stage, `${job.id} stage`).toBe(job.stage);
      expect(job.at, `${job.id} time`).toBe(job.steps.at(-1)?.at);
    }
  });

  it("stages work that is running and a request that waits on the owner, so every state of the page can be seen", async () => {
    const { rt } = await open();
    const stages = (await rt.request("jobs.list", {})).jobs.map((j) => j.stage);
    expect(stages).toEqual(expect.arrayContaining(["checked", "sent", "working", "proposed"]));
  });
});

describe("the staged activity log", () => {
  it("lists events newest first with the time, who, what, the item, who approved and how it ended", async () => {
    const { rt } = await open();
    const { events, keptMonths } = await rt.request("activity.list", {});
    expect(keptMonths).toBe(ACTIVITY_KEPT_MONTHS);
    expect(keptMonths).toBe(12);
    expect(events).toHaveLength(ACTIVITY_SEED.length);
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort((a, b) => b - a));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const members = new Set(BOT_SEED.map((b) => b.name));
    for (const e of events) {
      expect(e.at, e.id).toBeLessThanOrEqual(T0);
      expect(members.has(e.who) || e.who === OWNER, `${e.id} who`).toBe(true);
      expect(ACTIVITY_KINDS, `${e.id} kind`).toContain(e.kind);
      for (const field of [e.title, e.item, e.approval, e.where, e.undo]) expect(field.trim(), e.id).not.toBe("");
    }
  });

  it("stages every kind, an event with a private customer message and one with a public post", async () => {
    const { rt } = await open();
    const { events } = await rt.request("activity.list", {});
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(ACTIVITY_KINDS));
    expect(events.some((e) => e.text?.private === true)).toBe(true);
    expect(events.some((e) => e.text?.private === false)).toBe(true);
    expect(events.some((e) => e.who === OWNER)).toBe(true);
  });

  it("links an item to its job only when the item is one, and the job is there", async () => {
    const { rt } = await open();
    const { events } = await rt.request("activity.list", {});
    const linked = events.filter((e) => e.job !== null);
    expect(linked.length).toBeGreaterThan(0);
    for (const e of linked) await expect(rt.request("jobs.get", { job: e.job as string }), e.id).resolves.toMatchObject({ id: e.job });
  });
});

describe("Pause everyone", () => {
  it("starts unpaused, naming whom a pause stops, the routines that would wait and the jobs it would stop", async () => {
    const { rt } = await open();
    const state = await rt.request("team.state", {});
    expect(state).toMatchObject({ paused: false, since: null, members: ["nam", "pim", "ton", "kit"], routines: ROUTINE_SEED.length });
    expect(state.running.map((j) => j.id).sort()).toEqual(JOB_SEED.filter((j) => j.steps.at(-1)?.[0] === "working").map((j) => j.id).sort());
    // a job that is partly out says how much has gone: the replies that were sent and the ones still waiting
    expect(state.running.find((j) => j.id === "weekend-replies")).toMatchObject({ bot: "nam", out: { sent: 1, total: 3 } });
    // a draft sends nothing, so it has nothing to say about what went out
    expect(state.running.find((j) => j.id === "teaser-draft")).toMatchObject({ bot: "pim", out: null });
  });

  it("pauses the team: members are paused, Buddy is not, and the app is told to read the team again", async () => {
    const { rt, events } = await open();
    const state = await rt.request("team.pause", {});
    expect(state).toMatchObject({ paused: true, since: T0, members: ["nam", "pim", "ton", "kit"] });
    const { bots } = await rt.request("bots.list", {});
    expect(Object.fromEntries(bots.map((b) => [b.name, b.paused ?? false]))).toEqual({ buddy: false, nam: true, pim: true, ton: true, kit: true });
    expect(events.filter((e) => e.event === "bots.update")).not.toHaveLength(0);
    // what was running when it paused is what the page lists as "what was running"
    expect(state.running.map((j) => j.id)).toEqual(expect.arrayContaining(["weekend-replies", "teaser-draft"]));
  });

  it("stops a running turn of a member at once and leaves Buddy's turn alone", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "pim", text: "draft the post" });
    await rt.request("chat.send", { bot: "buddy", text: "what needs me today?" });
    await vi.advanceTimersByTimeAsync(500);
    await rt.request("team.pause", {});
    await vi.advanceTimersByTimeAsync(3_000);
    const ended = events.filter((e) => e.event === "turn.end").map((e) => [e.bot, e.event === "turn.end" ? e.outcome : null]);
    expect(ended).toEqual([
      ["pim", "interrupted"],
      ["buddy", "done"],
    ]);
    expect((await rt.request("bots.list", {})).bots.find((b) => b.name === "pim")?.running).toBe(false);
  });

  it("starts nothing new: a message to a paused member is refused and not kept, while Buddy still answers", async () => {
    const { rt, events } = await open();
    await rt.request("team.pause", {});
    const before = (await rt.request("chat.open", { bot: "nam" })).messages.length;
    await expect(rt.request("chat.send", { bot: "nam", text: "reply to Khun Mali" })).rejects.toMatchObject({ code: "paused" });
    expect((await rt.request("chat.open", { bot: "nam" })).messages).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.some((e) => e.event === "turn.start" && e.bot === "nam")).toBe(false);
    await rt.request("chat.send", { bot: "buddy", text: "why is everyone paused?" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.some((e) => e.event === "turn.end" && e.bot === "buddy")).toBe(true);
    // a thread of a paused member starts nothing either
    const raw = rt.request.bind(rt) as unknown as (op: string, params: unknown) => Promise<unknown>;
    await expect(raw("thread.create", { bot: "nam", title: "x" })).rejects.toMatchObject({ code: "paused" });
  });

  it("keeps a message that waited behind a stopped turn, and starts it only once everyone is back", async () => {
    const { rt, events } = await open();
    const starts = () => events.filter((e) => e.event === "turn.start" && e.bot === "pim").length;
    await rt.request("chat.send", { bot: "pim", text: "first" });
    await vi.advanceTimersByTimeAsync(200);
    await rt.request("chat.send", { bot: "pim", text: "second" });
    await rt.request("team.pause", {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts()).toBe(1);
    await rt.request("team.resume", {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts()).toBe(2);
  });

  it("leaves a request in Needs you waiting, answers none while paused, and keeps it for after", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "nam", text: "/approve" });
    await vi.advanceTimersByTimeAsync(400);
    const ask = events.find((e) => e.event === "approval.request");
    if (ask?.event !== "approval.request") throw new Error("no approval was asked");
    await rt.request("team.pause", {});
    await vi.advanceTimersByTimeAsync(60_000);
    // nothing expired, and the turn that waits on it did not end
    expect(events.some((e) => e.event === "prompt.expired")).toBe(false);
    expect(events.some((e) => e.event === "turn.end" && e.bot === "nam")).toBe(false);
    // while paused an answer is refused, so nothing is sent on the strength of it
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "once" })).rejects.toMatchObject({ code: "paused" });
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "deny" })).rejects.toMatchObject({ code: "paused" });
    expect(events.some((e) => e.event === "tool.start" && e.name === "send_reply")).toBe(false);
    // after Resume everyone it can still be answered, once
    await rt.request("team.resume", {});
    await rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "once" });
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "once" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("shows the jobs it stopped as paused, and takes the pause off them when everyone is back", async () => {
    const { rt } = await open();
    await rt.request("team.pause", {});
    const paused = await rt.request("jobs.get", { job: "weekend-replies" });
    expect(paused.stage).toBe("paused");
    expect(paused.steps.at(-1)).toEqual({ stage: "paused", at: T0 });
    expect((await rt.request("jobs.list", {})).jobs.find((j) => j.id === "weekend-replies")).toMatchObject({ stage: "paused", at: T0 });
    // a job that was not running is just as it was
    expect(await rt.request("jobs.get", { job: "late-parcels" })).toMatchObject({ stage: "checked" });
    await rt.request("team.resume", {});
    expect((await rt.request("jobs.get", { job: "weekend-replies" })).stage).toBe("working");
  });

  it("never unsends or changes what is done: the activity log and every chat are as they were", async () => {
    const { rt } = await open();
    const before = {
      activity: await rt.request("activity.list", {}),
      chats: await Promise.all(BOT_SEED.map((b) => rt.request("chat.open", { bot: b.name }))),
      done: await rt.request("jobs.get", { job: "late-parcels" }),
    };
    await rt.request("team.pause", {});
    await rt.request("team.resume", {});
    expect(await rt.request("activity.list", {})).toEqual(before.activity);
    expect(await Promise.all(BOT_SEED.map((b) => rt.request("chat.open", { bot: b.name })))).toEqual(before.chats);
    expect(await rt.request("jobs.get", { job: "late-parcels" })).toEqual(before.done);
  });

  it("pauses once: a second press keeps the first time", async () => {
    let now = T0;
    const host = new MockHost({ now: () => now });
    const rt = new MockRuntime(host);
    await rt.connect();
    await rt.request("team.pause", {});
    now += 600;
    expect(await rt.request("team.pause", {})).toMatchObject({ paused: true, since: T0 });
  });

  it("resumes everyone: nobody is paused, the app is told, and members can be given work again", async () => {
    const { rt, events } = await open();
    await rt.request("team.pause", {});
    events.length = 0;
    const state = await rt.request("team.resume", {});
    expect(state).toMatchObject({ paused: false, since: null });
    expect(events.filter((e) => e.event === "bots.update")).not.toHaveLength(0);
    expect((await rt.request("bots.list", {})).bots.some((b) => b.paused)).toBe(false);
    await rt.request("chat.send", { bot: "nam", text: "reply to Khun Mali" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.some((e) => e.event === "turn.end" && e.bot === "nam")).toBe(true);
    // resuming a team that is not paused changes nothing and does not fail
    expect(await rt.request("team.resume", {})).toMatchObject({ paused: false });
  });

  it("starts unpaused again after a reset", async () => {
    const { rt, host } = await open();
    await rt.request("team.pause", {});
    host.reset();
    expect(await rt.request("team.state", {})).toMatchObject({ paused: false, since: null });
  });
});
