// Running helper lanes (item 102h; `docs/several-agents.md`, "4. Helper lanes a lane asks for", rules R2, R3, R5, R6 and R7). Kept
// by the sessions store (`sessions/sessions.ts`), which hands this its sessions' records, their chats' state and the ways to start,
// stop and write to a lane. It listens on item 102e's hand-off (`whenRoundApproved`): for each round the person approved with Start
// helpers, it starts the round's helper lanes one by one as item 102d's rules allow (`startNext`, the cap from this Mac's memory),
// drives each helper's budget from its chat's events and a clock (`newBudget`, `budgetDue`), takes the person's Stop on a row or for
// the whole round, records each helper as it comes back (`recordBack`), and ends a helper's idle agent process once its round is done.
//
// What it never does: start a helper lane without the person's Start helpers (it only acts on an approved round), start one in a
// mode that skips asks (the sessions store starts each in its agent's Ask mode, and the shell refuses an agent whose own settings
// would skip asks), or answer, withdraw or outrun a helper's ask. The budget's clock stands still while an ask or a question of the
// helper waits, nothing is due then, and nothing here calls `settleApproval`: a helper's asks are its own cards, which only the
// person answers. A stop is only ever the budget's or the person's press, never anything an agent wrote.
//
// Where a helper reports, the typed hand-off `whenBack` tells items 102i (landing its work) and 102j (the reports to the lead): its
// report is bound to its round and its place in it, its landing "pending" until 102i settles it.
import { t as tr } from "../i18n";
import type { AccountGroup } from "../lib/protocol";
import { agentDef, type SessionRec } from "../sessions/agents";
import type { ChatEvent } from "../sessions/host";
import { steersOf } from "../sessions/controls";
import { agentLimit } from "./ask";
import { helperBrief } from "./helperBrief";
import { helperReply } from "./helperBlocks";
import type { HelperRow } from "./helperAsks";
import type { HelperRoundApproved } from "./leadLanes";
import {
  agentsAtOnce,
  BUDGET,
  budgetAskOpened,
  budgetAskSettled,
  budgetChanged,
  budgetDone,
  budgetDue,
  budgetSpent,
  budgetStep,
  dropWaiting,
  failureKindOf,
  newBudget,
  recordBack,
  startNext,
  type Budget,
  type Ended,
  type FailureKind,
  type HelperReport,
  type Rounds,
} from "./rules";

/** Where one helper lane of a round is. `waiting`: queued behind this Mac's cap; `starting`: its folder is being made and its agent
 *  started; `running`: its agent runs (working, waiting on the person, or idle); `back`: it reported; `notStarted`: it never got to
 *  try (an agent that is not here, a limited account, a refused folder or start); `dropped`: it never started because the breaker
 *  tripped or the person stopped it while it waited. */
export type RunState = "waiting" | "starting" | "running" | "back" | "notStarted" | "dropped";

/** One helper lane of a round, as the Helpers card draws it. */
export interface HelperRun {
  readonly lead: string;
  readonly round: string;
  /** its place in its round, from 0: Helper 1 is 0 */
  readonly index: number;
  readonly row: HelperRow;
  readonly state: RunState;
  /** its lane's session, once it has one */
  readonly session?: string;
  /** why it did not start, in the person's words */
  readonly why?: string;
  /** who kept it from starting */
  readonly dropped?: "breaker" | "person";
  /** what it reported, once back */
  readonly report?: HelperReport;
  /** the person pressed Stop and the stop has not landed yet */
  readonly stopping?: boolean;
  /** its idle agent process was ended once its round was done; its chat and folder stay */
  readonly ended?: boolean;
}

/** A helper lane came back (item 102h's hand-off to 102i and 102j): its report, bound to its round and its place, and whether item
 *  102d's rules kept it for the lead (`kept`: false for a late report of a round already handed over). */
export interface HelperBack {
  readonly lead: string;
  readonly round: string;
  readonly index: number;
  /** its lane's session; null when it never started */
  readonly session: string | null;
  readonly report: HelperReport;
  readonly kept: boolean;
}

/** What starting one helper lane takes (the sessions store's `startHelperLane`). */
export interface StartHelper {
  readonly lead: string;
  readonly job: string;
  readonly round: string;
  readonly index: number;
  readonly row: HelperRow;
  /** its first message: the brief with its mark (`helperBrief`) */
  readonly first: string;
  /** hears the new session's id before its agent starts, so no event of its first turn is missed */
  readonly made: (id: string) => void;
}

/** What the runs need from the sessions store. */
export interface RunDeps {
  rec(id: string): SessionRec | undefined;
  /** the ids of the asks and questions of session `id`'s chat that wait on the person */
  asks(id: string): string[];
  /** a turn of session `id` runs now */
  working(id: string): boolean;
  /** the last answer session `id`'s agent wrote, whole ("" when none) */
  lastAnswer(id: string): string;
  /** the lane's title as its row shows it */
  title(id: string): string;
  /** lanes of Ask several (item 102a) whose turn runs now: they count against this Mac's cap too (R7) */
  othersRunning(): number;
  rounds(lead: string): Rounds<HelperRow>;
  setRounds(lead: string, r: Rounds<HelperRow>): void;
  /** this Mac's memory in bytes, read once by the shell; null when it could not be read */
  memory(): Promise<number | null>;
  groups(): readonly AccountGroup[] | null;
  /** a job's id the shell takes (one plain word) */
  freshJob(): string;
  startLane(p: StartHelper): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  /** the chat's own Stop */
  interrupt(id: string): Promise<void>;
  /** text handed to the running turn (only agents that take a steer) */
  steer(id: string, text: string): Promise<void>;
  /** a message sent to the lane's agent as the person's would be */
  send(id: string, text: string): Promise<boolean>;
  /** the lane's agent process ends while it is idle; its chat stays */
  endIdle(id: string): Promise<boolean>;
  /** one quiet line in session `id`'s chat */
  note(id: string, text: string): void;
  now(): number;
  /** calls `fn` every `ms` until the returned function is called */
  every(ms: number, fn: () => void): () => void;
}

/** A round with no runs here, always the same value, so a view that reads it does not draw again for nothing. */
const NONE: readonly HelperRun[] = [];

/** How often the budget's clock is read while a helper works. A stop may come up to this late, never early. */
export const TICK_MS = 2_000;

/** What the runtime keeps of a running helper lane beside what the card shows. */
interface Live {
  budget: Budget | null;
  /** the stop that is under way: the budget's (its report follows) or the person's */
  stop: "budget" | "person" | null;
  /** the budget's stop landed and its one message went: the turn it starts is the report's */
  reportTurn: boolean;
  /** a subagent's steps already counted, as `<id>\0<step>` */
  subSteps: Set<string>;
}

export function createHelperRuns(deps: RunDeps) {
  /** every run, by round, in helper order */
  const runs = new Map<string, HelperRun[]>();
  /** the leads with rounds, in the order their first round was approved */
  const leads: string[] = [];
  const bySession = new Map<string, { round: string; index: number }>();
  const live = new Map<string, Live>();
  const jobs = new Map<string, string>();
  const backs = new Set<(b: HelperBack) => void>();
  const listeners = new Set<() => void>();
  let memory: Promise<number | null> | null = null;
  let atOnce: number | null = null;
  let stopTimer: (() => void) | null = null;
  /** Helper lanes are made one after the other, so two never ask the shell for the same branch name at once (as `startJob` does). */
  let making: Promise<unknown> = Promise.resolve();
  let snap: Record<string, readonly HelperRun[]> = {};

  const emit = () => {
    snap = Object.fromEntries([...runs].map(([k, v]) => [k, [...v]]));
    for (const l of [...listeners]) l();
  };
  const runAt = (round: string, index: number) => runs.get(round)?.[index];
  const patch = (round: string, index: number, p: Partial<HelperRun>) => {
    const list = runs.get(round);
    if (!list?.[index]) return;
    list[index] = { ...list[index], ...p };
    emit();
  };
  const runOf = (session: string) => {
    const at = bySession.get(session);
    return at ? runAt(at.round, at.index) : undefined;
  };

  /** This Mac's cap, read once (R7): the shell's memory read, which a failed read counts as the smallest Mac. */
  const cap = async (): Promise<number> => {
    memory ??= deps.memory().catch(() => null);
    const n = agentsAtOnce(await memory);
    if (atOnce !== n) {
      atOnce = n;
      emit();
    }
    return n;
  };
  /** How many agents of this design run now: every helper out in a round, across every lead, and Ask several's working lanes. */
  const running = () => leads.reduce((n, lead) => n + deps.rounds(lead).rounds.reduce((m, r) => m + r.out.length, 0), 0) + deps.othersRunning();

  /** The lead's helper lanes share one job, saved with each, so a restart keeps them together. */
  const jobOf = (lead: string): string => {
    let job = jobs.get(lead);
    if (!job) {
      job = deps.freshJob();
      jobs.set(lead, job);
    }
    return job;
  };

  /** Runs still `waiting` that the rules no longer hold were dropped: by the breaker when it tripped, else by the person's Stop. */
  const markDropped = (lead: string, breaker: boolean) => {
    const r = deps.rounds(lead);
    for (const [round, list] of runs) {
      for (const run of list) {
        if (run.lead !== lead || run.state !== "waiting") continue;
        if (r.waiting.some((w) => w.round === round && w.index === run.index)) continue;
        patch(round, run.index, { state: "dropped", dropped: breaker ? "breaker" : "person" });
      }
    }
  };

  /** A round is done once none of its helpers waits, starts or runs unreported: each idle agent process of it ends then, as Buddy
   *  closes its idle processes (R7). A helper still working, with work running in the background, or whose ask still waits on the
   *  person, is left alone. */
  const endIdleOf = (round: string) => {
    const list = runs.get(round) ?? [];
    if (list.some((r) => r.state === "waiting" || r.state === "starting" || r.state === "running")) return;
    for (const run of list) {
      const id = run.session;
      // work its agent says still runs in the background after its turn (a subagent) keeps it, as an open ask does
      if (!id || run.ended || run.state !== "back" || deps.working(id) || deps.asks(id).length || (deps.rec(id)?.background ?? 0) > 0) continue;
      patch(round, run.index, { ended: true });
      void deps.endIdle(id);
    }
  };

  /** Helper `run` is back with its report: the rules keep it for the lead, a breaker that trips drops the round's waiting helpers,
   *  102i and 102j hear of it, the next waiting helper may start, and a round that is done ends its idle processes. */
  const back = (run: HelperRun, report: Omit<HelperReport, "round" | "index" | "title">, state: RunState = "back", why?: string) => {
    const full: HelperReport = { round: run.round, index: run.index, title: run.row.title, ...report };
    const recorded = recordBack(deps.rounds(run.lead), full);
    deps.setRounds(run.lead, recorded.rounds);
    patch(run.round, run.index, { state, report: full, stopping: false, ...(why ? { why } : {}) });
    markDropped(run.lead, recorded.rounds.breakerTripped);
    const b: HelperBack = { lead: run.lead, round: run.round, index: run.index, session: run.session ?? null, report: full, kept: recorded.kept };
    for (const l of [...backs]) l(b);
    endIdleOf(run.round);
    void pump();
    idleTimer();
  };

  /** It never got to try (R6): counted as trouble that is not the task, so two in a row stop the round. */
  const couldNotRun = (run: HelperRun, why: string) => back(run, { ended: "failed", words: why, failure: "infra", landing: null }, "notStarted", why);

  /** Why a helper lane will not start, from what the app knows before it tries. */
  const notStartable = (row: HelperRow): string | null => {
    if (row.problem === "unknown") return tr("helpers.run.why.unknown", { name: row.asked ?? row.agent });
    if (row.problem === "notInstalled") return tr("helpers.run.why.notInstalled", { agent: agentDef(row.agent).label });
    const limit = agentLimit(deps.groups(), row.agent as never);
    if (limit) {
      return limit.until
        ? tr("helpers.run.why.limitedUntil", { agent: agentDef(row.agent).label, time: new Date(limit.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
        : tr("helpers.run.why.limited", { agent: agentDef(row.agent).label });
    }
    return null;
  };

  /** Starts the helper the rules took out of the queue: its folder from the lead's snapshot, then its agent in its Ask mode with its
   *  brief as the first message (the sessions store's `startHelperLane`). Anything that keeps it from trying is `couldNotRun`. */
  const launch = async (lead: string, round: string, index: number) => {
    const run = runAt(round, index);
    if (!run) return;
    // the person pressed Stop before its turn to be made came: it never starts
    if (run.stopping) {
      patch(round, index, { dropped: "person" });
      return back(run, { ended: "stopped", words: "", landing: null }, "dropped");
    }
    patch(round, index, { state: "starting" });
    const no = notStartable(run.row);
    if (no) return couldNotRun(run, no);
    const leadRec = deps.rec(lead);
    if (!leadRec?.lane?.worktree) return couldNotRun(run, tr("helpers.run.why.noLead"));
    const first = helperBrief(index + 1, deps.title(lead), run.row.title, run.row.brief, { minutes: BUDGET.stopMs / 60_000, steps: BUDGET.stopSteps });
    const res = await deps.startLane({
      lead,
      job: jobOf(lead),
      round,
      index,
      row: run.row,
      first,
      made: (id) => {
        bySession.set(id, { round, index });
        live.set(id, { budget: null, stop: null, reportTurn: false, subSteps: new Set() });
        patch(round, index, { session: id, state: "running" });
      },
    });
    const now = runAt(round, index)!;
    if (!res.ok) {
      if (now.state === "back") return;
      return couldNotRun(now, res.why);
    }
    // the person pressed Stop while it started: its first turn stops now
    if (now.stopping) void stopRun(now);
    idleTimer();
  };

  /** Starts every waiting helper this Mac has room for, across every lead, in the order the rounds were approved. */
  let pumping = false;
  let again = false;
  const pump = async (): Promise<void> => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        const n = await cap();
        for (const lead of leads) {
          for (;;) {
            const took = startNext(deps.rounds(lead), running(), n);
            if (!took.next) break;
            deps.setRounds(lead, took.rounds);
            const { round, index } = took.next;
            patch(round, index, { state: "starting" });
            making = making.then(() => launch(lead, round, index)).catch(() => undefined);
          }
        }
      } while (again);
    } finally {
      pumping = false;
    }
  };

  /** The clock runs while any helper runs, and stops when none does. */
  const idleTimer = () => {
    const any = [...runs.values()].some((l) => l.some((r) => r.state === "running" || r.state === "starting"));
    if (any && !stopTimer) stopTimer = deps.every(TICK_MS, tick);
    else if (!any && stopTimer) {
      stopTimer();
      stopTimer = null;
    }
  };

  /** The helper's asks and questions as its chat has them now: the budget's clock stands still from the first one opened until the
   *  last one is settled (R5). */
  const reconcile = (id: string, l: Live) => {
    if (!l.budget) return;
    const open = deps.asks(id);
    const now = deps.now();
    let b = l.budget;
    for (const a of open) b = budgetAskOpened(b, a, now);
    for (const a of b.asks) if (!open.includes(a)) b = budgetAskSettled(b, a, now);
    l.budget = b;
  };

  /** Does what the budget says is due for helper session `id` now: a note steered into its turn, or a stop. Only while its turn
   *  runs: an idle helper has nothing to stop, and nothing is due while an ask waits (`budgetDue`). */
  const check = (id: string) => {
    const l = live.get(id);
    const run = runOf(id);
    if (!l?.budget || !run || !inTurn(run)) return;
    reconcile(id, l);
    if (!deps.working(id)) return;
    const agent = deps.rec(id)?.agent ?? "";
    const now = deps.now();
    for (const a of budgetDue(l.budget, now, steersOf(agent))) {
      if (a === "nudge" || a === "wrapUp") {
        const text = a === "nudge" ? tr("helpers.run.note.nudge", { steps: BUDGET.nudgeSteps }) : tr("helpers.run.note.wrapUp");
        l.budget = budgetDone(l.budget, a, now);
        deps.note(id, tr("helpers.run.noted", { text }));
        void deps.steer(id, text).catch(() => undefined);
      } else if (a === "stop") {
        if (l.stop) continue;
        l.stop = "budget";
        l.budget = budgetDone(l.budget, a, now);
        deps.note(id, tr("helpers.run.budgetStop", { minutes: BUDGET.stopMs / 60_000, steps: BUDGET.stopSteps }));
        void deps.interrupt(id).catch(() => undefined);
      } else {
        l.budget = budgetDone(l.budget, a, now);
        deps.note(id, tr("helpers.run.reportStop", { minutes: BUDGET.reportMs / 60_000 }));
        void deps.interrupt(id).catch(() => undefined);
      }
    }
  };

  const tick = () => {
    for (const id of live.keys()) check(id);
  };

  /** Whether a helper's turns are read: while it runs, and after it reported, when the person wrote to it again (its budget starts
   *  afresh, and a report before the hand-over replaces its earlier one, as item 102d's `recordBack` keeps it). */
  const inTurn = (run: HelperRun) => run.state === "running" || (run.state === "back" && !!run.session && !run.dropped);

  /** Helper session `id`'s turn ended: the budget's stop sends its one message, or the helper is back with its last words. */
  const turnEnded = (id: string, outcome: unknown, error: unknown) => {
    const l = live.get(id);
    const run = runOf(id);
    if (!l || !run || !inTurn(run)) return;
    if (l.stop === "budget" && l.budget?.phase === "reporting" && !l.reportTurn) {
      // the budget's stop landed: one message asks for the report, and the turn it starts is the report's three minutes
      l.reportTurn = true;
      void deps.send(id, tr("helpers.run.note.final")).then((sent) => {
        // nothing could be sent: what it had is its report
        if (!sent && runOf(id)?.state === "running") turnEnded(id, "interrupted", "");
      });
      return;
    }
    const words = deps.lastAnswer(id);
    // a helper lane cannot ask for helper lanes (R4): its blocks stay its words, with a line saying why nothing starts
    if (helperReply([words]) !== null) deps.note(id, tr("helpers.run.onlyLead"));
    const spent = !!l.budget && budgetSpent(l.budget);
    const steps = l.budget?.steps ?? 0;
    let ended: Ended;
    let failure: FailureKind | undefined;
    if (l.stop === "person") ended = "stopped";
    else if (outcome === "done" || (outcome === "interrupted" && spent)) ended = "done";
    // the person's own Stop in the helper's chat is theirs, as the row's Stop is
    else if (outcome === "interrupted") ended = "stopped";
    else {
      ended = "failed";
      // one that ended before any step never got to try (R6); otherwise its own words say whether it was the plumbing
      failure = steps === 0 ? "infra" : failureKindOf(String(error ?? words));
    }
    const said = ended === "failed" && typeof error === "string" && error ? error : words;
    l.stop = null;
    l.reportTurn = false;
    back(run, { ended, words: said, ...(failure ? { failure } : {}), ...(spent ? { budgetSpent: true } : {}), steps, landing: "pending" });
  };

  /** The helper's agent ended, or its session closed, before it reported: back with what it had. */
  const gone = (id: string, closed: boolean) => {
    const run = runOf(id);
    const l = live.get(id);
    if (!run || run.state !== "running") return;
    const steps = l?.budget?.steps ?? 0;
    const error = deps.rec(id)?.error ?? "";
    if (closed || l?.stop === "person") return back(run, { ended: "stopped", words: deps.lastAnswer(id), steps, landing: "pending" });
    back(run, { ended: "failed", words: error || deps.lastAnswer(id), failure: steps === 0 ? "infra" : failureKindOf(error), steps, landing: "pending" });
  };

  /** The person's Stop on one helper lane (only ever a press): a waiting one leaves the queue, a starting one stops as soon as it
   *  runs, a running one's turn stops at once and its report says the person stopped it (R5). */
  const stopRun = async (run: HelperRun) => {
    if (run.state === "waiting") {
      const d = dropWaiting(deps.rounds(run.lead), run.round, run.index);
      deps.setRounds(run.lead, d.rounds);
      markDropped(run.lead, false);
      endIdleOf(run.round);
      return;
    }
    if (run.state === "starting") {
      patch(run.round, run.index, { stopping: true });
      return;
    }
    if (run.state !== "running" || !run.session) return;
    const l = live.get(run.session);
    if (l) l.stop = "person";
    patch(run.round, run.index, { stopping: true });
    if (deps.working(run.session)) await deps.interrupt(run.session).catch(() => undefined);
    // not working (started, before its first turn): nothing will end, so it is back now
    else gone(run.session, true);
  };

  return {
    /** Item 102e's hand-off: a round the person approved with Start helpers. Its helper lanes start as this Mac has room. */
    approved(r: HelperRoundApproved): void {
      if (runs.has(r.round)) return;
      if (!leads.includes(r.lead)) leads.push(r.lead);
      runs.set(
        r.round,
        r.helpers.map((row, index): HelperRun => ({ lead: r.lead, round: r.round, index, row, state: "waiting" })),
      );
      emit();
      void pump();
    },
    /** An event of session `id`'s agent, after the sessions store handled it. Only a helper lane's are read. */
    event(id: string, ev: ChatEvent): void {
      const l = live.get(id);
      if (!l || !bySession.has(id)) return;
      const run = runOf(id);
      switch (ev.event) {
        case "turn.start":
          // the report's turn keeps the budget; the first turn, or a later message of the person's to a helper that is back, starts
          // a fresh one
          if (!l.reportTurn && (!l.budget || run?.state === "back")) l.budget = newBudget(deps.now());
          break;
        case "tool.start":
          if (l.budget) l.budget = budgetStep(l.budget, false);
          break;
        case "tool.diff":
          if (l.budget && Array.isArray(ev.files) && ev.files.length) l.budget = budgetChanged(l.budget);
          break;
        case "subagent": {
          // a subagent's own tool call is a step of the helper's (R5), each step it reports counted once
          const step = typeof ev.step === "string" ? ev.step : "";
          const key = `${String(ev.id ?? "")}\0${step}`;
          if (l.budget && typeof ev.tool === "string" && step && !l.subSteps.has(key)) {
            l.subSteps.add(key);
            l.budget = budgetStep(l.budget, false);
          }
          if (l.budget && Array.isArray(ev.diff) && ev.diff.length) l.budget = budgetChanged(l.budget);
          break;
        }
        case "turn.end":
          turnEnded(id, ev.outcome, ev.error);
          return;
        case "exit":
          gone(id, false);
          return;
      }
      check(id);
    },
    /** The budget's clock: called every `TICK_MS` while a helper runs, and by the tests with their own clock. */
    tick,
    /** The person's Stop on helper `index` of round `round`. */
    stop(round: string, index: number): Promise<void> {
      const run = runAt(round, index);
      return run ? stopRun(run) : Promise.resolve();
    },
    /** The person's Stop all for round `round`: every waiting helper leaves the queue and every running one stops. */
    async stopAll(round: string): Promise<void> {
      const list = runs.get(round) ?? [];
      const lead = list[0]?.lead;
      if (lead) {
        const d = dropWaiting(deps.rounds(lead), round);
        deps.setRounds(lead, d.rounds);
        markDropped(lead, false);
      }
      await Promise.all(list.filter((r) => r.state === "starting" || r.state === "running").map((r) => stopRun(r)));
      endIdleOf(round);
    },
    /** Session `id` closed: a helper lane that had not reported is back as stopped by the person; a lead's waiting helpers leave the
     *  queue and its running ones stop, and nothing of theirs lands (R11). */
    closed(id: string): void {
      if (bySession.has(id)) {
        gone(id, true);
        bySession.delete(id);
        live.delete(id);
        return;
      }
      if (!leads.includes(id)) return;
      for (const [round, list] of runs) if (list[0]?.lead === id) void this.stopAll(round);
    },
    /** Session `id` is a helper lane of a round run here. */
    isHelper: (id: string): boolean => bySession.has(id),
    /** The runs of round `round`, in helper order (the Helpers card): the same value until something of them changes. */
    roundRuns: (round: string): readonly HelperRun[] => snap[round] ?? NONE,
    /** How many run at once on this Mac, once the memory was read; null before. */
    atOnce: (): number | null => atOnce,
    /** Reads this Mac's cap now (the Start helpers card says it before the press). */
    readCap: cap,
    /** Hear each helper lane that comes back (items 102i and 102j). The returned function stops it. */
    whenBack(fn: (b: HelperBack) => void): () => void {
      backs.add(fn);
      return () => {
        backs.delete(fn);
      };
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** The budget of helper session `id` as it stands (tests). */
    budgetOf: (id: string): Budget | null => live.get(id)?.budget ?? null,
  };
}

export type HelperRuns = ReturnType<typeof createHelperRuns>;
