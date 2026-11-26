// Helper lanes, the pure rules (item 102d; `docs/several-agents.md`, "The rules", R4 to R7 and R9). Nothing here starts an agent,
// reads the Mac, keeps a timer or calls the shell: the runtime that runs helper lanes (102h) tells these functions what happened,
// with the time as a number, and does what they answer. Every value is plain data, so a round can be saved with its sessions and
// read back after a restart (102j), and a test drives a whole round with a stand-in clock.
//
// Ported from GoSpark's Buddy (ours, `mygogocash/gospark` at a7537c80): the round queue is `BuddyBatchQueue`
// (`GoGoCode/Models/BuddyBatching.swift`); the budget is `BuddyBudget`'s numbers (`GoGoCode/Models/Buddy.swift`) with the way its
// runtime applies them (`ThreadRuntime.swift`'s head watchdog, `OpenAICompatibleSession.swift`, `APIKeyToolTally`); the cap is
// `BuddyHeadCap`; the landing predicates are `BuddyLanding`'s; what the lead is told about each helper is read the way
// `BuddyPrompts.reportMessage` reads it; and what counts as trouble that is not the task is `BuddyFailureClass`. Where this
// design differs from GoSpark, the comment at that place says how and why. The words a person or an agent reads (the budget's
// notes, the rows, the message to the lead) are not here: they go through `src/i18n/` in the slices that show or send them.

// ---------------------------------------------------------------------------------------------------------------------------
// How many at once on this Mac (R7)
// ---------------------------------------------------------------------------------------------------------------------------

const GIB = 1024 ** 3;

/** The most helper lanes and Ask several lanes that ever run at once, on any Mac: GoSpark's default of 4. */
export const AT_ONCE_CEILING = 4;

/** How many run at once from the Mac's memory alone (R7): 2 with 8 GB or less, 3 up to 16 GB, 4 above. Each is a whole agent CLI
 *  plus what it runs, and Buddy's chat already keeps two whole Claude Code processes on 8 GB. Memory the shell could not read counts
 *  as the smallest Mac this app runs on, so a failed read never lets more run than an 8 GB Mac can hold. */
export function atOnceFromMemory(memoryBytes: number | null | undefined): number {
  if (typeof memoryBytes !== "number" || !Number.isFinite(memoryBytes) || memoryBytes <= 0) return 2;
  if (memoryBytes <= 8 * GIB) return 2;
  if (memoryBytes <= 16 * GIB) return 3;
  return AT_ONCE_CEILING;
}

/** A number Settings may keep: a whole number from 1 to the ceiling. */
const isSetting = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= AT_ONCE_CEILING;

/** How many run at once on this Mac: the memory's number, lowered by Settings' number when that is lower. As GoSpark's
 *  `BuddyHeadCap.resolve` reads its app-wide cap, zero or less (or anything not a whole number) is no setting, and a number above
 *  the ceiling is the ceiling. Unlike GoSpark, where the app-wide cap is the number itself when no pair sets one, Settings here
 *  never raises it above what the memory allows: the memory's number is the safety rule, and Settings may only be stricter. */
export function agentsAtOnce(memoryBytes: number | null | undefined, setting?: number | null): number {
  const fromMemory = atOnceFromMemory(memoryBytes);
  if (typeof setting !== "number" || !Number.isInteger(setting) || setting <= 0) return fromMemory;
  return Math.min(fromMemory, setting, AT_ONCE_CEILING);
}

/** What Settings keeps for its number: the number, or null for no setting (GoSpark's `BuddyHeadCap.persist`). */
export const keptAtOnce = (setting: number | null | undefined): number | null => (isSetting(setting) ? setting : null);

/** Reads a kept number back. Anything missing, not a whole number or outside 1 to 4 is no setting, which is the memory's number,
 *  rather than a limit nobody chose (GoSpark's `BuddyHeadCap.restore`). */
export const readAtOnce = (stored: unknown): number | null => (isSetting(stored) ? stored : null);

// ---------------------------------------------------------------------------------------------------------------------------
// The budget of one helper lane (R5)
// ---------------------------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;

/** GoSpark's `BuddyBudget`, unchanged. A step is one tool call of the helper's chat or of its own subagents. */
export const BUDGET = {
  /** steps with no file changed before a nudge to report or act, and again after each further this many */
  nudgeSteps: 24,
  /** a word to wrap up at this many steps, or at `wrapUpMs` */
  wrapUpSteps: 50,
  wrapUpMs: 12 * MINUTE,
  /** the stop at this many steps, or at `stopMs` */
  stopSteps: 90,
  stopMs: 20 * MINUTE,
  /** what a helper stopped by its budget has to write its report in */
  reportMs: 3 * MINUTE,
  /** After the person answers an ask, a time stop waits at least this long, so the answer is acted on (GoSpark's
   *  `BuddyHangWatchdog.answeredGrace`: "a head answered with seconds left would otherwise be cut off before it could act"). */
  answeredGraceMs: MINUTE,
} as const;

/** What the runtime is to do now. `nudge` and `wrapUp` are notes sent as a steer; `stop` stops the helper's turn (the chat's own
 *  Stop) and then sends the one message that the budget is spent; `reportStop` stops the turn that message started. */
export type BudgetAction = "nudge" | "wrapUp" | "stop" | "reportStop";

export interface Budget {
  /** `working` on its task; `reporting` after its budget's stop, writing its report; `over` once the report's time ran out too */
  readonly phase: "working" | "reporting" | "over";
  /** steps counted, never while an ask waits */
  readonly steps: number;
  /** steps since a file last changed */
  readonly sinceChange: number;
  /** `sinceChange` at which the next nudge is due */
  readonly nudgeAt: number;
  /** the word to wrap up has gone */
  readonly wrappedUp: boolean;
  /** the clock's time counted before `since` */
  readonly clockMs: number;
  /** when the clock last started; null while it stands still because an ask waits */
  readonly since: number | null;
  /** the helper's asks and questions waiting on the person, by id */
  readonly asks: readonly string[];
  /** the clock's reading when the report was asked for */
  readonly reportFromMs: number;
  /** no time stop before the clock reads this: a minute after the person's last answer */
  readonly graceToMs: number;
}

/** A helper lane's budget as its turn starts. It covers that turn and the report its stop asks for; a later message from the
 *  person to the helper lane starts a fresh one, as GoSpark clears a head's budget mark when it is told more. */
export const newBudget = (now: number): Budget => ({
  phase: "working",
  steps: 0,
  sinceChange: 0,
  nudgeAt: BUDGET.nudgeSteps,
  wrappedUp: false,
  clockMs: 0,
  since: now,
  asks: [],
  reportFromMs: 0,
  graceToMs: 0,
});

/** The budget's clock at `now`: the time the helper had to work, with every wait on the person left out. A clock that went
 *  back counts nothing for that stretch rather than taking time away. */
export const budgetClock = (b: Budget, now: number): number => b.clockMs + (b.since === null ? 0 : Math.max(0, now - b.since));

/** One step: a tool call of the helper's chat or of its subagents (`tool.start`, `subagent`). `changedFile` is whether it changed
 *  a file, which restarts the nudge's count (GoSpark's `APIKeyToolTally.count`). While an ask waits the count stands still, so
 *  a subagent still working beside a waiting ask never spends the helper's steps for it. */
export function budgetStep(b: Budget, changedFile: boolean): Budget {
  if (b.asks.length) return b;
  return changedFile
    ? { ...b, steps: b.steps + 1, sinceChange: 0, nudgeAt: BUDGET.nudgeSteps }
    : { ...b, steps: b.steps + 1, sinceChange: b.sinceChange + 1 };
}

/** An ask or a question of the helper now waits on the person. The first one stops the clock where it is. This is the design's
 *  addition to GoSpark, whose watchdog only waited for an answer once time was up: here a slow answer never costs a helper any
 *  of its minutes. */
export function budgetAskOpened(b: Budget, id: string, now: number): Budget {
  if (b.asks.includes(id)) return b;
  if (b.asks.length) return { ...b, asks: [...b.asks, id] };
  return { ...b, asks: [id], clockMs: budgetClock(b, now), since: null };
}

/** An ask or a question of the helper was settled (answered, or ended with its turn). When none is left the clock starts again,
 *  and no time stop comes within a minute of it. */
export function budgetAskSettled(b: Budget, id: string, now: number): Budget {
  if (!b.asks.includes(id)) return b;
  const asks = b.asks.filter((a) => a !== id);
  if (asks.length) return { ...b, asks };
  return { ...b, asks, since: now, graceToMs: b.clockMs + BUDGET.answeredGraceMs };
}

/** What is due now, in GoSpark's order: a stop alone, else the word to wrap up and then a nudge. Nothing is due while an ask
 *  waits: the budget never answers, withdraws or outruns an ask, so a stop never ends one. `steers` is whether the helper's agent
 *  takes text into a running turn (`steersOf`); one that does not gets only the stops. Call `budgetDone` for each action done. */
export function budgetDue(b: Budget, now: number, steers: boolean): BudgetAction[] {
  if (b.asks.length || b.phase === "over") return [];
  const clock = budgetClock(b, now);
  const timeUp = (limit: number) => clock >= limit && clock >= b.graceToMs;
  if (b.phase === "reporting") return timeUp(b.reportFromMs + BUDGET.reportMs) ? ["reportStop"] : [];
  if (b.steps >= BUDGET.stopSteps || timeUp(BUDGET.stopMs)) return ["stop"];
  if (!steers) return [];
  const due: BudgetAction[] = [];
  if (!b.wrappedUp && (b.steps >= BUDGET.wrapUpSteps || clock >= BUDGET.wrapUpMs)) due.push("wrapUp");
  if (b.sinceChange >= b.nudgeAt) due.push("nudge");
  return due;
}

/** The runtime did `action` at `now`. A nudge is due again after as many more steps with no file changed (GoSpark's
 *  `pacingAt = sinceChange + pacingTools`); the word to wrap up goes once; the stop starts the report's three minutes. */
export function budgetDone(b: Budget, action: BudgetAction, now: number): Budget {
  switch (action) {
    case "nudge":
      return { ...b, nudgeAt: b.sinceChange + BUDGET.nudgeSteps };
    case "wrapUp":
      return { ...b, wrappedUp: true };
    case "stop":
      return b.phase === "working" ? { ...b, phase: "reporting", reportFromMs: budgetClock(b, now) } : b;
    case "reportStop":
      return b.phase === "reporting" ? { ...b, phase: "over" } : b;
  }
}

/** Whether the budget stopped the helper: its report is whatever it had, marked "stopped by its budget", and the lead must not
 *  read it as a finished task (GoSpark's `budgetExhausted`). */
export const budgetSpent = (b: Budget): boolean => b.phase !== "working";

// ---------------------------------------------------------------------------------------------------------------------------
// Trouble that is not the task (R6)
// ---------------------------------------------------------------------------------------------------------------------------

/** `infra`: the helper never got to try (the agent did not start, was not signed in, its account was limited, its folder was
 *  refused, it ended at once). `agent`: it tried, and its report is a real finding. The runtime sets `infra` itself for the
 *  troubles the app knows of; `failureKindOf` reads an agent's own failure words. */
export type FailureKind = "infra" | "agent";

/** GoSpark's fragments, verbatim and lower case, that name provider, transport or setup trouble. Not here, so they read as the
 *  helper's own outcome: a stop by its budget, and shape errors (a full context window, an unknown model, a turn that simply
 *  stopped), which are about the request, not the plumbing. */
const INFRA_WORDS = [
  // rate and usage pressure, friendly or raw
  "429", "too many requests", "rate limit", "rate-limit", "rate_limit", "ratelimited",
  "wait a moment and try again",
  // overload and dead servers
  "overloaded", "overload", "over capacity",
  "529", "server error", "internal error", "bad gateway", "service unavailable",
  "gateway timeout", "temporarily unavailable",
  "status 500", "status 502", "status 503", "status 504",
  "error 500", "error 502", "error 503", "error 504",
  "http 500", "http 502", "http 503", "http 504",
  // spent plans and empty wallets
  "quota", "out of credit", "no balance", "insufficient", "billing",
  "payment required", "plan limit", "limit is spent",
  "usage limit", "hit your limit", "usage_limit", "limit reached", "out of extra usage",
  // dead transports
  "connection reset", "connection refused", "could not connect", "failed to connect",
  "timed out", "timeout", "time out", "socket hang up", "connection lost",
  "broken pipe", "network error", "network failure", "network is unreachable",
  "offline", "getaddrinfo",
  "enotfound", "econnreset", "econnrefused", "etimedout", "ehostunreach",
  "econnaborted", "eai_again", "epipe",
  // setup: keys, CLIs, sign-in, isolation
  "unauthorized", "invalid api key", "invalid_api_key", "incorrect api key",
  "authentication failed", "needs an api key",
  "is not installed", "install it and sign in",
  "was not found on your path", "signed out", "not signed in",
  "could not isolate",
] as const;

/** Splits an agent's failure words into plumbing or task (GoSpark's `BuddyFailureClass.classify`). Unknown words are the
 *  helper's own outcome: a missed outage costs a retry, but a task failure dressed as an outage would teach the lead the wrong
 *  lesson about what a helper can do. */
export function failureKindOf(words: string): FailureKind {
  const lower = words.toLowerCase();
  return INFRA_WORDS.some((w) => lower.includes(w)) ? "infra" : "agent";
}

// ---------------------------------------------------------------------------------------------------------------------------
// Landings and reports (R8, R9)
// ---------------------------------------------------------------------------------------------------------------------------

export interface LandedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/** Where a helper lane's work went (GoSpark's `BuddyLanding`). */
export interface Landing {
  /** the files its patch changed, with what the change amounted to */
  readonly files: readonly LandedFile[];
  /** files the three-way apply left conflict markers in */
  readonly conflicts: readonly string[];
  /** where the patch was kept when it would not apply, or when it was kept without being tried */
  readonly patchPath?: string;
  readonly error?: string;
  /** why the patch was kept without being tried: it names a file outside the lead's project, or comes from another repository */
  readonly refusal?: string;
}

/** The helper changed nothing. */
export const landingEmpty = (l: Landing): boolean => !l.files.length && !l.patchPath && !l.error && !l.refusal;

/** The work is in the lead's folder, conflict markers or not: the markers are there, so the lead settles them rather than having
 *  the helper run again. */
export const landed = (l: Landing): boolean => l.files.length > 0 && !l.patchPath && !l.error && !l.refusal;

/** How a landing reads on its row and to the lead: "Landed 3 files", "Changed nothing", "Kept as a patch: it would not apply",
 *  kept without being tried because it reaches outside the project, or a landing that failed. Conflicts are a landing's, named
 *  from `conflicts`. */
export type LandingOutcome = "landed" | "changedNothing" | "keptPatch" | "keptOutside" | "failed";

export function landingOutcome(l: Landing | null): LandingOutcome {
  if (!l || landingEmpty(l)) return "changedNothing";
  if (l.refusal) return "keptOutside";
  if (l.patchPath) return "keptPatch";
  if (l.error) return "failed";
  return "landed";
}

/** How a helper lane's turn ended: by itself (`done`, also after its budget's stop, which leaves it marked), `failed`, or
 *  `stopped` by the person's Stop. */
export type Ended = "done" | "failed" | "stopped";

/** What a helper lane sends back to its lead. It belongs to its round and its place in that round (Orca's dispatch id), so a
 *  report that comes late never fills another round. */
export interface HelperReport {
  readonly round: string;
  /** its place in its round, from 0: Helper 1 is 0 */
  readonly index: number;
  readonly title: string;
  readonly ended: Ended;
  /** its report: its last answer, or its failure's words */
  readonly words: string;
  /** for a failed helper, whether it never got to try */
  readonly failure?: FailureKind;
  readonly budgetSpent?: boolean;
  readonly steps?: number;
  /** where its work went; null when it had nothing to land; "pending" until its landing is settled */
  readonly landing: Landing | null | "pending";
}

/** How a helper ended, as its row and the lead read it. */
export type Ending = "done" | "budgetSpent" | "failed" | "couldNotRun" | "stoppedByPerson";

export function endingOf(r: Pick<HelperReport, "ended" | "failure" | "budgetSpent">): Ending {
  if (r.ended === "failed") return r.failure === "infra" ? "couldNotRun" : "failed";
  if (r.ended === "stopped") return "stoppedByPerson";
  return r.budgetSpent ? "budgetSpent" : "done";
}

/** What the lead is told to do with a helper's part (from `reportMessage`'s closing lines): build on it; do it or send it out
 *  again when the helper failed the task; send exactly that part again once the provider or setup is fixed, never do it serially,
 *  when the helper never got to try; leave it alone unless the person asks when the person stopped the helper. */
export type LeadsPart = "buildOn" | "doItOrSendAgain" | "sendAgainLater" | "leaveAlone";

export function leadsPart(r: Pick<HelperReport, "ended" | "failure" | "budgetSpent">): LeadsPart {
  switch (endingOf(r)) {
    case "failed":
      return "doItOrSendAgain";
    case "couldNotRun":
      return "sendAgainLater";
    case "stoppedByPerson":
      return "leaveAlone";
    default:
      return "buildOn";
  }
}

/** Files two or more helpers changed, by path: the split the lead was told not to make, so it hears which file and reads it as
 *  it is now before building on it. */
export function sharedFiles(reports: readonly HelperReport[]): { path: string; helpers: { round: string; index: number }[] }[] {
  const owners = new Map<string, { round: string; index: number }[]>();
  for (const r of reports) {
    if (!r.landing || r.landing === "pending") continue;
    for (const f of r.landing.files) owners.set(f.path, [...(owners.get(f.path) ?? []), { round: r.round, index: r.index }]);
  }
  return [...owners]
    .filter(([, helpers]) => helpers.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, helpers]) => ({ path, helpers }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rounds (R4, R6, R7, R9)
// ---------------------------------------------------------------------------------------------------------------------------

/** How many rounds one message of the person's may start: the first, and one more for what failed or what the reports showed
 *  was missing (GoSpark's `maxDelegationRounds`). Past that the lead finishes by itself, so no message chains helpers that check
 *  helpers that check helpers. */
export const MAX_ROUNDS = 2;

/** How many helper lanes one round takes: twice the ceiling, so a round can refill as helpers finish without chaining forever.
 *  GoSpark's is twice its hard cap of 8; this design's ceiling is 4, so 8. */
export const ROUND_MAX = AT_ONCE_CEILING * 2;

/** Helper lanes in a row that never got to try before the round stops: one is an anecdote, two is a pattern, and every further
 *  start would only make another lane to find the same outage. */
export const MAX_INFRA_IN_A_ROW = 2;

/** A helper lane waiting for its turn to start. `brief` is the round's own block for it, kept as the runtime gave it. */
export interface Waiting<B> {
  readonly round: string;
  readonly index: number;
  readonly brief: B;
  readonly queuedAt: number;
}

export interface Round {
  readonly id: string;
  /** helpers started and not back yet, by index */
  readonly out: readonly number[];
  /** the reports of the helpers that are back */
  readonly reports: readonly HelperReport[];
  /** helpers that never started: dropped by the breaker, or by the person's Stop all */
  readonly dropped: { readonly breaker: number; readonly person: number };
  /** every helper is back and none waits; the reports wait for the lead */
  readonly back: boolean;
}

/** One lead lane's rounds (GoSpark's `BuddyBatchQueue`). Plain data: each function returns a new value. */
export interface Rounds<B = unknown> {
  /** rounds open or back and not yet handed over, in the order they opened */
  readonly rounds: readonly Round[];
  /** helpers waiting to start, in order, across rounds */
  readonly waiting: readonly Waiting<B>[];
  /** helpers in a row that never got to try, since the last one that did */
  readonly infraInARow: number;
  /** no waiting helper starts until the next round */
  readonly breakerTripped: boolean;
  /** rounds started since the person's last message to the lead */
  readonly roundsThisMessage: number;
}

export const noRounds = <B = unknown>(): Rounds<B> => ({
  rounds: [],
  waiting: [],
  infraInARow: 0,
  breakerTripped: false,
  roundsThisMessage: 0,
});

/** A helper is out, or waiting to start: the lead's work is not finished until it has heard from all of them. */
export const hasOpenWork = (r: Rounds): boolean => r.waiting.length > 0 || r.rounds.some((x) => !x.back);

/** Nothing waiting, nothing out, nothing to hand over. */
export const isQuiet = (r: Rounds): boolean => !r.rounds.length && !r.waiting.length;

/** Whether a Start helpers card may be shown for the lead's blocks now: at most `MAX_ROUNDS` for one message of the person's. A
 *  third round's blocks show no card. */
export const mayStartRound = (r: Rounds): boolean => r.roundsThisMessage < MAX_ROUNDS;

/** The person wrote to the lead: a new message gets its own two rounds (GoSpark resets its count when a turn opens that is not
 *  the reports' turn). */
export const personSpoke = <B>(r: Rounds<B>): Rounds<B> => (r.roundsThisMessage ? { ...r, roundsThisMessage: 0 } : r);

/** Rounds whose every helper is back and none waits are back; one with no report at all has nothing to tell the lead and goes. */
function settle<B>(r: Rounds<B>): Rounds<B> {
  let changed = false;
  const rounds = r.rounds.flatMap((x) => {
    if (x.back || x.out.length || r.waiting.some((w) => w.round === x.id)) return [x];
    changed = true;
    return x.reports.length ? [{ ...x, back: true }] : [];
  });
  return changed ? { ...r, rounds } : r;
}

export type OpenRefusal = "roundsSpent" | "sameRound";

/** Opens a round once the person pressed Start helpers, and queues its helpers in order. A round takes at most `ROUND_MAX`;
 *  `heldBack` says how many did not fit, so the caller says so rather than dropping them silently. A new round tries the agents
 *  again rather than inheriting the last round's trip: an outage that persists trips again after two. Refused, opening nothing,
 *  past `MAX_ROUNDS` for this message of the person's, or for a round id already open.
 *
 *  Unlike GoSpark, every round is whole when it opens: helpers start only from the card after the lead's turn ended, never while
 *  the lead is still writing, so GoSpark's unsealed rounds (`extendBatch`, `sealBatch`) are not ported. */
export function openRound<B>(
  r: Rounds<B>,
  id: string,
  briefs: readonly B[],
  now: number,
): { rounds: Rounds<B>; heldBack: number; refused?: OpenRefusal } {
  if (r.rounds.some((x) => x.id === id)) return { rounds: r, heldBack: briefs.length, refused: "sameRound" };
  if (!mayStartRound(r)) return { rounds: r, heldBack: briefs.length, refused: "roundsSpent" };
  const admitted = briefs.slice(0, ROUND_MAX);
  const round: Round = { id, out: [], reports: [], dropped: { breaker: 0, person: 0 }, back: false };
  const next: Rounds<B> = {
    rounds: [...r.rounds, round],
    waiting: [...r.waiting, ...admitted.map((brief, index) => ({ round: id, index, brief, queuedAt: now }))],
    infraInARow: 0,
    breakerTripped: false,
    roundsThisMessage: r.roundsThisMessage + 1,
  };
  return { rounds: settle(next), heldBack: briefs.length - admitted.length };
}

/** Whether another waiting helper may start, given how many helper lanes and Ask several lanes run now across every job, and the
 *  cap for this Mac (`agentsAtOnce`). The cap is held to the ceiling here too, so no caller can run more than 4. */
export const canAdmit = (r: Rounds, running: number, cap: number): boolean =>
  r.waiting.length > 0 && running < Math.min(cap, AT_ONCE_CEILING) && !r.breakerTripped;

/** Takes the next waiting helper to start, or null when none may (`canAdmit`). From here it is out in its round, so the round
 *  does not count as back while its lane is being made; a start that fails is recorded with `recordBack` as trouble that is not
 *  the task. */
export function startNext<B>(r: Rounds<B>, running: number, cap: number): { rounds: Rounds<B>; next: Waiting<B> | null } {
  if (!canAdmit(r, running, cap)) return { rounds: r, next: null };
  const [next, ...waiting] = r.waiting;
  const rounds = r.rounds.map((x) => (x.id === next.round ? { ...x, out: [...x.out, next.index] } : x));
  return { rounds: { ...r, rounds, waiting }, next };
}

/** A helper is back with its report. It is kept only for its own round while that round's reports are still the lead's to hear:
 *  a report for a round already handed over, or from a helper that never started in it, is late, and is shown on its row and not
 *  sent (R9). GoSpark sends a late report to the lead on its own; here the person's Start helpers covered one hand-over a round,
 *  and a stale report must not fill another. A helper that reports again before the hand-over (the person wrote to it) replaces
 *  its earlier report, as GoSpark's steered head does.
 *
 *  Every report folds into the breaker: one that never got to try advances the count, anything else proves the plumbing answered
 *  and clears it. Two in a row trip it, and every helper still waiting is dropped and counted on its round (R6), so the round
 *  settles instead of staying open. */
export function recordBack<B>(r: Rounds<B>, report: HelperReport): { rounds: Rounds<B>; kept: boolean } {
  const round = r.rounds.find((x) => x.id === report.round);
  if (!round || !(round.out.includes(report.index) || round.reports.some((x) => x.index === report.index))) {
    return { rounds: r, kept: false };
  }
  const infra = report.failure === "infra";
  const infraInARow = infra ? r.infraInARow + 1 : 0;
  const breakerTripped = infra ? r.breakerTripped || infraInARow >= MAX_INFRA_IN_A_ROW : false;
  let rounds = r.rounds.map((x) =>
    x.id !== round.id
      ? x
      : { ...x, out: x.out.filter((i) => i !== report.index), reports: [...x.reports.filter((y) => y.index !== report.index), report] },
  );
  let waiting = r.waiting;
  if (breakerTripped && waiting.length) {
    rounds = rounds.map((x) => {
      const n = waiting.filter((w) => w.round === x.id).length;
      return n ? { ...x, dropped: { ...x.dropped, breaker: x.dropped.breaker + n } } : x;
    });
    waiting = [];
  }
  return { rounds: settle({ ...r, rounds, waiting, infraInARow, breakerTripped }), kept: true };
}

/** The person's Stop all: the helpers still waiting go without starting, those of one round or of every round, so a round stopped
 *  by hand does not refill from its own queue as its helpers stop. Returns how many went. */
export function dropWaiting<B>(r: Rounds<B>, round?: string): { rounds: Rounds<B>; dropped: number } {
  const going = r.waiting.filter((w) => round === undefined || w.round === round);
  if (!going.length) return { rounds: r, dropped: 0 };
  const rounds = r.rounds.map((x) => {
    const n = going.filter((w) => w.round === x.id).length;
    return n ? { ...x, dropped: { ...x.dropped, person: x.dropped.person + n } } : x;
  });
  const waiting = r.waiting.filter((w) => !going.includes(w));
  return { rounds: settle({ ...r, rounds, waiting }), dropped: going.length };
}

/** A helper's landing is settled: landed, kept, or nothing to land. */
export function settleLanding<B>(r: Rounds<B>, round: string, index: number, landing: Landing | null): Rounds<B> {
  let changed = false;
  const rounds = r.rounds.map((x) => {
    if (x.id !== round || !x.reports.some((y) => y.index === index)) return x;
    changed = true;
    return { ...x, reports: x.reports.map((y) => (y.index === index ? { ...y, landing } : y)) };
  });
  return changed ? { ...r, rounds } : r;
}

/** The lead lane as the hand-over reads it. */
export interface LeadNow {
  /** no turn of the lead runs */
  readonly idle: boolean;
  /** an ask or a question of the lead waits on the person */
  readonly asking: boolean;
  /** a message of the person's waits to go to the lead: it goes first */
  readonly personWaiting: boolean;
}

/** Whether the reports may go to the lead now (R9): every round is back with every landing settled, so one round never cuts
 *  another short; the lead is idle, nothing of the lead's waits on the person and no message of the person's waits for it; and no
 *  ask or question of any of its helper lanes waits on the person (`helperAsks`), so the lead never carries on while a helper's
 *  ask is still the person's to answer. */
export function canHandOver(r: Rounds, lead: LeadNow, helperAsks: number): boolean {
  return (
    r.rounds.length > 0 &&
    !r.waiting.length &&
    r.rounds.every((x) => x.back && x.reports.every((y) => y.landing !== "pending")) &&
    lead.idle &&
    !lead.asking &&
    !lead.personWaiting &&
    helperAsks === 0
  );
}

/** A round as it is handed to the lead: its reports in helper order, and how many of its helpers never started. */
export interface HandedRound {
  readonly id: string;
  readonly reports: readonly HelperReport[];
  readonly dropped: Round["dropped"];
}

/** Takes the rounds' reports for the lead's one message, or null while `canHandOver` says no. Unlike GoSpark's
 *  `markFlushScheduled` and `takeFlush`, taking is one step: once taken they are the lead's, and a report coming after is late. */
export function takeHandOver<B>(r: Rounds<B>, lead: LeadNow, helperAsks: number): { rounds: Rounds<B>; handed: HandedRound[] | null } {
  if (!canHandOver(r, lead, helperAsks)) return { rounds: r, handed: null };
  const handed = r.rounds.map((x) => ({ id: x.id, reports: [...x.reports].sort((a, b) => a.index - b.index), dropped: x.dropped }));
  return { rounds: { ...r, rounds: [] }, handed };
}
