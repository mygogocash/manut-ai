// A lane's state (the design canvas's Code, StatesCode and KitCode boards): what the events of a coding session have
// shown, the state the owner reads from that at a glance, and the line under the lane's row.
//
// Three things are kept per lane and nothing else: the test runs in flight, the last run that ended with what its output
// said (testRun.ts), and whether a file changed after it. The rest of a state is what the app already knows, and the
// functions here take it as facts, as thread/status.ts does for a thread: a turn running, the asks that wait, how the
// session ended. A test's output is read when its step ends and is never kept, since it can hold anything a test prints.
import type { Key } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import type { Say } from "./command";
import { readTestOutput, runnerOf, runsTests, testsRunOutside, type TestRead } from "./testRun";

/** What a lane's events have shown. */
export interface LaneRecord {
  /** The test runs in flight, by step id, each with the command that runs it. */
  steps: Record<string, string>;
  /** The last test run that ended, and when (ms). */
  run?: { read: TestRead; at: number };
  /** A file changed after that run, so what it said is of older code. */
  changed: boolean;
  /** The person took a turn back at this time (ms), and none has started since. */
  revertedAt?: number;
  /** That rewind put the files back too. Rewind to before a turn (sessions/rewind.ts) puts the folder's files back before it
   *  asks the agent to take the chat back to a named message, so its `rewound` names that message (`id`); the agent's own
   *  rewind of the last message names none and leaves the files as they are. */
  revertedFiles?: boolean;
  /** The person brought the files back (Bring it back, sessions/rewind.ts) at this time (ms), and no turn has started since: the
   *  files are as they were just before the rewind, and the chat is still where the rewind left it. */
  backAt?: number;
}

export const emptyLane = (): LaneRecord => ({ steps: {}, changed: false });

type LaneEvent = { event: string; [k: string]: unknown };

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const changed = (lane: LaneRecord): LaneRecord => (lane.changed ? lane : { ...lane, changed: true });

/** A reading as the lane keeps it: its names without any key a test's own name may hold. */
const kept = (read: TestRead): TestRead => (read.kind === "failed" ? { ...read, names: read.names.map(maskSecrets) } : read);

/** Where a lane works (its own folder, else the session's), and the home folder for a `~` in a command. */
export interface LaneWhere {
  root: string;
  home?: string | null;
}

/** Whether `command` runs the lane's own tests: it runs tests, and none of them in another folder than the lane's. */
const ownRun = (command: string, where: LaneWhere | undefined): boolean => runsTests(command) && !(where && testsRunOutside(command, where.root, where.home));

/** `lane` after one event of its session. The same object when the event changes nothing, so a store can tell. `where`:
 *  the folder the lane works in, so a test run its words send elsewhere (the developer's own folder) is not read as the
 *  lane's. */
export function noteLane(lane: LaneRecord, ev: LaneEvent, now: number, where?: LaneWhere): LaneRecord {
  switch (ev.event) {
    case "tool.start": {
      const id = text(ev.tool_id);
      const detail = text(ev.detail);
      // a step's `name` is the shell's own kind for it: a command is `terminal`, a file edit `patch`
      if (ev.name === "terminal" && id && ownRun(detail, where)) return { ...lane, steps: { ...lane.steps, [id]: detail } };
      return ev.name === "patch" ? changed(lane) : lane;
    }
    case "tool.diff":
      return changed(lane);
    case "subagent":
      // a subagent's own edits come in its events, not as the lane's
      return Array.isArray(ev.diff) && ev.diff.length > 0 ? changed(lane) : lane;
    case "tool.end": {
      const id = text(ev.tool_id);
      // the command the step began with, when that read as a test run; the shell cuts a step's detail short, so the
      // step's end may carry the whole command, which is read in its place and may be a test run the start's was not
      const began = lane.steps[id];
      const command = text(ev.command) || began;
      if (command === undefined || !runsTests(command)) return lane;
      const { [id]: _done, ...steps } = lane.steps;
      // the whole command, read at the end, ran its tests in another folder: no run of the lane's
      if (!ownRun(command, where)) return began === undefined ? lane : { ...lane, steps };
      // the person said no, so the command never ran: it is no test run, and an earlier result stands
      if (ev.declined === true) return { ...lane, steps };
      const read = readTestOutput(typeof ev.output === "string" ? ev.output : undefined, { ok: typeof ev.ok === "boolean" ? ev.ok : undefined, runner: runnerOf(command) });
      return { ...lane, steps, run: { read: kept(read), at: now }, changed: false };
    }
    case "turn.start":
      return lane.revertedAt === undefined && lane.backAt === undefined ? lane : { ...lane, revertedAt: undefined, revertedFiles: undefined, backAt: undefined };
    case "files.back":
      // Bring it back put the files as they were just before the rewind back: the lane is no longer reverted. Its tests were
      // cleared by the rewind and the files that came back are of no run, so it reads by its tests again (Not run yet); the
      // chat did not come back, and its line says so
      return lane.revertedAt === undefined ? lane : { ...lane, revertedAt: undefined, revertedFiles: undefined, backAt: now };
    case "turn.end":
      // a run still in flight when its turn ended (Stop) has no end that counts
      return Object.keys(lane.steps).length > 0 ? { ...lane, steps: {} } : lane;
    case "rewound":
      // the work the turn did is taken back, so what its tests said is of nothing that is there now
      return text(ev.id) ? { steps: {}, changed: false, revertedAt: now, revertedFiles: true } : { steps: {}, changed: false, revertedAt: now };
    default:
      return lane;
  }
}

/** What the lane's tests say now. */
export type LaneTest =
  /** No test has run in this lane. */
  | "none"
  | "running"
  /** A test ran, and a file changed after it. */
  | "stale"
  | "passed"
  | "failed"
  /** A test ran and its output could not be read. */
  | "unknown";

export function testState(lane: LaneRecord): LaneTest {
  if (Object.keys(lane.steps).length > 0) return "running";
  if (!lane.run) return "none";
  return lane.changed ? "stale" : lane.run.read.kind;
}

/** The facts a lane's state is read from. */
export interface LaneFacts {
  /** The session could not start, or ended in an error. */
  ended: boolean;
  /** A turn runs now. */
  working: boolean;
  /** Questions and approvals of the lane that wait on the person. */
  asks: number;
  /** The person took the last turn back, and none has started since. */
  reverted: boolean;
  test: LaneTest;
}

export type LaneStatus = "needs_you" | "working" | "failed" | "reverted" | "checked" | "tests_failed" | "unconfirmed" | "not_run";

/** The state a lane's row shows. This function alone decides it. Checked is only a run that passed, and says nothing of
 *  code that changed after it, a run that could not be read, or no run. */
export function laneStatus(f: LaneFacts): LaneStatus {
  if (f.asks > 0) return "needs_you";
  if (f.working) return "working";
  if (f.ended) return "failed";
  if (f.reverted) return "reverted";
  switch (f.test) {
    case "passed":
      return "checked";
    case "failed":
      return "tests_failed";
    case "unknown":
      return "unconfirmed";
    default:
      return "not_run";
  }
}

/** A state's tag: its words, and its colour as the canvas's `.tag` classes name it (none: the plain tag). */
export function laneTag(status: LaneStatus): { key: Key; tone: "ok" | "err" | "run" | "warn" | "" } {
  switch (status) {
    case "needs_you":
      return { key: "ss.needsYou", tone: "warn" };
    case "working":
      return { key: "ss.working", tone: "run" };
    case "checked":
      return { key: "lane.tag.checked", tone: "ok" };
    case "tests_failed":
      return { key: "lane.tag.testsFailed", tone: "err" };
    case "failed":
      return { key: "lane.tag.failed", tone: "err" };
    case "reverted":
      return { key: "lane.tag.reverted", tone: "" };
    case "unconfirmed":
      return { key: "lane.tag.unconfirmed", tone: "" };
    case "not_run":
      return { key: "lane.tag.notRun", tone: "" };
  }
}

export interface LaneLineInput {
  status: LaneStatus;
  lane: LaneRecord;
  /** The lane has a branch to say it works on. */
  branch: boolean;
  /** The words of the ask that waits first. */
  ask?: string;
  /** When the turn was reverted, or its files brought back, as the person reads a time. */
  time?: string;
  /** The session's own words for how it ended; the row shows them, not a line of this one's. */
  error?: string;
}

/** The line under a lane's row, as a dictionary key and its slots, or null when there is nothing to add. */
export function laneLine(i: LaneLineInput): Say | null {
  const read = i.lane.run?.read;
  switch (i.status) {
    case "needs_you":
      return { key: "lane.line.asks", vars: { ask: i.ask ?? "" } };
    case "working":
      return { key: i.branch ? "lane.line.working" : "lane.line.workingHere" };
    case "reverted":
      return { key: i.lane.revertedFiles ? "lane.line.revertedFiles" : "lane.line.reverted", vars: { time: i.time ?? "" } };
    case "checked":
      if (read?.kind !== "passed" || read.passed === null) return { key: "lane.line.checkedSome" };
      return read.passed === 1 ? { key: "lane.line.checked1" } : { key: "lane.line.checkedN", vars: { n: read.passed } };
    case "tests_failed": {
      if (read?.kind !== "failed" || read.failed === null) return { key: "lane.line.failedSome" };
      if (read.total !== null && read.total >= read.failed) return { key: "lane.line.failedOf", vars: { failed: read.failed, total: read.total } };
      return read.failed === 1 ? { key: "lane.line.failed1" } : { key: "lane.line.failedN", vars: { n: read.failed } };
    }
    case "unconfirmed":
      return { key: "lane.line.unconfirmed" };
    case "not_run":
      // the files came back after a rewind and the chat did not: said until the next turn starts
      if (i.lane.backAt !== undefined) return { key: "lane.line.broughtBack", vars: { time: i.time ?? "" } };
      return testState(i.lane) === "stale" ? { key: "lane.line.stale" } : null;
    case "failed":
      return null;
  }
}

/** The failing tests the row names (a few, since the terminal has them all) and how many more there were. Only the
 *  last run's, and only while it is of the code as it is. */
export function failedNames(lane: LaneRecord, shown = 3): { names: string[]; more: number } {
  const read = lane.run?.read;
  if (read?.kind !== "failed" || lane.changed) return { names: [], more: 0 };
  const names = read.names.slice(0, shown);
  return { names, more: names.length === 0 ? 0 : Math.max(0, (read.failed ?? read.names.length) - names.length) };
}
