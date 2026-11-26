// Every screen a shop's tasks reach on the connected runtime, for a shop the person owns and for the signed-in tenant of a
// person in no shop: the team, Mission Control's jobs and each job's page, History's rows and chips, each task's notes,
// the activity log, Needs you's asks and their words, Buddy's chat notes, the Automations page and each member's Schedule
// tab. The values in screens.export.json were taken from the runtime while it read every task from the shop's export,
// before it read the task list (docs/runtime-adapter.md, "A shop the person owns"), and are kept as they were taken: the
// list must show every screen as the export did, for the same shop. Never write that file again from the list's screens.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import type { Bot, BridgeEvent } from "../../lib/protocol";
import { jobLane, lanesPresent, threadLane } from "../../pages/history";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  actionJson,
  approvalJson,
  attentionJson,
  fakeApi,
  iso,
  memoryVault,
  ORIGIN,
  replyDetail,
  routineJson,
  scheduleJson,
  serveShop,
  serveShops,
  SHOP_A,
  SHOP_B,
  storedSession,
  T0,
  taskJson,
  workerTaskJson,
} from "./testkit";

/** What every screen showed while the runtime read the export, as JSON keeps it (numbers, strings, nulls). */
const FROM_THE_EXPORT = JSON.parse(readFileSync(new URL("./screens.export.json", import.meta.url), "utf8")) as { owned: unknown; ownTenant: unknown };

const NOW = T0 + 600_000;
const at = (seconds: number) => iso(T0 + seconds * 1000);
const sec = (seconds: number) => (T0 + seconds * 1000) / 1000;

/** A job Nam took up and passed to Pim, as the job flow leaves one: Nam's run claimed it, spent, wrote a first draft and
 *  passed it on; Pim's run claimed it, spent and wrote the newer draft. Between them the log holds entries no screen
 *  reads (a turn starting and ending, a draft being kept). */
function handedOver(tenant: string) {
  const [nam, pim] = ["handed-nam", "handed-pim"];
  const run = (id: string, executorId: string, claimed: number, finished: number) => ({ id, executorId, fence: `fence-${id}`,
    leaseUntil: sec(claimed + 300), inputRevision: "rev-1", maxSteps: 40, deadline: sec(claimed + 1200), status: "done",
    outcome: "done", finishedAt: sec(finished), steps: [{ id: "step-1", name: "read", status: "done" }] });
  return {
    task: { id: "worker-task-handed", title: "A reply to a customer", objective: "Draft a reply to a customer's message for the owner to read.",
      state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: at(256), tenantId: tenant, schema: 1, rev: 2 },
    events: [
      { seq: 1, kind: "created", at: at(199), rev: 1, via: "put" },
      { seq: 2, kind: "updated", at: at(200), rev: 2, via: `attempt:claim:${nam}` },
      { seq: 3, kind: "agent", at: at(201), rev: 2, attemptId: nam, event: { type: "turnStarted" } },
      { seq: 4, kind: "agent", at: at(203), rev: 2, attemptId: nam, event: { type: "spend", tokens: 300, model: "claude-haiku-5-5", costSatang: 12 } },
      { seq: 5, kind: "agent", at: at(205), rev: 2, attemptId: nam, event: { type: "handoffNote", to: "pim" } },
      { seq: 6, kind: "updated", at: at(206), rev: 2, via: `attempt:draft:${nam}` },
      { seq: 7, kind: "updated", at: at(240), rev: 2, via: `attempt:claim:${pim}` },
      { seq: 8, kind: "agent", at: at(250), rev: 2, attemptId: pim, event: { type: "spend", tokens: 500, model: "claude-haiku-5-5", costSatang: 20 } },
      { seq: 9, kind: "agent", at: at(255), rev: 2, attemptId: pim, event: { type: "turnEnded" } },
    ],
    eventFloor: 0,
    actions: [],
    attempts: [run(nam, "nam", 200, 206), run(pim, "pim", 240, 256)],
    attemptsTruncated: false,
    requests: [],
    drafts: [
      { attemptId: nam, member: "nam", job: "reply", text: "Nam's first go at it.", at: at(206) },
      { attemptId: pim, member: "pim", job: "reply", text: "Pim's reply, which is newer.", at: at(256) },
    ],
  };
}

/** Baan Mali's work, as its export carried it: Nam's reply drafted, Pim's post being written now, Ton's summary that
 *  failed on the budget, a job Nam passed to Pim, a LINE reply waiting for the owner, one that went out and an issue on its
 *  way; the routines' clocks and a schedule of the shop's own; one attention item; the team and its routines. */
function bannMali() {
  const tenant = SHOP_A.id;
  const mine = (v: ReturnType<typeof taskJson>) => ({ ...v, task: { ...v.task, tenantId: tenant } });
  return {
    tasks: [
      workerTaskJson({ id: "worker-task-nam", member: "nam", claimedAt: T0 + 60_000, draft: "Thank you! Your parcel left this morning." }),
      workerTaskJson({ id: "worker-task-pim", member: "pim", job: "post", title: "A post", claimedAt: NOW - 30_000, finishedAt: null, draft: null }),
      workerTaskJson({ id: "worker-task-ton", member: "ton", job: "daily_summary", title: "Sales summary for 2026-11-22", claimedAt: T0 + 120_000, outcome: "failed", reason: "budget", draft: null, costSatang: 0, tokens: 0 }),
      handedOver(tenant),
      mine(taskJson({ task: { id: "task-reply", title: "Reply to Khun Mali", updatedAt: at(95) },
        actions: [actionJson({ id: "a-reply", tenant, payload: { text: "We open at nine." }, proposedAt: at(90) })] })),
      mine(taskJson({ task: { id: "task-sent", title: "Reply to Khun Somchai", state: "completed", updatedAt: at(175) },
        actions: [actionJson({ id: "a-sent", tenant, payload: { text: "Your parcel is on its way." }, proposedAt: at(150), state: "confirmed",
          approval: { by: "owner-account-1", at: at(160) }, dispatch: { at: at(170) } })] })),
      mine(taskJson({ task: { id: "task-issue", title: "File the supplier's issue", state: "running", updatedAt: at(330) },
        actions: [actionJson({ id: "a-issue", tenant, operationType: "linear.issue.create", targetResourceId: "ws/shop",
          payload: { title: "Jasmine candles arrived broken" }, recipients: [], proposedAt: at(310), state: "dispatching",
          approval: { by: "owner-session", at: at(320) } })] })),
    ],
    schedules: [
      scheduleJson({ id: "clock-brief", name: "Morning brief", routineId: "rt-0001-brief" }),
      scheduleJson({ id: "sched-own", name: "Stock check", prompt: "Count the jasmine candles", hour: 18, minute: 0, weekdays: [1, 2, 3, 4, 5, 6, 7] }),
    ],
    attention: [attentionJson()],
    team: { paused: false, since: null, members: ["ton", "pim", "nam"] },
    routines: [
      routineJson(),
      routineJson({ id: "rt-0002-post", name: "Weekly post", action: "send", asksFirst: true, member: "pim", trigger: { kind: "weekly", weekdays: [1], at: "10:00" }, when: "Every Monday at 10:00" }),
    ],
  };
}

/** The signed-in tenant's own read, as before shops: a LINE reply waiting, an issue a worker asked for whose request
 *  carries no words of its own (its words are its action's), and a member's run with its draft. */
function ownTenant() {
  const tasks = [
    taskJson(),
    taskJson({ task: { id: "task-2", title: "Order more candles", state: "waitingForAuthorization", updatedAt: at(100) },
      actions: [actionJson({ id: "lin-1", operationType: "linear.issue.create", targetResourceId: "ws/shop", recipients: [],
        payload: { title: "Order more jasmine candles" }, proposedAt: at(95) })] }),
    { ...workerTaskJson({ id: "worker-task-own", member: "nam", claimedAt: T0 + 200_000, draft: "A draft for my own tenant." }), requests: [] },
  ];
  const approvals = [
    approvalJson({ id: "action-1", taskId: "task-1", createdAt: T0 + 90_000, detail: replyDetail("action-1") }),
    approvalJson({ id: "lin-1", taskId: "task-2", kind: "command", createdAt: T0 + 95_000, detail: { actionId: "lin-1", kind: "command" } }),
  ];
  return { tasks, approvals, schedules: [scheduleJson()], attention: [attentionJson()] };
}

type Req = (op: string, params?: unknown) => Promise<any>;

/** Every screen the shop's tasks reach, read through the app's protocol as the pages read them. */
async function screens(rt: HttpRuntime, events: BridgeEvent[]) {
  const req = rt.request.bind(rt) as unknown as Req;
  const refused = (p: Promise<unknown>) => p.then((v) => v, (e: { code?: string }) => ({ refused: e.code }));
  const bots = ((await req("bots.list")).bots as Bot[]).map((b) => ({ name: b.name, running: b.running, paused: b.paused ?? false }));
  const info: Record<string, unknown> = {};
  const schedule: Record<string, unknown> = {};
  for (const { name } of bots) {
    info[name] = await req("bots.info", { bot: name });
    // The export predates a routine's `time_zone` (the Automations page says it beside the time when it is not the computer's), so
    // each row is read without it here; view.test.ts holds that field.
    schedule[name] = (await req("routines.list", { bot: name })).routines.map(({ time_zone: _zone, ...rest }: { time_zone?: string }) => rest);
  }
  const { threads } = await req("thread.list", { bot: "buddy" });
  const notes: Record<string, unknown> = {};
  for (const row of threads) notes[row.thread] = (await req("thread.open", { bot: "buddy", thread: row.thread })).messages.map((m: { text: string; ts: number }) => [m.text, m.ts]);
  const { jobs } = await req("jobs.list");
  const pages: Record<string, unknown> = {};
  for (const job of jobs) pages[job.id] = await req("jobs.get", { job: job.id });
  // History lists a task that is also a job once, as the job (HistoryPage.tsx `threadsNotJobs`); its chips are the kinds
  // that have an entry.
  const who = { home: "buddy", kit: null };
  const jobIds = new Set(jobs.map((j: { id: string }) => j.id));
  const chips = lanesPresent([...threads.filter((r: { thread: string }) => !jobIds.has(r.thread)).map(() => threadLane("buddy", who)), ...jobs.map((j: { bot: string }) => jobLane(j.bot, who))]);
  const activity = await req("activity.list");
  const team = await refused(req("team.state"));
  events.length = 0;
  const chat = (await req("chat.open", { bot: "buddy" })).messages.map((m: { text: string; ts: number }) => [m.text, m.ts]);
  await vi.advanceTimersByTimeAsync(0);
  const asks = events
    .filter((e): e is Extract<BridgeEvent, { event: "approval.request" }> => e.event === "approval.request")
    .map(({ request_id, title, command, choices, kind }) => ({ request_id, title, command, choices, kind }));
  const automations = (await req("automations.list")).automations.map((a: { bot: string; id: string; name: string; schedule: string; paused: boolean; next_run_at: number | null }) => [a.bot, a.id, a.name, a.schedule, a.paused, a.next_run_at]);
  return { bots, info, schedule, threads, notes, jobs, pages, chips, activity, team, chat, asks, automations };
}

async function connected(serve: (api: ReturnType<typeof fakeApi>) => void) {
  const api = fakeApi();
  serve(api);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
  const rt = new HttpRuntime(new HttpHost({ session }));
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  await rt.connect();
  return { api, rt, events };
}

const ownedShop = () =>
  connected((api) =>
    serveShops(
      api,
      [SHOP_A, SHOP_B],
      {
        [SHOP_A.id]: [approvalJson({ id: "a-reply", taskId: "task-reply", createdAt: T0 + 90_000, detail: replyDetail("a-reply", "We open at nine.") })],
        [SHOP_B.id]: [approvalJson({ id: "b-reply", createdAt: T0 + 200_000, detail: replyDetail("b-reply", "Yes, we deliver.") })],
      },
      () => NOW,
      { [SHOP_A.id]: bannMali() },
    ),
  );

const signedInTenant = () => connected((api) => void serveShop(api, ownTenant()));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("every screen, as the export showed it", () => {
  it("for a shop the person owns", async () => {
    const { rt, events } = await ownedShop();
    expect(await screens(rt, events)).toEqual(FROM_THE_EXPORT.owned);
  });

  it("for the signed-in tenant of a person in no shop", async () => {
    const { rt, events } = await signedInTenant();
    expect(await screens(rt, events)).toEqual(FROM_THE_EXPORT.ownTenant);
  });
});
