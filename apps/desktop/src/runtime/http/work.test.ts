// How a task reads as a job, and a run as a member's work (work.ts, view.ts), as apps/api's own jobs list reads them
// (workers.ts `jobOf`, `endingOf`): the member whose run has the job now, where it stands, and what its timing says.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import type { ShopAttempt, ShopSnapshot, ShopTask, TeamRoutine } from "./shop";
import { routineSchedule, memberOf, taskRunning } from "./view";
import { jobOf, stageOf, teamStateOf } from "./work";

const T = Date.UTC(2026, 10, 24, 3, 0, 0);

function attempt(over: Partial<ShopAttempt> = {}): ShopAttempt {
  return {
    id: "a1",
    executor: "nam",
    status: "done",
    outcome: "done",
    reason: "",
    claimedAt: T - 10_000,
    finishedAt: T - 6_000,
    deadline: T + 1_200_000,
    leaseUntil: T + 300_000,
    handedTo: null,
    costSatang: 38,
    tokens: 640,
    model: "claude-haiku-5-5",
    ...over,
  };
}

function task(over: Partial<ShopTask> = {}): ShopTask {
  return { id: "t1", title: "A reply to a customer", objective: "Draft a reply.", state: "draft", createdAt: T - 20_000, updatedAt: T - 10_000, actions: [], attempts: [attempt()], draft: null, raw: null, ...over };
}

const snap = (tasks: ShopTask[], over: Partial<ShopSnapshot> = {}): ShopSnapshot => ({ tasks, approvals: [], schedules: [], attention: [], attentionOff: false, unreadable: [], readAt: T, ...over });

beforeEach(() => setLang("en"));

describe("a task's member", () => {
  it("is the one whose run has it now, the newest claimed, and Buddy for a task no member ran", () => {
    expect(memberOf(task())).toBe("nam");
    // passed on and taken up: the member it went to
    expect(memberOf(task({ attempts: [attempt({ handedTo: "pim" }), attempt({ id: "a2", executor: "pim" })] }))).toBe("pim");
    expect(memberOf(task({ attempts: [] }))).toBe("buddy");
    // an executor that is not one of the team is not a member
    expect(memberOf(task({ attempts: [attempt({ executor: "stand-in" })] }))).toBe("buddy");
  });

  it("is working while its run can still act, and not once the run's deadline or report-by time has passed", () => {
    const live = attempt({ status: "active", outcome: "", finishedAt: null });
    expect(taskRunning(task({ attempts: [live] }), T)).toBe(true);
    expect(taskRunning(task({ attempts: [{ ...live, deadline: T - 1 }] }), T)).toBe(false);
    expect(taskRunning(task({ attempts: [{ ...live, leaseUntil: T - 1 }] }), T)).toBe(false);
    expect(taskRunning(task({ attempts: [], state: "running" }), T)).toBe(true);
  });
});

describe("where a job stands", () => {
  it("reads a member's run as the API's jobs list does", () => {
    expect(stageOf(task({ draft: { member: "nam", job: "reply", text: "Hi", at: T - 6_000 } }), false, T)).toBe("drafted");
    // done with nothing to write: it checked and found nothing
    expect(stageOf(task(), false, T)).toBe("checked");
    expect(stageOf(task({ attempts: [attempt({ outcome: "failed", reason: "budget" })] }), false, T)).toBe("failed");
    expect(stageOf(task({ attempts: [attempt({ outcome: "cancelled" })] }), false, T)).toBe("cancelled");
    // an active run past its deadline can no longer act: the sweep will fail it
    expect(stageOf(task({ attempts: [attempt({ status: "active", outcome: "", finishedAt: null, deadline: T - 1 })] }), false, T)).toBe("failed");
    // a finished run with no outcome kept is never read as a success
    expect(stageOf(task({ attempts: [attempt({ outcome: "" })] }), false, T)).toBe("failed");
    // passed on, not taken up yet
    expect(stageOf(task({ attempts: [attempt({ handedTo: "pim" })] }), false, T)).toBe("working");
  });

  it("puts waiting for the owner first, and a run that stopped to ask where its action settled once it was answered", () => {
    const asked = attempt({ outcome: "awaiting_owner" });
    const action = { id: "x1", taskId: "t1", operationType: "line.message.push", targetResourceId: "bot", recipients: [], payload: {}, state: "proposed", proposedAt: T - 9_000, expiresAt: T + 60_000, approvedAt: null, approvedBy: "", dispatchedAt: null, raw: null };
    expect(stageOf(task({ attempts: [asked], actions: [action] }), true, T)).toBe("proposed");
    expect(stageOf(task({ attempts: [asked], actions: [{ ...action, state: "confirmed" }] }), false, T)).toBe("sent");
    // the request left with no answer (expired, withdrawn): nothing went out
    expect(stageOf(task({ attempts: [asked], actions: [{ ...action, state: "expired" }] }), false, T)).toBe("cancelled");
    expect(stageOf(task({ attempts: [asked], actions: [] }), false, T)).toBe("cancelled");
  });

  it("gives a run no time it does not know, and a job that is still running no total time", () => {
    const job = jobOf(snap([task({ attempts: [attempt({ claimedAt: null })] })]), "t1");
    expect(job?.trace[0].ms).toBe(-1);
    expect(job?.tookSeconds).toBeNull();
    const running = jobOf(snap([task({ attempts: [attempt({ status: "active", outcome: "", finishedAt: null })] })]), "t1");
    expect(running).toMatchObject({ stage: "working", tookSeconds: null });
    expect(running?.trace[0]).toMatchObject({ result: "running", ms: 10_000 });
  });
});

describe("the team's state", () => {
  it("is none for a read with no team, and counts the routines a pause would hold", () => {
    expect(teamStateOf(snap([]))).toBeNull();
    const routine = (id: string, paused: boolean): TeamRoutine => ({ id, name: id, action: "brief", member: "ton", when: "", timeZone: "Asia/Bangkok", asksFirst: false, paused, next: null, trigger: null });
    const state = teamStateOf(snap([], { team: { paused: true, since: T - 60_000, members: ["ton"] }, routines: [routine("r1", false), routine("r2", true)] }));
    expect(state).toEqual({ paused: true, since: (T - 60_000) / 1000, members: ["ton"], routines: 1, running: [], holds: "routines" });
  });
});

describe("a routine's timing on a member's Schedule tab", () => {
  const routine = (trigger: unknown, when = "As the API says it"): TeamRoutine => ({ id: "r", name: "r", action: "brief", member: "ton", when, timeZone: "Asia/Bangkok", asksFirst: false, paused: false, next: null, trigger });

  it("is cron where the tab says that shape in the app's language, else the API's own words", () => {
    expect(routineSchedule(routine({ kind: "daily", at: "08:00" }))).toBe("0 8 * * *");
    expect(routineSchedule(routine({ kind: "weekly", weekdays: [1, 2, 3, 4, 5], at: "09:30" }))).toBe("30 9 * * 1-5");
    expect(routineSchedule(routine({ kind: "weekly", weekdays: [0], at: "10:00" }))).toBe("0 10 * * 0");
    expect(routineSchedule(routine({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], at: "07:05" }))).toBe("5 7 * * *");
    expect(routineSchedule(routine({ kind: "monthly", day: 15, at: "18:00" }))).toBe("0 18 15 * *");
    for (const trigger of [{ kind: "monthly", day: "last", at: "18:00" }, { kind: "weekly", weekdays: [1, 3], at: "10:00" }, { kind: "window", from: "21:00", to: "08:00" }, { kind: "stockBelow", threshold: 5 }, null])
      expect(routineSchedule(routine(trigger))).toBe("As the API says it");
  });
});
