// How one read of a shop shows in the app's own protocol: Buddy as the team, each task as one of Buddy's threads,
// each request waiting for an answer as an ask, each schedule as an automation.
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { decodeApprovals, type ShopApproval } from "./approvals";
import type { ShopAction, ShopSchedule, ShopSnapshot, ShopTask } from "./shop";
import { approvalJson, OPTIONS, type ApprovalOver } from "./testkit";
import { actionText, attentionRows, automationRows, cronOf, pendingAsks, stateText, taskOpen, team, TEAM, threadRows } from "./view";

const T0 = Date.UTC(2026, 10, 23, 1, 0, 0);

/** A request as the API lists it, decoded as a read decodes it. */
function approval(over: ApprovalOver = {}): ShopApproval {
  return decodeApprovals({ state: "open", approvals: [approvalJson(over)] }, [])[0];
}

function action(over: Partial<ShopAction> = {}): ShopAction {
  return {
    id: "action-1",
    taskId: "task-1",
    operationType: "line.message.push",
    targetResourceId: "bot-user-1",
    recipients: ["U1"],
    payload: { text: "Your order ships tomorrow morning." },
    state: "proposed",
    proposedAt: T0 + 90_000,
    expiresAt: T0 + 86_400_000,
    approvedAt: null,
    approvedBy: "",
    dispatchedAt: null,
    raw: {},
    ...over,
  };
}

function task(over: Partial<ShopTask> = {}): ShopTask {
  return {
    id: "task-1",
    title: "Reply to Khun Mali",
    objective: "Answer her question about delivery",
    state: "waitingForAuthorization",
    createdAt: T0,
    updatedAt: T0 + 120_000,
    actions: [action()],
    attempts: [],
    draft: null,
    raw: {},
    ...over,
  };
}

function schedule(over: Partial<ShopSchedule> = {}): ShopSchedule {
  return {
    id: "sched-1",
    name: "Morning brief",
    prompt: "Tell me what came in overnight",
    hour: 8,
    minute: 30,
    weekdays: [2, 3, 4, 5, 6],
    timeZone: "Asia/Bangkok",
    enabled: true,
    revision: 1,
    nextFire: T0 + 3600_000,
    createdAt: T0 - 86_400_000,
    raw: {},
    ...over,
  };
}

function snap(over: Partial<ShopSnapshot> = {}): ShopSnapshot {
  return { tasks: [task()], approvals: [approval()], schedules: [schedule()], attention: [], attentionOff: false, unreadable: [], readAt: T0 + 600_000, ...over };
}

afterEach(() => setLang("en"));

describe("the team", () => {
  it("is Buddy alone, working while a task is", () => {
    setLang("en");
    expect(team(snap())).toEqual([
      { name: TEAM, display_name: "Buddy", is_default: true, description: "", status: "online", running: false, model: "", provider: "", avatar_rev: null },
    ]);
    expect(team(snap({ tasks: [task({ state: "running" })] }))[0].running).toBe(true);
    expect(team(snap({ tasks: [task({ state: "verifying" })] }))[0].running).toBe(true);
    expect(team(null)[0]).toMatchObject({ status: "offline", running: false });
  });
});

describe("tasks as Buddy's threads", () => {
  it("lists every task, newest activity first, marking the ones that wait for the owner", () => {
    const older = task({ id: "task-0", title: "", objective: "", state: "completed", createdAt: T0 - 7200_000, updatedAt: T0 - 3600_000, actions: [] });
    expect(threadRows(snap({ tasks: [older, task()] }))).toEqual([
      {
        thread: "task-1",
        title: "Reply to Khun Mali",
        cwd: "",
        started_at: T0 / 1000,
        last: (T0 + 120_000) / 1000,
        running: false,
        needs: true,
        message_count: 3,
        preview: "Answer her question about delivery",
      },
      { thread: "task-0", title: "Untitled task", cwd: "", started_at: (T0 - 7200_000) / 1000, last: (T0 - 3600_000) / 1000, running: false, needs: false, message_count: 2, preview: "" },
    ]);
  });

  it("marks a task as waiting for the owner by its requests, not by the actions its task lists as proposed", () => {
    expect(threadRows(snap({ approvals: [] }))[0].needs).toBe(false);
    expect(threadRows(snap({ tasks: [task({ actions: [] })] }))[0].needs).toBe(true);
    // a request this build cannot answer still waits for someone
    expect(threadRows(snap({ approvals: [approval({ kind: "refund_partial" })] }))[0].needs).toBe(true);
  });

  it("opens a task as Buddy's notes: what it is for, what it asked, and where it stands", () => {
    const decided = action({ id: "action-0", state: "confirmed", proposedAt: T0 + 30_000, payload: { text: "Thanks!" } });
    const open = taskOpen(task({ actions: [action(), decided] }));
    expect(open).toMatchObject({ thread: "task-1", session_id: "task-1", title: "Reply to Khun Mali", cwd: "", running: false });
    expect(open.messages.map((m) => [m.role, m.text, m.ts])).toEqual([
      ["assistant", "**Reply to Khun Mali**\n\nAnswer her question about delivery", T0 / 1000],
      ["assistant", "Send on LINE: “Thanks!” (sent)", (T0 + 30_000) / 1000],
      ["assistant", "Send on LINE: “Your order ships tomorrow morning.” (waiting for you)", (T0 + 90_000) / 1000],
      ["assistant", "Now: waiting for your approval", (T0 + 120_000) / 1000],
    ]);
  });

  it("speaks the app's language", () => {
    setLang("ko");
    expect(stateText("running")).toBe("작업 중");
    expect(taskOpen(task()).messages.at(-1)?.text).toBe("지금: 승인을 기다리는 중");
  });

  it("keeps a state it does not know as the API wrote it", () => {
    expect(stateText("waitingForWeather")).toBe("waitingForWeather");
    expect(taskOpen(task({ state: "waitingForWeather", actions: [action({ state: "superseded" })] })).messages.map((m) => m.text).slice(1)).toEqual([
      "Send on LINE: “Your order ships tomorrow morning.” (superseded)",
      "Now: waitingForWeather",
    ]);
  });
});

describe("what waits for the owner", () => {
  it("is each open request, asked as the exact action at the revision shown, answered once or not at all", () => {
    expect(pendingAsks(snap())).toEqual([
      {
        event: "approval.request",
        bot: TEAM,
        request_id: "action-1@1",
        title: "Reply to Khun Mali",
        command: "Send on LINE: “Your order ships tomorrow morning.”",
        choices: ["once", "deny"],
        kind: "reply",
      },
    ]);
  });

  it("says each request's approval-core kind as text, and a kind it does not know as the API wrote it", () => {
    // what a notification may offer depends on the kind (notify-rules): Approve for a message or a reply only
    for (const kind of ["message", "reply", "money", "public_post", "payment_confirmation", "command"]) {
      expect(pendingAsks(snap({ approvals: [approval({ kind })] })).map((a) => a.kind), kind).toEqual([kind]);
    }
    expect(pendingAsks(snap({ approvals: [approval({ kind: "refund_partial", detail: {} })] })).map((a) => a.kind)).toEqual(["refund_partial"]);
  });

  it("is never an action a task lists as proposed with no request to decide it: that is not the owner's to answer here", () => {
    expect(pendingAsks(snap({ approvals: [] }))).toEqual([]);
  });

  it("names a worker's command by its action's words, which its request does not carry", () => {
    const issue = action({ id: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payload: { title: "Restock jasmine gift sets" } });
    const asked = approval({ id: "req-7", kind: "command", attemptId: "attempt-2", detail: { actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payloadHash: "h" } });
    expect(pendingAsks(snap({ tasks: [task({ actions: [issue] })], approvals: [asked] }))).toEqual([
      expect.objectContaining({ request_id: "req-7@1", command: "Create a Linear issue: “Restock jasmine gift sets”", choices: ["once", "deny"] }),
    ]);
    // with no action to read the words from, it says what the request names
    expect(pendingAsks(snap({ tasks: [], approvals: [asked] }))).toEqual([expect.objectContaining({ title: "", command: "linear.issue.create on project-1" })]);
  });

  it("asks a request of a kind this build does not know, and offers no answer: update the app to answer it", () => {
    const refund = approval({ id: "req-9", kind: "refund_partial", detail: {} });
    expect(pendingAsks(snap({ approvals: [refund] }))).toEqual([
      { event: "approval.request", bot: TEAM, request_id: "req-9@1", title: "Reply to Khun Mali", command: "refund_partial", choices: [], outdated: true, kind: "refund_partial" },
    ]);
    const unknownState = approval({ standing: { state: "paused_by_owner" } });
    expect(pendingAsks(snap({ approvals: [unknownState] }))).toEqual([expect.objectContaining({ request_id: "action-1@1", choices: [], outdated: true })]);
    const snooze = approval({ options: [...OPTIONS, { id: "later", label: "Later", effect: "snooze" }] });
    expect(pendingAsks(snap({ approvals: [snooze] }))).toEqual([expect.objectContaining({ choices: [], outdated: true })]);
  });

  it("does not ask what is no longer waiting", () => {
    const decided = approval({ standing: { state: "decided", reason: "decided", decision: { requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "owner-link", role: "owner", decidedAt: T0 } } });
    const expired = approval({ standing: { state: "expired", reason: "expired", expiredAt: T0 } });
    expect(pendingAsks(snap({ approvals: [decided, expired] }))).toEqual([]);
  });

  it("asks the oldest first, as they were asked", () => {
    const later = approval({ id: "action-2", createdAt: T0 + 200_000, detail: { operationType: "line.message.push", text: "Second" } });
    const first = approval({ id: "action-3", createdAt: T0 + 100_000, detail: { operationType: "line.message.push", text: "First" } });
    expect(pendingAsks(snap({ tasks: [], approvals: [later, first] })).map((a) => a.command)).toEqual(["Send on LINE: “First”", "Send on LINE: “Second”"]);
  });

  it("names every kind of action, and one it does not know by what the API calls it", () => {
    expect(actionText(action({ operationType: "linear.issue.create", payload: { title: "Fix the scale" } }))).toBe("Create a Linear issue: “Fix the scale”");
    expect(actionText(action({ operationType: "shopee.price.set", targetResourceId: "item-9" }))).toBe("shopee.price.set on item-9");
  });

  it("tells the attention items in Buddy's chat, oldest first, by what changed and where", () => {
    const rows = attentionRows(
      snap({
        attention: [
          { id: "b", connectionId: "c", eventType: "linear.issue.remove", issueId: "ISS-2", receivedAt: T0 + 60_000, raw: {} },
          { id: "a", connectionId: "c", eventType: "linear.issue.create", issueId: "ISS-1", receivedAt: T0, raw: {} },
          { id: "z", connectionId: "c", eventType: "shopee.order.create", issueId: "order-3", receivedAt: null, raw: {} },
        ],
      }),
    );
    expect(rows.map((m) => [m.id, m.role, m.text, m.ts])).toEqual([
      ["attention:a", "assistant", "A Linear issue was created (ISS-1).", T0 / 1000],
      ["attention:b", "assistant", "A Linear issue was removed (ISS-2).", (T0 + 60_000) / 1000],
      ["attention:z", "assistant", "shopee.order.create (order-3).", (T0 + 600_000) / 1000],
    ]);
  });
});

describe("schedules as automations", () => {
  it("writes each schedule's days and time in cron, the shape the Automations page reads", () => {
    expect(cronOf(schedule())).toBe("30 8 * * 1-5");
    expect(cronOf(schedule({ weekdays: [1, 2, 3, 4, 5, 6, 7] }))).toBe("30 8 * * *");
    expect(cronOf(schedule({ weekdays: [1] }))).toBe("30 8 * * 0");
    expect(cronOf(schedule({ weekdays: [7, 2, 4] }))).toBe("30 8 * * 1,3,6");
    expect(cronOf(schedule({ hour: null }))).toBe("");
  });

  it("lists each one under Buddy, paused when it is off, its next run in seconds", () => {
    expect(automationRows(snap({ schedules: [schedule(), schedule({ id: "sched-2", enabled: false, nextFire: null, createdAt: null })] }))).toEqual([
      {
        id: "sched-1",
        name: "Morning brief",
        schedule: "30 8 * * 1-5",
        next_run_at: (T0 + 3600_000) / 1000,
        last_run_at: null,
        last_status: null,
        enabled: true,
        time_zone: "Asia/Bangkok",
        bot: TEAM,
        paused: false,
        prompt: "Tell me what came in overnight",
        script: null,
        deliver: "",
        origin: null,
        created_at: (T0 - 86_400_000) / 1000,
        last_error: null,
        repeat: { times: null, completed: 0 },
      },
      expect.objectContaining({ id: "sched-2", enabled: false, paused: true, next_run_at: null, created_at: null }),
    ]);
  });
});
