// Item 102d's rules, with GoSpark's Buddy tests ported case by case (`mygogocash/gospark` at a7537c80: `Tests/BuddyBatchingTests.swift`,
// `BuddyHeadCapTests.swift`, `BuddyReportTests.swift`, `BuddyFailureClassTests.swift`, `BuddyBudgetTests` in
// `BuddyDelegationTests.swift`, and the tally in `APIKeyToolsTests.swift`). The comment above each row names the GoSpark test it
// comes from, or the rule of `docs/several-agents.md` it adds; a row whose rule differs from GoSpark's says how. The two safety
// tests of the slice are at the end: the budget's clock does not move while an ask waits, and a round never hands over while any
// helper's ask waits.
import { describe, expect, it } from "vitest";
import {
  agentsAtOnce,
  AT_ONCE_CEILING,
  atOnceFromMemory,
  BUDGET,
  budgetAskOpened,
  budgetAskSettled,
  budgetChanged,
  budgetClock,
  budgetDone,
  budgetDue,
  budgetSpent,
  budgetStep,
  canAdmit,
  canHandOver,
  dropWaiting,
  endingOf,
  failureKindOf,
  hasOpenWork,
  isQuiet,
  keptAtOnce,
  landed,
  landingEmpty,
  landingOutcome,
  leadsPart,
  MAX_INFRA_IN_A_ROW,
  MAX_ROUNDS,
  mayStartRound,
  newBudget,
  noRounds,
  openRound,
  personSpoke,
  readAtOnce,
  recordBack,
  ROUND_MAX,
  settleLanding,
  sharedFiles,
  startNext,
  takeHandOver,
  type Budget,
  type BudgetAction,
  type Ended,
  type FailureKind,
  type HelperReport,
  type Landing,
  type LeadNow,
  type Rounds,
} from "./rules";

const GB = 1024 ** 3;
const T0 = 1_800_000_000_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------------------------
// How many at once (R7, BuddyHeadCapTests)
// ---------------------------------------------------------------------------------------------------------------------------

describe("how many run at once on this Mac", () => {
  // Design R7: 2 with 8 GB or less, 3 up to 16 GB, 4 above; no GoSpark test, GoSpark has no memory rule.
  const fromMemory: [string, number | null | undefined, number][] = [
    ["4 GB", 4 * GB, 2],
    ["8 GB, the smallest Mac this runs on", 8 * GB, 2],
    ["a byte over 8 GB", 8 * GB + 1, 3],
    ["16 GB", 16 * GB, 3],
    ["18 GB", 18 * GB, 4],
    ["36 GB", 36 * GB, 4],
    ["128 GB, still the ceiling", 128 * GB, AT_ONCE_CEILING],
    ["memory the shell could not read (null)", null, 2],
    ["nothing (undefined)", undefined, 2],
    ["zero", 0, 2],
    ["a negative number", -1, 2],
    ["not a number", Number.NaN, 2],
    ["infinity", Number.POSITIVE_INFINITY, 2],
  ];

  it.each(fromMemory)("reads %s as %i at once", (_what, bytes, n) => {
    expect(atOnceFromMemory(bytes)).toBe(n);
    // No setting is exactly the memory's number.
    expect(agentsAtOnce(bytes)).toBe(n);
  });

  const withSetting: [string, number, number | null | undefined, number][] = [
    // GoSpark: BuddyHeadCapTests.noCapIsToday (no setting keeps the pair's number, else the default)
    ["no setting on 8 GB", 8 * GB, null, 2],
    ["no setting on 16 GB", 16 * GB, undefined, 3],
    ["no setting on 32 GB", 32 * GB, null, 4],
    // GoSpark: BuddyHeadCapTests.appCapIsAMinimum (resolve(4, 2) == 2)
    ["Settings' 2 lowers 32 GB's 4", 32 * GB, 2, 2],
    // GoSpark: BuddyHeadCapTests.appCapIsAMinimum (resolve(3, 6) == 3: a lower number keeps it)
    ["Settings' 6 leaves 16 GB's 3", 16 * GB, 6, 3],
    // GoSpark: BuddyHeadCapTests.appCapIsAMinimum (resolve(5, 5) == 5; here the ceiling is 4)
    ["Settings' 4 on 32 GB", 32 * GB, 4, 4],
    // GoSpark: BuddyHeadCapTests.appCapWithoutPair. Differs: GoSpark's app cap is the number itself in both directions when no
    // pair sets one (resolve(nil, 7) == 7); here Settings never raises it above the memory's number (R7).
    ["Settings' 4 on 8 GB stays 2", 8 * GB, 4, 2],
    ["Settings' 3 on 8 GB stays 2", 8 * GB, 3, 2],
    ["Settings' 1 on 8 GB lowers it to 1", 8 * GB, 1, 1],
    // GoSpark: BuddyHeadCapTests.clamped (nothing past the hard ceiling)
    ["Settings' 50 on 128 GB is the ceiling", 128 * GB, 50, AT_ONCE_CEILING],
    // GoSpark: BuddyHeadCapTests.clamped (zero or less from the app side reads as no cap, not as "no helpers")
    ["Settings' 0 is no setting", 16 * GB, 0, 3],
    ["Settings' -1 is no setting", 32 * GB, -1, 4],
    // Added: a number that is not whole is no setting, as a junk value reads as no cap in GoSpark's restore
    ["Settings' 2.5 is no setting", 32 * GB, 2.5, 4],
    ["Settings' NaN is no setting", 32 * GB, Number.NaN, 4],
  ];

  it.each(withSetting)("%s", (_what, bytes, setting, n) => {
    expect(agentsAtOnce(bytes, setting)).toBe(n);
  });

  it("never answers more than the ceiling or fewer than one, for any memory and any setting", () => {
    // GoSpark: BuddyHeadCapTests.clamped
    for (const bytes of [null, 0, 2 * GB, 8 * GB, 12 * GB, 16 * GB, 24 * GB, 512 * GB]) {
      for (const setting of [null, -5, 0, 1, 2, 3, 4, 5, 8, 99]) {
        const n = agentsAtOnce(bytes, setting);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(AT_ONCE_CEILING);
        expect(n).toBeLessThanOrEqual(atOnceFromMemory(bytes));
      }
    }
  });

  it("is what the round queue admits against", () => {
    // GoSpark: BuddyHeadCapTests.admission
    let r = openRound(noRounds<string>(), "r1", ["T0", "T1", "T2", "T3", "T4", "T5"], T0).rounds;
    const cap = agentsAtOnce(32 * GB, 2);
    let running = 0;
    for (;;) {
      const o = startNext(r, running, cap);
      r = o.rounds;
      if (!o.next) break;
      running += 1;
    }
    expect(running).toBe(2);
    expect(r.waiting).toHaveLength(4);
  });

  // GoSpark: BuddyHeadCapTests.persistence (round trip through UserDefaults; here through what Settings keeps as JSON)
  const kept: [string, unknown, number | null][] = [
    ["3", 3, 3],
    ["1", 1, 1],
    ["4", 4, 4],
    ["nothing", undefined, null],
    ["null", null, null],
    ["99, out of range", 99, null],
    ["42, out of range", 42, null],
    ["0", 0, null],
    ["5, over the ceiling", 5, null],
    ["the word four", "four", null],
    ["2.5", 2.5, null],
    ["a list", [3], null],
  ];

  it.each(kept)("keeps and reads back %s as %s", (_what, stored, n) => {
    expect(readAtOnce(stored)).toBe(n);
    if (typeof stored === "number" || stored == null) expect(keptAtOnce(stored as number | null | undefined)).toBe(n);
    expect(readAtOnce(JSON.parse(JSON.stringify({ v: keptAtOnce(readAtOnce(stored)) })).v)).toBe(n);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The budget (R5, BuddyBudgetTests and the runtime's use of BuddyBudget)
// ---------------------------------------------------------------------------------------------------------------------------

/** A helper's budget driven by a stand-in clock. */
class Clocked {
  b: Budget;
  now = T0;
  constructor(public steers = true) {
    this.b = newBudget(this.now);
  }
  wait(ms: number) {
    this.now += ms;
    return this;
  }
  steps(n: number, changedFile = false) {
    for (let i = 0; i < n; i++) this.b = budgetStep(this.b, changedFile);
    return this;
  }
  ask(id: string) {
    this.b = budgetAskOpened(this.b, id, this.now);
    return this;
  }
  answer(id: string) {
    this.b = budgetAskSettled(this.b, id, this.now);
    return this;
  }
  get due(): BudgetAction[] {
    return budgetDue(this.b, this.now, this.steers);
  }
  /** Does whatever is due, as the runtime would, and answers what it did. */
  act(): BudgetAction[] {
    const due = this.due;
    for (const a of due) this.b = budgetDone(this.b, a, this.now);
    return due;
  }
  get clock() {
    return budgetClock(this.b, this.now);
  }
}

describe("the budget's numbers", () => {
  // GoSpark: CLAUDE.md, "Buddy" (a nudge at 24 tool calls with no file change, wrap-up at 50 calls or 12 minutes, hard stop at
  // 90 calls or 20 minutes, then 3 minutes to write a report) and Buddy.swift's `BuddyBudget`
  const numbers: [keyof typeof BUDGET, number][] = [
    ["nudgeSteps", 24],
    ["wrapUpSteps", 50],
    ["wrapUpMs", 12 * MIN],
    ["stopSteps", 90],
    ["stopMs", 20 * MIN],
    ["reportMs", 3 * MIN],
    // GoSpark: BuddyHangWatchdog.answeredGrace, 60 seconds
    ["answeredGraceMs", MIN],
  ];

  it.each(numbers)("%s is %i", (key, n) => {
    expect(BUDGET[key]).toBe(n);
  });

  const orders: [string, boolean][] = [
    // GoSpark: BuddyBudgetTests.toolThresholdsEscalate
    ["the nudge comes before the word to wrap up", BUDGET.nudgeSteps < BUDGET.wrapUpSteps],
    ["the word to wrap up comes before the stop", BUDGET.wrapUpSteps < BUDGET.stopSteps],
    // GoSpark: BuddyBudgetTests.timeThresholdsEscalate
    ["the time to wrap up comes before the time stop", BUDGET.wrapUpMs < BUDGET.stopMs],
    // GoSpark: BuddyBudgetTests.reportWindowIsShorterThanTheTurn
    ["a stopped helper has some time to report", BUDGET.reportMs > 0],
    ["less time to report than it had to work", BUDGET.reportMs < BUDGET.stopMs],
    // GoSpark: BuddyBudgetTests.delegationRoundsAreCapped
    ["at least one round for a message", MAX_ROUNDS >= 1],
    ["at most three rounds for a message", MAX_ROUNDS <= 3],
  ];

  it.each(orders)("%s", (_what, holds) => {
    expect(holds).toBe(true);
  });
});

describe("the budget of one helper lane", () => {
  const cases: { name: string; run: () => void }[] = [
    {
      // GoSpark: APIKeyToolsTests.tally ("pacing counts every tool and resets on a change")
      name: "counts every step and restarts the nudge's count on a file change",
      run: () => {
        const c = new Clocked().steps(2);
        expect(c.b.steps).toBe(2);
        expect(c.b.sinceChange).toBe(2);
        c.steps(1, true);
        expect(c.b.steps).toBe(3);
        expect(c.b.sinceChange).toBe(0);
        expect(c.b.nudgeAt).toBe(BUDGET.nudgeSteps);
      },
    },
    {
      // Item 102h: an agent reports a step and then the change it made, so the change restarts the nudge's count without a second
      // step; while an ask waits it changes nothing, as a step does not
      name: "a change reported after its step restarts the nudge's count and counts no step",
      run: () => {
        const c = new Clocked().steps(30);
        c.b = budgetChanged(c.b);
        expect(c.b.steps).toBe(30);
        expect(c.b.sinceChange).toBe(0);
        expect(c.b.nudgeAt).toBe(BUDGET.nudgeSteps);
        const same = c.b;
        expect(budgetChanged(same)).toBe(same);
        c.steps(5).ask("q1");
        const held = c.b;
        expect(budgetChanged(held)).toBe(held);
      },
    },
    {
      // GoSpark: OpenAICompatibleSession's pacing (no test there): a nudge every 24 steps with no file changed
      name: "nudges at 24 steps with no file changed, and again 24 steps later",
      run: () => {
        const c = new Clocked().steps(23);
        expect(c.act()).toEqual([]);
        c.steps(1);
        expect(c.act()).toEqual(["nudge"]);
        c.steps(23);
        expect(c.act()).toEqual([]);
        c.steps(1);
        expect(c.act()).toEqual(["nudge"]);
      },
    },
    {
      // GoSpark: APIKeyToolTally.count (no test there): a change resets the nudge to its first threshold
      name: "a file changed before 24 steps puts the nudge off",
      run: () => {
        const c = new Clocked().steps(20).steps(1, true).steps(20);
        expect(c.act()).toEqual([]);
        c.steps(4);
        expect(c.act()).toEqual(["nudge"]);
      },
    },
    {
      // GoSpark: OpenAICompatibleSession's wrap-up (no test there): once, at 50 steps
      name: "says to wrap up once at 50 steps",
      run: () => {
        const c = new Clocked().steps(10, true).steps(39, true);
        expect(c.act()).toEqual([]);
        c.steps(1, true);
        expect(c.act()).toEqual(["wrapUp"]);
        c.steps(10, true);
        expect(c.act()).toEqual([]);
      },
    },
    {
      // GoSpark: OpenAICompatibleSession's wrap-up (no test there): once, at 12 minutes
      name: "says to wrap up once at 12 minutes",
      run: () => {
        const c = new Clocked().wait(12 * MIN - 1);
        expect(c.act()).toEqual([]);
        c.wait(1);
        expect(c.act()).toEqual(["wrapUp"]);
        c.wait(MIN);
        expect(c.act()).toEqual([]);
      },
    },
    {
      // GoSpark: OpenAICompatibleSession's order (no test there): the word to wrap up, then the nudge, in one go
      name: "sends the word to wrap up and a nudge together when both fall due",
      run: () => {
        const c = new Clocked().steps(2, true).steps(24);
        expect(c.act()).toEqual(["nudge"]);
        c.steps(23);
        expect(c.act()).toEqual([]);
        // 50 steps, the last 48 with no file changed
        c.steps(1);
        expect(c.act()).toEqual(["wrapUp", "nudge"]);
      },
    },
    {
      // Design R5 (102d, 102h): "at 90 steps exactly one stop and one final message go out"
      name: "stops at 90 steps, exactly once",
      run: () => {
        const c = new Clocked().steps(89, true);
        expect(c.due).not.toContain("stop");
        c.act();
        c.steps(1, true);
        expect(c.act()).toEqual(["stop"]);
        expect(budgetSpent(c.b)).toBe(true);
        c.steps(30, true).wait(MIN);
        expect(c.act()).toEqual([]);
      },
    },
    {
      // GoSpark: ThreadRuntime's head watchdog (no test there): the stop at 20 minutes
      name: "stops at 20 minutes",
      run: () => {
        const c = new Clocked().wait(20 * MIN - 1);
        expect(c.act()).not.toContain("stop");
        c.wait(1);
        expect(c.act()).toEqual(["stop"]);
      },
    },
    {
      // GoSpark: ThreadRuntime's `reportSeconds` allowance for the report's turn (no test there)
      name: "gives the report three minutes after the stop, then stops that turn once",
      run: () => {
        const c = new Clocked().wait(20 * MIN);
        expect(c.act()).toEqual(["stop"]);
        // the report's turn takes no notes, and its steps stop nothing
        c.steps(200).wait(3 * MIN - 1);
        expect(c.act()).toEqual([]);
        c.wait(1);
        expect(c.act()).toEqual(["reportStop"]);
        c.wait(10 * MIN);
        expect(c.act()).toEqual([]);
        expect(c.b.phase).toBe("over");
      },
    },
    {
      // Design R5: "The nudge and the word to wrap up go as a steer where the agent takes one; other agents get only the stop"
      name: "gives an agent that takes no steer only the stops",
      run: () => {
        const c = new Clocked(false).steps(60).wait(15 * MIN);
        expect(c.act()).toEqual([]);
        c.steps(30);
        expect(c.act()).toEqual(["stop"]);
        c.wait(3 * MIN);
        expect(c.act()).toEqual(["reportStop"]);
      },
    },
    {
      // GoSpark: BuddyBudgetTests.budgetExhaustionIsRecorded (a helper cut off by its budget stays marked)
      name: "is not spent until its stop, and stays spent after",
      run: () => {
        const c = new Clocked().steps(89);
        expect(budgetSpent(c.b)).toBe(false);
        c.steps(1).act();
        expect(budgetSpent(c.b)).toBe(true);
        c.wait(3 * MIN).act();
        expect(budgetSpent(c.b)).toBe(true);
      },
    },
    {
      // Design R5: "The clock and the count stand still while an ask or a question of that helper waits"
      name: "does not count steps while an ask waits, such as a subagent's beside it",
      run: () => {
        const c = new Clocked().steps(80).ask("a1").steps(50);
        expect(c.b.steps).toBe(80);
        c.answer("a1").steps(9);
        expect(c.act()).not.toContain("stop");
        c.steps(1);
        expect(c.act()).toEqual(["stop"]);
      },
    },
    {
      // Design R5: the clock starts again only when no ask or question of the helper waits
      name: "keeps the clock still until every waiting ask is settled",
      run: () => {
        const c = new Clocked().wait(5 * MIN).ask("a1").wait(MIN).ask("q1").wait(MIN);
        c.answer("a1").wait(10 * MIN);
        expect(c.clock).toBe(5 * MIN);
        c.answer("q1").wait(MIN);
        expect(c.clock).toBe(6 * MIN);
      },
    },
    {
      // Design R5: an ask seen twice, or a settle for an ask never seen, changes nothing
      name: "takes the same ask twice, and a settle it never saw, as nothing",
      run: () => {
        const c = new Clocked().wait(MIN).ask("a1").wait(MIN).ask("a1").wait(MIN);
        c.answer("other").wait(MIN);
        expect(c.clock).toBe(MIN);
        expect(c.b.asks).toEqual(["a1"]);
        c.answer("a1").answer("a1").wait(MIN);
        expect(c.clock).toBe(2 * MIN);
      },
    },
    {
      // GoSpark: ThreadRuntime's head watchdog with BuddyHangWatchdog.answeredGrace (no test there): an answer given with seconds
      // left is acted on before the time stop
      name: "gives a minute after an answer before the time stop",
      run: () => {
        const c = new Clocked().wait(12 * MIN);
        expect(c.act()).toEqual(["wrapUp"]);
        c.wait(8 * MIN - 5_000).ask("a1").wait(30 * MIN).answer("a1").wait(5_000);
        expect(c.act()).toEqual([]);
        c.wait(MIN - 5_001);
        expect(c.act()).toEqual([]);
        c.wait(1);
        expect(c.act()).toEqual(["stop"]);
      },
    },
    {
      // GoSpark: the grace held only the watchdog's time stop, never the step stop
      name: "does not hold the step stop for the minute after an answer",
      run: () => {
        const c = new Clocked().steps(89).ask("a1").wait(MIN).answer("a1").steps(1);
        expect(c.act()).toEqual(["stop"]);
      },
    },
    {
      // Design R5: an ask during the report's turn holds its three minutes too
      name: "holds the report's three minutes while an ask of that turn waits",
      run: () => {
        const c = new Clocked().steps(90);
        expect(c.act()).toEqual(["stop"]);
        c.wait(2 * MIN).ask("a1").wait(30 * MIN);
        expect(c.act()).toEqual([]);
        c.answer("a1").wait(MIN - 1);
        expect(c.act()).toEqual([]);
        c.wait(1);
        expect(c.act()).toEqual(["reportStop"]);
      },
    },
    {
      // Added: a clock that went back counts nothing for that stretch
      name: "counts nothing for a clock that went back",
      run: () => {
        const c = new Clocked().wait(2 * MIN);
        c.now = T0 - 5 * MIN;
        expect(c.clock).toBe(0);
        expect(c.act()).toEqual([]);
      },
    },
  ];

  it.each(cases)("$name", ({ run }) => run());
});

// ---------------------------------------------------------------------------------------------------------------------------
// Trouble that is not the task (R6, BuddyFailureClassTests)
// ---------------------------------------------------------------------------------------------------------------------------

describe("what counts as never getting to try", () => {
  const words: [string, FailureKind][] = [
    // GoSpark: BuddyFailureClassTests.rateLimitsAreInfra
    ["DeepSeek is rate-limited right now. Wait a moment and try again.", "infra"],
    ["Z.ai is rate-limited right now. Wait a moment and try again.", "infra"],
    ["Meta is rate-limited right now. Wait a moment and try again.", "infra"],
    ["HTTP 429: too many requests", "infra"],
    // GoSpark: BuddyFailureClassTests.spentPlansAreInfra
    ["The GLM Coding Plan limit is spent. Wait for the window to reset.", "infra"],
    ["DeepSeek has no balance left. Top up at platform.deepseek.com.", "infra"],
    ["usage limit reached, resets at midnight", "infra"],
    ["API Error: Overloaded", "infra"],
    ["server error 503, service unavailable", "infra"],
    // GoSpark: BuddyFailureClassTests.transportAndSetupAreInfra
    ["connection reset by peer", "infra"],
    ["socket hang up", "infra"],
    ["getaddrinfo ENOTFOUND api.example.com", "infra"],
    ["Claude is not installed. Install it and sign in.", "infra"],
    ["DeepSeek needs an API key. Add one in Settings.", "infra"],
    ["claude was not found on your PATH.", "infra"],
    ["Could not isolate the checkout. The head was not started.", "infra"],
    // Added, R6: an agent that is not signed in never got to try
    ["Codex is not signed in.", "infra"],
    // GoSpark: BuddyFailureClassTests.budgetStopsAreAgent (verbatim `BuddyBudget.finalNote`: a stop by its budget is the size of
    // the task, not the plumbing)
    ["[GoSpark] Your budget is spent and your tools are gone. Reply now with your report: what you changed, how far it got, and what is left.", "agent"],
    // GoSpark: BuddyFailureClassTests.watchdogStopsAreAgent (verbatim `BuddyHangWatchdog.stalledNote`)
    ["Stalled: no edits for 10 minutes; stopped by GoSpark. Resend with a sharper brief.", "agent"],
    // GoSpark: BuddyFailureClassTests.shapeErrorsAreAgent
    ["The conversation no longer fits DeepSeek's context window.", "agent"],
    ["DeepSeek no longer offers that model. Pick another.", "agent"],
    ["DeepSeek stopped before finishing.", "agent"],
    ["", "agent"],
  ];

  it.each(words)("reads %j as %s", (text, kind) => {
    expect(failureKindOf(text)).toBe(kind);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Landings and reports (R8, R9, BuddyReportTests)
// ---------------------------------------------------------------------------------------------------------------------------

const landing = (over: Partial<Landing> = {}): Landing => ({ files: [], conflicts: [], ...over });

const report = (round: string, index: number, over: Partial<HelperReport> = {}): HelperReport => ({
  round,
  index,
  title: `Task ${index}`,
  ended: "done",
  words: "Done.",
  landing: null,
  ...over,
});

describe("how a landing reads", () => {
  const cases: [string, Landing, boolean, boolean, ReturnType<typeof landingOutcome>][] = [
    // GoSpark: BuddyReportTests.emptyLanding (a helper that changed nothing reads as empty, not as landed)
    ["nothing changed", landing(), true, false, "changedNothing"],
    // GoSpark: BuddyReportTests.landedWork
    ["work in the lead's folder", landing({ files: [{ path: "a.ts", added: 3, removed: 1 }] }), false, true, "landed"],
    // GoSpark: BuddyReportTests.conflictsStillLand (the markers are in the folder)
    ["work with conflicts", landing({ files: [{ path: "a.ts", added: 3, removed: 1 }], conflicts: ["a.ts"] }), false, true, "landed"],
    // GoSpark: BuddyReportTests.keptPatch
    ["a kept patch", landing({ files: [{ path: "a.ts", added: 3, removed: 1 }], patchPath: "/p/1.patch" }), false, false, "keptPatch"],
    // GoSpark: BuddyReportTests.erroredLanding (a landing that only failed is never silent)
    ["a landing that failed", landing({ error: "patch did not apply" }), false, false, "failed"],
    // GoSpark: BuddyLanding.refusal (`reportMessage` tells the lead never to apply it here); R8's patch outside the project
    ["a patch kept untried", landing({ files: [{ path: "../x", added: 1, removed: 0 }], patchPath: "/p/2.patch", refusal: "outside" }), false, false, "keptOutside"],
    // item 102i: the person took the landing back, so none of it is in the lead's folder now
    ["a landing taken back", landing({ files: [{ path: "a.ts" }], takenBack: true }), false, false, "takenBack"],
  ];

  it.each(cases)("%s: empty %s, landed %s, %s", (_what, l, empty, isLanded, outcome) => {
    expect(landingEmpty(l)).toBe(empty);
    expect(landed(l)).toBe(isLanded);
    expect(landingOutcome(l)).toBe(outcome);
  });

  it("reads no landing at all as nothing changed", () => {
    expect(landingOutcome(null)).toBe("changedNothing");
  });
});

describe("what a report tells the lead", () => {
  const endings: [string, Ended, FailureKind | undefined, boolean, ReturnType<typeof endingOf>, ReturnType<typeof leadsPart>][] = [
    // GoSpark: BuddyReportTests.reportsWhatLanded (a finished helper's work is built on)
    ["a finished helper", "done", undefined, false, "done", "buildOn"],
    // GoSpark: BuddyReportTests.flagsBudgetExhaustion (marked, so it is not read as a finished task)
    ["a helper stopped by its budget", "done", undefined, true, "budgetSpent", "buildOn"],
    // GoSpark: BuddyReportTests.failedHeadHandsBack ("do it yourself or send it out again")
    ["a helper that failed the task", "failed", "agent", false, "failed", "doItOrSendAgain"],
    ["a failed helper with no kind", "failed", undefined, false, "failed", "doItOrSendAgain"],
    // GoSpark: BuddyReportTests.infraFailureReadsAsCouldNotRun (wait for the provider, do not take over)
    ["a helper that never got to try", "failed", "infra", false, "couldNotRun", "sendAgainLater"],
    // GoSpark: BuddyReportTests.stoppedHeadLeftAlone; R5: the person's Stop is not a budget
    ["a helper the person stopped", "stopped", undefined, false, "stoppedByPerson", "leaveAlone"],
    ["a helper the person stopped as its budget ran out", "stopped", undefined, true, "stoppedByPerson", "leaveAlone"],
  ];

  it.each(endings)("%s", (_what, ended, failure, budgetSpent, ending, part) => {
    const r = report("r1", 0, { ended, failure, budgetSpent });
    expect(endingOf(r)).toBe(ending);
    expect(leadsPart(r)).toBe(part);
  });

  it("carries what landed with each file's counts, and the files with conflicts", () => {
    // GoSpark: BuddyReportTests.reportsWhatLanded, BuddyReportTests.flagsConflicts
    const l = landing({ files: [{ path: "src/qr.ts", added: 12, removed: 3 }], conflicts: ["src/qr.ts"] });
    expect(landingOutcome(l)).toBe("landed");
    expect(l.files[0]).toEqual({ path: "src/qr.ts", added: 12, removed: 3 });
    expect(l.conflicts).toEqual(["src/qr.ts"]);
  });

  it("carries where a kept patch is", () => {
    // GoSpark: BuddyReportTests.explainsKeptPatch (the words and the `git apply --3way` line are 102j's message)
    const l = landing({ files: [{ path: "a.ts", added: 1, removed: 0 }], patchPath: "/p/hank.patch" });
    expect(landingOutcome(l)).toBe("keptPatch");
    expect(l.patchPath).toBe("/p/hank.patch");
  });

  it("names a file two helpers both changed, and no other", () => {
    // GoSpark: BuddyReportTests.warnsOnOverlap
    const shared = sharedFiles([
      report("r1", 0, { landing: landing({ files: [{ path: "Shared.ts", added: 2, removed: 0 }, { path: "a.ts", added: 1, removed: 0 }] }) }),
      report("r1", 1, { landing: landing({ files: [{ path: "Shared.ts", added: 1, removed: 1 }] }) }),
      report("r1", 2, { landing: null }),
      report("r1", 3, { landing: "pending" }),
    ]);
    expect(shared).toEqual([{ path: "Shared.ts", helpers: [{ round: "r1", index: 0 }, { round: "r1", index: 1 }] }]);
  });

  // Not ported here: BuddyReportTests.alwaysForbidsGitInspection and carriesReportText are the words of the message to the lead,
  // which 102j writes with its fence, masking and caps. mentionsHeadsStillWorking has no case here: reports go only once every
  // helper of every round is back (`canHandOver`), so no helper is still at work when the lead hears them. distinguishesOrigins
  // has none either: a helper lane has one origin, its lead's round, and a person's message to a helper lane is its own chat's.
});

// ---------------------------------------------------------------------------------------------------------------------------
// Rounds (R4, R6, R7, R9, BuddyBatchingTests)
// ---------------------------------------------------------------------------------------------------------------------------

const IDLE: LeadNow = { idle: true, asking: false, personWaiting: false };

/** One lead's rounds, driven step by step as the runtime would. */
class Q {
  r: Rounds<string> = noRounds<string>();
  open(id: string, briefs: string[]) {
    const o = openRound(this.r, id, briefs, T0);
    this.r = o.rounds;
    return o;
  }
  start(running = 0, cap = AT_ONCE_CEILING) {
    const o = startNext(this.r, running, cap);
    this.r = o.rounds;
    return o.next;
  }
  back(r: HelperReport) {
    const o = recordBack(this.r, r);
    this.r = o.rounds;
    return o.kept;
  }
  drop(round?: string, index?: number) {
    const o = dropWaiting(this.r, round, index);
    this.r = o.rounds;
    return o.dropped;
  }
  take(lead: LeadNow = IDLE, helperAsks = 0) {
    const o = takeHandOver(this.r, lead, helperAsks);
    this.r = o.rounds;
    return o.handed;
  }
  round(id: string) {
    return this.r.rounds.find((x) => x.id === id);
  }
}

describe("rounds of helper lanes", () => {
  const cases: { name: string; run: () => void }[] = [
    {
      // GoSpark: BuddyBatchingTests.settlesCompleteBatchSorted
      name: "a round with every helper back and none waiting hands its reports over, in helper order",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start();
        q.start();
        q.back(report("r1", 1));
        expect(q.round("r1")?.back).toBe(false);
        expect(q.take()).toBeNull();
        q.back(report("r1", 0));
        expect(q.round("r1")?.back).toBe(true);
        expect(q.take()?.[0].reports.map((x) => x.index)).toEqual([0, 1]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.doesNotSettleWhileWaiting
      name: "a round is not back while a helper of it still waits to start",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        const first = q.start(0, 1);
        expect(first?.brief).toBe("A");
        q.back(report("r1", 0));
        expect(q.round("r1")?.back).toBe(false);
        expect(q.r.waiting).toHaveLength(1);
        expect(q.take()).toBeNull();
      },
    },
    {
      // GoSpark: BuddyBatchingTests.emptyBatchSettles (a failed start cannot pin the lead)
      name: "a round with no helpers goes at once, with nothing to hand over",
      run: () => {
        const q = new Q();
        q.open("r1", []);
        expect(q.r.rounds).toEqual([]);
        expect(isQuiet(q.r)).toBe(true);
        expect(q.take()).toBeNull();
      },
    },
    {
      // GoSpark: BuddyBatchingTests.unbatchedReportIsImmediate. Differs (R9): every helper lane belongs to a round, and a report
      // with no round of its lead's open is not sent
      name: "a report for no open round is not kept",
      run: () => {
        const q = new Q();
        expect(q.back(report("nowhere", 3))).toBe(false);
        expect(isQuiet(q.r)).toBe(true);
        expect(q.take()).toBeNull();
      },
    },
    {
      // GoSpark: BuddyBatchingTests.lateReportAfterSettle. Differs (R9): a report arriving after its round was handed over is
      // shown on its row and not sent, so it is not kept here
      name: "a report arriving after its round was handed over is late and not kept",
      run: () => {
        const q = new Q();
        q.open("r1", ["A"]);
        q.start();
        q.back(report("r1", 0, { ended: "stopped", words: "Stopped." }));
        expect(q.take()).not.toBeNull();
        expect(q.back(report("r1", 0, { words: "Later." }))).toBe(false);
        expect(q.take()).toBeNull();
        expect(isQuiet(q.r)).toBe(true);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.steeredHeadReplacesReport (in the round, and once back but before the hand-over)
      name: "a helper that reports again before the hand-over replaces its earlier report",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start();
        q.start();
        q.back(report("r1", 0, { words: "First." }));
        q.back(report("r1", 0, { words: "Second." }));
        expect(q.round("r1")?.reports.map((x) => x.words)).toEqual(["Second."]);
        q.back(report("r1", 1));
        expect(q.round("r1")?.back).toBe(true);
        expect(q.back(report("r1", 0, { words: "Third." }))).toBe(true);
        const handed = q.take();
        expect(handed?.[0].reports.map((x) => x.words)).toEqual(["Third.", "Done."]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.flushWaitsForEveryBatch (one round does not cut the next short)
      name: "the hand-over waits until every round is back",
      run: () => {
        const q = new Q();
        q.open("r1", ["A"]);
        q.open("r2", ["B"]);
        q.start();
        q.start(1);
        q.back(report("r1", 0));
        expect(canHandOver(q.r, IDLE, 0)).toBe(false);
        expect(q.round("r1")?.back).toBe(true);
        expect(q.round("r2")?.back).toBe(false);
        q.back(report("r2", 0));
        expect(q.take()?.map((x) => x.id)).toEqual(["r1", "r2"]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.idleLeadFlushesOnce (helpers finishing together stay one message)
      name: "an idle lead may take the reports, once, as one hand-over",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start();
        q.start();
        q.back(report("r1", 1));
        q.back(report("r1", 0));
        expect(canHandOver(q.r, { ...IDLE, idle: false }, 0)).toBe(false);
        expect(q.take({ ...IDLE, idle: false })).toBeNull();
        expect(canHandOver(q.r, IDLE, 0)).toBe(true);
        expect(q.take()?.[0].reports.map((x) => x.index)).toEqual([0, 1]);
        expect(isQuiet(q.r)).toBe(true);
        expect(q.take()).toBeNull();
      },
    },
    {
      // GoSpark: BuddyBatchingTests.newBatchKeepsReports
      name: "a new round opening before the hand-over keeps the reports for later",
      run: () => {
        const q = new Q();
        q.open("r1", ["A"]);
        q.start();
        q.back(report("r1", 0));
        q.open("r2", ["More"]);
        expect(q.take()).toBeNull();
        expect(q.round("r1")?.reports.map((x) => x.index)).toEqual([0]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.admitsInOrderUpToCap
      name: "waiting helpers start in order, up to the cap",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C"]);
        expect(canAdmit(q.r, 0, 2)).toBe(true);
        expect(q.start(0, 2)?.brief).toBe("A");
        expect(q.start(1, 2)?.brief).toBe("B");
        expect(canAdmit(q.r, 2, 2)).toBe(false);
        expect(q.start(2, 2)).toBeNull();
        expect(q.r.waiting.map((w) => w.brief)).toEqual(["C"]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.capsWaiting, BuddyBatchingTests.reportsHeldBackCount. Differs: twice this design's ceiling
      // of 4, so 8, where GoSpark's is twice its 8
      name: "one round takes at most 8, and says how many did not fit",
      run: () => {
        const q = new Q();
        const many = Array.from({ length: ROUND_MAX + 5 }, (_, i) => `T${i}`);
        expect(ROUND_MAX).toBe(8);
        expect(q.open("r1", many).heldBack).toBe(5);
        expect(q.r.waiting).toHaveLength(ROUND_MAX);
        expect(q.r.waiting.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.quietIsAutoMergeGate (here: nothing waiting, nothing out, nothing to hand over)
      name: "is quiet only with nothing waiting, nothing out and nothing to hand over",
      run: () => {
        const q = new Q();
        expect(isQuiet(q.r)).toBe(true);
        q.open("r1", ["A"]);
        expect(isQuiet(q.r)).toBe(false);
        expect(hasOpenWork(q.r)).toBe(true);
        q.start();
        q.back(report("r1", 0));
        expect(hasOpenWork(q.r)).toBe(false);
        expect(isQuiet(q.r)).toBe(false);
        q.take();
        expect(isQuiet(q.r)).toBe(true);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.consecutiveInfraTripsTheBreaker; R6: the waiting helpers are dropped and counted
      name: "two helpers in a row that never got to try stop the round and count the dropped ones",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C", "D", "E"]);
        q.start(0, 2);
        q.start(1, 2);
        q.back(report("r1", 0, { ended: "failed", failure: "infra" }));
        // one is an anecdote: the round may still start helpers
        expect(q.r.breakerTripped).toBe(false);
        expect(canAdmit(q.r, 1, 2)).toBe(true);
        q.back(report("r1", 1, { ended: "failed", failure: "infra" }));
        // two is a pattern: no waiting helper starts, and those waiting are dropped and counted
        expect(MAX_INFRA_IN_A_ROW).toBe(2);
        expect(q.r.breakerTripped).toBe(true);
        expect(q.r.waiting).toEqual([]);
        expect(canAdmit(q.r, 0, 4)).toBe(false);
        expect(q.round("r1")?.dropped).toEqual({ breaker: 3, person: 0 });
        expect(q.round("r1")?.back).toBe(true);
        const handed = q.take();
        expect(handed?.[0].dropped.breaker).toBe(3);
        expect(handed?.[0].reports.map((x) => endingOf(x))).toEqual(["couldNotRun", "couldNotRun"]);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.successClearsTheStreak
      name: "a helper that got through proves the plumbing and clears the count",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C"]);
        q.start();
        q.start();
        q.back(report("r1", 0, { ended: "failed", failure: "infra" }));
        q.back(report("r1", 1));
        expect(q.r.breakerTripped).toBe(false);
        expect(q.r.infraInARow).toBe(0);
        expect(canAdmit(q.r, 0, 4)).toBe(true);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.agentFailureResetsTheStreak
      name: "a helper that failed the task is not trouble and clears the count",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C"]);
        q.start();
        q.start();
        q.back(report("r1", 0, { ended: "failed", failure: "infra" }));
        q.back(report("r1", 1, { ended: "failed", failure: "agent" }));
        expect(q.r.breakerTripped).toBe(false);
        expect(q.r.infraInARow).toBe(0);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.newBatchResetsTheTrip
      name: "a new round tries the agents again instead of inheriting the trip",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C"]);
        q.start();
        q.start();
        q.back(report("r1", 0, { ended: "failed", failure: "infra" }));
        q.back(report("r1", 1, { ended: "failed", failure: "infra" }));
        expect(q.r.breakerTripped).toBe(true);
        q.open("r2", ["D"]);
        expect(q.r.breakerTripped).toBe(false);
        expect(canAdmit(q.r, 0, 4)).toBe(true);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.refusedWaveSettles (every start refused: the round still comes back)
      name: "a round whose every start was refused comes back, so a failed start cannot pin the lead",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start();
        q.back(report("r1", 0, { ended: "failed", failure: "infra", words: "Codex is not signed in." }));
        q.start();
        q.back(report("r1", 1, { ended: "failed", failure: "infra", words: "Codex is not signed in." }));
        expect(hasOpenWork(q.r)).toBe(false);
        expect(q.round("r1")?.back).toBe(true);
      },
    },
    {
      // GoSpark: BuddyBatchingTests.dropWaitingInBatch (the person's Stop all of one round leaves the others alone)
      name: "dropping one round's waiting helpers leaves the other rounds alone",
      run: () => {
        const q = new Q();
        q.open("r1", ["a", "b"]);
        q.open("r2", ["c"]);
        expect(q.drop("r1")).toBe(2);
        expect(q.r.waiting.map((w) => w.round)).toEqual(["r2"]);
        // nothing of r1 started, so it has nothing to tell the lead and goes
        expect(q.round("r1")).toBeUndefined();
        expect(q.round("r2")?.back).toBe(false);
      },
    },
    {
      // Design R5 and R7 (item 102h): the person's Stop on one waiting row drops that helper alone, counted as the person's
      name: "the person's Stop on one waiting helper drops it alone and the round goes on",
      run: () => {
        const q = new Q();
        q.open("r1", ["a", "b", "c"]);
        expect(q.drop("r1", 1)).toBe(1);
        expect(q.r.waiting.map((w) => w.index)).toEqual([0, 2]);
        expect(q.round("r1")?.dropped).toEqual({ breaker: 0, person: 1 });
        // an index that is not waiting drops nothing
        expect(q.drop("r1", 1)).toBe(0);
        expect(q.start()?.index).toBe(0);
        expect(q.start()?.index).toBe(2);
      },
    },
    // Not ported: BuddyBatchingTests.takeSettledWave. It is GoSpark's company waves, whose reports went to a wave driver instead
    // of the lead; this design has no such caller.
    {
      // Design R9: the person's Stop all counts the helpers that never started on the round
      name: "the person's Stop all drops every waiting helper and counts them on their rounds",
      run: () => {
        const q = new Q();
        q.open("r1", ["a", "b", "c"]);
        q.start(0, 1);
        expect(q.drop()).toBe(2);
        expect(q.round("r1")?.dropped).toEqual({ breaker: 0, person: 2 });
        q.back(report("r1", 0, { ended: "stopped" }));
        expect(q.take()?.[0].dropped).toEqual({ breaker: 0, person: 2 });
      },
    },
    {
      // Design R9: a report belongs to its round and its helper; one from a helper that never started in that round is not kept
      name: "a report from a helper still waiting to start is not kept",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start(0, 1);
        expect(q.back(report("r1", 1))).toBe(false);
        expect(q.back(report("r1", 7))).toBe(false);
        expect(q.round("r1")?.reports).toEqual([]);
      },
    },
    {
      // Design R4: at most two rounds for one message of the person's, and a new message gets two more
      name: "starts at most two rounds for one message of the person's",
      run: () => {
        const q = new Q();
        expect(mayStartRound(q.r)).toBe(true);
        expect(q.open("r1", ["A"]).refused).toBeUndefined();
        expect(q.open("r2", ["B"]).refused).toBeUndefined();
        expect(mayStartRound(q.r)).toBe(false);
        const third = q.open("r3", ["C"]);
        expect(third.refused).toBe("roundsSpent");
        expect(third.heldBack).toBe(1);
        expect(q.round("r3")).toBeUndefined();
        expect(q.r.waiting.map((w) => w.round)).toEqual(["r1", "r2"]);
        q.r = personSpoke(q.r);
        expect(mayStartRound(q.r)).toBe(true);
        expect(q.open("r3", ["C"]).refused).toBeUndefined();
      },
    },
    {
      // Added: a round opened twice under one id (a second press of the same card) opens nothing
      name: "refuses to open a round already open",
      run: () => {
        const q = new Q();
        q.open("r1", ["A"]);
        const again = q.open("r1", ["A"]);
        expect(again.refused).toBe("sameRound");
        expect(q.r.waiting).toHaveLength(1);
        expect(q.r.roundsThisMessage).toBe(1);
      },
    },
    {
      // Design R7: the cap is held to the ceiling, whatever a caller passes
      name: "never starts a fifth helper, even with a cap above the ceiling",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C", "D", "E", "F"]);
        let running = 0;
        while (q.start(running, 8)) running += 1;
        expect(running).toBe(AT_ONCE_CEILING);
        expect(canAdmit(q.r, 4, 99)).toBe(false);
      },
    },
    {
      // Design R7's test: with the cap at 2, a round of 4 starts 2, starts the third when one ends, and never runs 3
      name: "with the cap at 2, a round of 4 never runs 3 at once",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B", "C", "D"]);
        const cap = agentsAtOnce(8 * GB);
        const out = new Set<number>();
        const fill = () => {
          for (let next = q.start(out.size, cap); next; next = q.start(out.size, cap)) out.add(next.index);
          expect(out.size).toBeLessThanOrEqual(2);
        };
        fill();
        expect([...out]).toEqual([0, 1]);
        for (const i of [0, 1, 2, 3]) {
          out.delete(i);
          q.back(report("r1", i));
          fill();
        }
        expect(q.round("r1")?.back).toBe(true);
      },
    },
    {
      // Design R9: every landing is settled before the hand-over
      name: "waits for every landing to be settled",
      run: () => {
        const q = new Q();
        q.open("r1", ["A", "B"]);
        q.start();
        q.start();
        q.back(report("r1", 0, { landing: "pending" }));
        q.back(report("r1", 1, { landing: null }));
        expect(q.take()).toBeNull();
        q.r = settleLanding(q.r, "r1", 0, landing({ files: [{ path: "a.ts", added: 1, removed: 0 }] }));
        const handed = q.take();
        expect(handed?.[0].reports[0].landing).toEqual(landing({ files: [{ path: "a.ts", added: 1, removed: 0 }] }));
      },
    },
    {
      // Design R9: the lead is idle, nothing of the lead's waits on the person, and no message of the person's waits for it
      name: "hands over only while the lead is idle, not asking, and has no message of the person's waiting",
      run: () => {
        const q = new Q();
        q.open("r1", ["A"]);
        q.start();
        q.back(report("r1", 0));
        expect(canHandOver(q.r, { ...IDLE, idle: false }, 0)).toBe(false);
        expect(canHandOver(q.r, { ...IDLE, asking: true }, 0)).toBe(false);
        expect(canHandOver(q.r, { ...IDLE, personWaiting: true }, 0)).toBe(false);
        expect(canHandOver(q.r, IDLE, 0)).toBe(true);
      },
    },
  ];

  it.each(cases)("$name", ({ run }) => run());
});

// ---------------------------------------------------------------------------------------------------------------------------
// The slice's safety tests
// ---------------------------------------------------------------------------------------------------------------------------

describe("safety: a wait on the person never costs a helper and never lets a round go on without the person", () => {
  it("does not move the budget's clock while an ask waits: 30 minutes of the stand-in clock send no note and fire no stop", () => {
    // Design R5's test. The helper is a minute short of every threshold when its ask comes.
    const c = new Clocked().steps(23).steps(26, true).wait(11 * MIN);
    expect(c.act()).toEqual([]);
    const before = c.clock;
    c.ask("a1");
    for (let m = 0; m < 30; m++) {
      c.wait(MIN).steps(5);
      expect(c.clock).toBe(before);
      expect(c.due).toEqual([]);
    }
    expect(c.b.steps).toBe(49);
    expect(budgetSpent(c.b)).toBe(false);
    // Answered, the helper carries on from where it was: the word to wrap up falls due at 12 minutes of its own time.
    c.answer("a1").wait(MIN - 1);
    expect(c.act()).toEqual([]);
    c.wait(1);
    expect(c.act()).toEqual(["wrapUp"]);
  });

  it("does not fire a stop while an ask waits, even one that came at the last second, nor its report's stop", () => {
    const c = new Clocked().steps(89).wait(20 * MIN - 1).ask("a1").wait(60 * MIN);
    expect(c.due).toEqual([]);
    c.steps(10);
    expect(c.due).toEqual([]);
    c.answer("a1").steps(1);
    expect(c.act()).toEqual(["stop"]);
    c.ask("q1").wait(60 * MIN);
    expect(c.due).toEqual([]);
  });

  it("never hands a round over while any helper's ask waits", () => {
    const q = new Q();
    q.open("r1", ["A", "B"]);
    q.start();
    q.start();
    q.back(report("r1", 0));
    // Helper 2's ask waits: it is not back, and nothing is handed over however idle the lead is.
    expect(q.take(IDLE, 1)).toBeNull();
    q.back(report("r1", 1));
    // Every helper is back, but an ask of one of them still waits on the person (a question left after its turn): no hand-over.
    for (const asks of [1, 2, Number.NaN]) {
      expect(canHandOver(q.r, IDLE, asks)).toBe(false);
      expect(q.take(IDLE, asks)).toBeNull();
    }
    expect(q.round("r1")?.reports).toHaveLength(2);
    // Once the person has settled it, the reports go, once.
    expect(q.take(IDLE, 0)?.[0].reports.map((x) => x.index)).toEqual([0, 1]);
    expect(q.take(IDLE, 0)).toBeNull();
  });
});
