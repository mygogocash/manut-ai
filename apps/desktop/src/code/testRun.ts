// A test run, read from its command and its output, for a lane's state (src/code/lane.ts).
//
// Two questions are asked apart. Whether a command runs tests is read from its words (`runsTests`): the dial's own
// reading (command.ts) answers whether Kit may run a command alone, and it calls an unquoted pattern unreadable, which
// a test run is not. What a run found is read from its output (`readTestOutput`): vitest, jest, node's own runner,
// pytest, `go test`, `cargo test`, mocha, Playwright Test and Python's unittest each print a summary, and the counts and
// the failing tests' names are taken from it. Pure: nothing runs and nothing is looked up.
//
// The rule that matters is the one about a pass. A run is read as passed only when its output says tests ran, says
// none failed, and its command did not end with an error. Anything else the parser cannot read is `unknown`, which
// never shows as Checked: a lane that says tests passed when they did not would send a developer to a pull request on
// a broken change. A failure is the other way round: it is read from what the output says, whatever the exit status
// said, because a command such as `vitest run || true` hides its failure from the status and not from its output.

import { insideProject } from "./command";

/** What the output of a test run says. */
export type TestRead =
  /** Tests ran and none failed; `passed` is how many, or null when the runner gives no count (`go test` without -v). */
  | { kind: "passed"; passed: number | null }
  /** The output says the run failed. `failed` of `total` tests (null when it gives no count), and which, when it names
   *  them: at most `MAX_NAMES`, each cut to a short line. */
  | { kind: "failed"; failed: number | null; total: number | null; names: string[] }
  /** The output does not say. It is never a pass. */
  | { kind: "unknown"; why: "no_output" | "no_summary" | "no_tests" | "errors" | "exit" };

export type Runner = "vitest" | "jest" | "node" | "pytest" | "go" | "cargo" | "mocha" | "playwright" | "unittest";

/** The most failing tests named, and the longest a name is. The lane shows a few; the terminal has the rest. */
export const MAX_NAMES = 10;
const NAME_MAX = 160;
/** How much of the end of an output is read. A summary is at the end, and the shell sends no more than its end. */
const TAIL_MAX = 64 * 1024;
/** A line longer than this is no summary and no name; skipping it keeps every pattern below linear in the output. */
const LINE_MAX = 2_000;

// ---- text ---------------------------------------------------------------------------------------------------------

// Colours and cursor moves (CSI), window titles and links (OSC), and the two-character escapes. A runner colours some
// of its lines even when its output goes to a pipe, vitest's expected and received values among them.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** `text` without its terminal escape sequences. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

const num = (s: string): number => Number.parseInt(s, 10);

/** `3 passed | 1 skipped` or `1 failed, 12 passed, 14 total` as `{ passed: 3, skipped: 1 }`. */
function counts(list: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of list.matchAll(/(\d+) ([a-z]+)/g)) out[m[2]] = (out[m[2]] ?? 0) + num(m[1]);
  return out;
}

/** A name as one short line. */
function nameOf(raw: string): string {
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX - 1)}…` : one;
}

// ---- one runner's summary, as the parts of the output it found ----------------------------------------------------

/** One summary of one run. `ran`: at least one test ran, or the run failed. A summary of zero tests is a part with `ran`
 *  false, which says "no tests ran" rather than nothing. */
interface Part {
  ran: boolean;
  passed: number | null;
  /** null when the run failed without a count (a suite that could not run). */
  failed: number | null;
  total: number | null;
  /** The output says the run failed, whether or not it counts the tests that did. */
  broke: boolean;
  /** The output reports errors beside the counts (vitest's unhandled errors): not a pass. */
  fault: boolean;
}

interface Found {
  parts: Part[];
  /** The failing tests' names, kept only when the parser found its own summary: another runner's lines are not read. */
  names: string[];
}

const part = (p: Partial<Part>): Part => ({ ran: true, passed: 0, failed: 0, total: null, broke: false, fault: false, ...p });
const nothing: Found = { parts: [], names: [] };
const found = (parts: Part[], names: string[]): Found => (parts.length ? { parts, names } : nothing);

const VITEST_TESTS = /\bTests\s+(\d+ (?:failed|passed|skipped|todo|pending)(?: \| \d+ (?:failed|passed|skipped|todo|pending))*) \((\d+)\)\s*$/;
const VITEST_FILES = /\bTest Files\s+(\d+ (?:failed|passed|skipped)(?: \| \d+ (?:failed|passed|skipped))*) \((\d+)\)\s*$/;
const VITEST_ERRORS = /\bErrors\s+\d+ errors?\s*$/;
const VITEST_FAIL = /^\s*FAIL\s+(\S.*)$/;

function vitest(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  // a `Test Files` line comes first; a file that could not run has no test to count, so it fails the run by itself
  let filesFailed = 0;
  const closeFiles = () => {
    if (filesFailed > 0) parts.push(part({ failed: null, broke: true }));
    filesFailed = 0;
  };
  for (const line of lines) {
    const files = VITEST_FILES.exec(line);
    if (files) {
      closeFiles();
      filesFailed = counts(files[1]).failed ?? 0;
      continue;
    }
    const tests = VITEST_TESTS.exec(line);
    if (tests) {
      const c = counts(tests[1]);
      const failed = c.failed ?? 0;
      parts.push(part({ passed: c.passed ?? 0, failed: failed > 0 || filesFailed === 0 ? failed : null, total: num(tests[2]), broke: failed > 0 || filesFailed > 0, ran: num(tests[2]) > 0 || filesFailed > 0 }));
      filesFailed = 0;
      continue;
    }
    if (VITEST_ERRORS.test(line) && parts.length) parts[parts.length - 1].fault = true;
    const fail = VITEST_FAIL.exec(line);
    if (fail) {
      // `|project| file > suite > test` in a workspace; a file that could not load is `file [ file ]`
      const rest = fail[1].replace(/^\|[^|]*\|\s*/, "");
      const at = rest.indexOf(" > ");
      names.push(nameOf(at >= 0 ? rest.slice(at + 3) : rest.replace(/\s*\[.*\]\s*$/, "")));
    }
  }
  closeFiles();
  return found(parts, names);
}

const JEST_TESTS = /(?:^|\s)Tests:\s+(\d+ [a-z]+(?:, \d+ [a-z]+)*)\s*$/;
const JEST_SUITES = /(?:^|\s)Test Suites:\s+(\d+ [a-z]+(?:, \d+ [a-z]+)*)\s*$/;
const JEST_NAME = /^\s*● (\S.*)$/;
// the blocks jest prints with a bullet that are no test: console output, a suite that could not run, warnings
const JEST_NOT_A_TEST = /^(?:Test suite failed to run|Console\b|Validation Warning|Obsolete snapshot|Deprecation)/;
const JEST_FAIL_FILE = /^\s*FAIL\s+(\S+)/;

function jest(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  const files: string[] = [];
  let suitesFailed = 0;
  for (const line of lines) {
    const suites = JEST_SUITES.exec(line);
    if (suites) {
      suitesFailed = counts(suites[1]).failed ?? 0;
      continue;
    }
    const tests = JEST_TESTS.exec(line);
    if (tests) {
      const c = counts(tests[1]);
      const total = c.total ?? 0;
      const failed = c.failed ?? 0;
      // a suite that could not run counts no test, and "0 tests" is no total to keep beside a failed run
      const counted = failed > 0 || suitesFailed === 0;
      parts.push(part({ passed: c.passed ?? 0, failed: counted ? failed : null, total: counted ? total : null, broke: failed > 0 || suitesFailed > 0, ran: total > 0 || suitesFailed > 0 }));
      suitesFailed = 0;
      continue;
    }
    const name = JEST_NAME.exec(line);
    if (name && !JEST_NOT_A_TEST.test(name[1])) names.push(nameOf(name[1]));
    const file = JEST_FAIL_FILE.exec(line);
    if (file) files.push(nameOf(file[1]));
  }
  // a suite that could not run names no test, so its file is the name
  return found(parts, names.length ? names : files);
}

const NODE_COUNT = /^\s*(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
const NODE_FAILING = /^\s*✖ failing tests:\s*$/;
const NODE_FAILED = /^\s*✖\s+(\S.*?)\s+\(\d+(?:\.\d+)?ms\)\s*$/;
const TAP_NOT_OK = /^(\s*)not ok \d+ - (.+?)(?:\s+# (SKIP|TODO)\b.*)?$/;

function node(lines: string[]): Found {
  const parts: Part[] = [];
  let block: Record<string, number> | null = null;
  const close = () => {
    if (!block) return;
    const failed = (block.fail ?? 0) + (block.cancelled ?? 0);
    const total = block.tests ?? 0;
    parts.push(part({ passed: block.pass ?? 0, failed, total, broke: failed > 0, ran: total > 0 }));
    block = null;
  };
  const names: string[] = [];
  let listing = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const count = NODE_COUNT.exec(line);
    if (count) {
      // a run's counts start with `tests`; a second one is another run
      if (count[1] === "tests") close();
      (block ??= {})[count[1]] = num(count[2]);
      continue;
    }
    // the spec reporter ends with the list of the tests that failed, one `✖ name (time)` each
    if (NODE_FAILING.test(line)) {
      listing = true;
      continue;
    }
    const failed = listing ? NODE_FAILED.exec(line) : null;
    if (failed) names.push(nameOf(failed[1]));
    // the TAP reporter marks a failure `not ok N - name`, and a suite that failed because a test in it did is marked too:
    // its block says `type: 'suite'`
    const tap = TAP_NOT_OK.exec(line);
    if (tap && !tap[3]) {
      let suite = false;
      for (let j = i + 1; j < lines.length && j < i + 60 && /^\s/.test(lines[j]) && lines[j].search(/\S/) > tap[1].length; j++) {
        if (/^\s*type: 'suite'\s*$/.test(lines[j])) suite = true;
        if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
      }
      if (!suite) names.push(nameOf(tap[2]));
    }
  }
  close();
  return found(parts, names);
}

// `=== 1 failed, 13 passed in 2.31s ===`, or `1 failed, 13 passed in 2.31s (0:00:02)` with -q, ending the line
const PYTEST_END = / in (?:\d+(?:\.\d+)?)s(?: \(\d+:\d+:\d+\))?[\s=]*$/;
const PYTEST_OUTCOME = /^(\d+) ([a-z]+(?: [a-z]+)?)$/;
const PYTEST_NAME = /^(?:FAILED|ERROR) +(\S+::\S+|\S+\.py)(?= |$)/;

function pytest(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  for (const line of lines) {
    const name = PYTEST_NAME.exec(line);
    if (name) names.push(nameOf(name[1]));
    const end = PYTEST_END.exec(line);
    if (!end) continue;
    const head = line.slice(0, end.index).replace(/^[\s=]+/, "").trim();
    if (head === "no tests ran") {
      parts.push(part({ ran: false }));
      continue;
    }
    const pieces = head.split(", ").map((p) => PYTEST_OUTCOME.exec(p));
    if (pieces.some((p) => !p)) continue;
    const c: Record<string, number> = {};
    for (const p of pieces) c[p![2]] = (c[p![2]] ?? 0) + num(p![1]);
    // an error is a test that could not run, so it counts as one that failed
    const failed = (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0);
    const passed = c.passed ?? 0;
    const others = (c.skipped ?? 0) + (c.xfailed ?? 0) + (c.xpassed ?? 0);
    // a line of other words ("3 packages in 2s", "1 warning in 0.5s") says nothing of tests
    if (failed + passed + others === 0) continue;
    parts.push(part({ ran: failed + passed > 0, passed, failed, total: failed + passed + others, broke: failed > 0 }));
  }
  return found(parts, names);
}

const GO_OK = /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))(?:\s+(.*))?$/;
const GO_FAIL_PACKAGE = /^FAIL\s+\S+\s+(?:\d+(?:\.\d+)?s|\[(?:build|setup) failed\])/;
const GO_TEST = /^--- (PASS|FAIL|SKIP): (\S+) \(/;
const GO_RUN = /^=== (?:RUN|CONT|PAUSE)\s/;

function go(lines: string[]): Found {
  let ok = 0;
  let empty = 0;
  let broken = 0;
  let verbose = false;
  const seen = { PASS: 0, FAIL: 0, SKIP: 0 };
  const names: string[] = [];
  for (const line of lines) {
    const pass = GO_OK.exec(line);
    if (pass) {
      if (pass[1]?.includes("[no tests to run]")) empty++;
      else ok++;
      continue;
    }
    if (GO_FAIL_PACKAGE.test(line)) {
      broken++;
      continue;
    }
    const test = GO_TEST.exec(line);
    if (test) {
      seen[test[1] as keyof typeof seen]++;
      if (test[1] === "FAIL") names.push(nameOf(test[2]));
    } else if (GO_RUN.test(line)) verbose = true;
  }
  // a run without -v prints no line per test, so a pass has no count
  verbose ||= seen.PASS + seen.SKIP > 0;
  const total = verbose ? seen.PASS + seen.FAIL + seen.SKIP : null;
  if (broken > 0 || seen.FAIL > 0) return { parts: [part({ passed: verbose ? seen.PASS : null, failed: seen.FAIL > 0 ? seen.FAIL : null, total, broke: true })], names };
  if (ok > 0 && !(verbose && seen.PASS === 0)) return { parts: [part({ passed: verbose ? seen.PASS : null, total })], names: [] };
  return ok + empty > 0 ? { parts: [part({ ran: false })], names: [] } : nothing;
}

const CARGO_RESULT = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/;
const CARGO_FAILED = /^test (\S.*?) \.\.\. FAILED$/;

function cargo(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  for (const line of lines) {
    const r = CARGO_RESULT.exec(line);
    if (r) {
      const passed = num(r[2]);
      const failed = num(r[3]);
      parts.push(part({ ran: passed + failed > 0, passed, failed, total: passed + failed + num(r[4]), broke: r[1] === "FAILED" }));
      continue;
    }
    const f = CARGO_FAILED.exec(line);
    if (f) names.push(nameOf(f[1]));
  }
  return found(parts, names);
}

// `apps/web test: ` at the start of each line of a package's run, which pnpm prints when it runs a script in several packages
// at once. The three readers below match whole lines from their start, so they take it off first; a line that has none is as it was.
const PNPM_PREFIX = /^[\w@./-]+ \S+: /;
const unprefixed = (line: string): string => line.replace(PNPM_PREFIX, "");

/** What a reporter prints for a time: `309ms`, `1.2s`, `3m`. Playwright prints `-` when it has none. */
const TIME = "\\d+(?:\\.\\d+)?(?:ms|s|m|h|d)";

// ---- mocha ---------------------------------------------------------------------------------------------------------

// The spec reporter, and the ones that share its end (dot, min, progress, list), end a run with `  5 passing (14ms)`, then
// `  1 pending` and `  1 failing` only when there are some, then the list of failures. The first line is always there and carries
// the time, so it is the one that begins a run's counts: a line of the others alone is no more than words.
const MOCHA_PASSING = new RegExp(`^\\s*(\\d+) passing \\(${TIME}\\)$`);
const MOCHA_COUNT = /^\s*(\d+) (pending|failing)$/;
// the list numbers each failure from 1: `  1) Example failing test:`, or a title over several lines, `  1) suite`, then `       test:`
const MOCHA_FAILURE = /^ {2}(\d+)\) (\S.*)$/;
const MOCHA_TITLE_LINES = 8;

/** The title of the failure that begins at line `at` (its text after the number is `first`): what ends in a colon, which may
 *  be the first line or the last of a few, each further in than the one before. Joined as the other runners' names are. */
function mochaTitle(lines: string[], at: number, first: string): { title: string; end: number } | null {
  const parts = [first.trim()];
  for (let k = at; k - at <= MOCHA_TITLE_LINES; k++) {
    const last = parts[parts.length - 1];
    if (last.endsWith(":")) {
      parts[parts.length - 1] = last.slice(0, -1).trimEnd();
      return { title: parts.join(" > "), end: k };
    }
    const next = k + 1 < lines.length ? unprefixed(lines[k + 1]) : "";
    if (!next.startsWith("     ")) return null;
    parts.push(next.trim());
  }
  return null;
}

function mocha(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  let block: { passing: number; pending: number; failing: number } | null = null;
  // the number of the next failure the list names, once a line has said there are some: 0 until then, and no failure is numbered 0
  let next = 0;
  const close = () => {
    if (block) parts.push(part({ ran: block.passing + block.failing > 0, passed: block.passing, failed: block.failing, total: block.passing + block.pending + block.failing, broke: block.failing > 0 }));
    block = null;
    next = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = unprefixed(lines[i]);
    const passing = MOCHA_PASSING.exec(line);
    if (passing) {
      close();
      block = { passing: num(passing[1]), pending: 0, failing: 0 };
      continue;
    }
    if (!block) continue;
    const count = MOCHA_COUNT.exec(line);
    if (count) {
      block[count[2] as "pending" | "failing"] = num(count[1]);
      if (count[2] === "failing" && block.failing > 0) next = 1;
      continue;
    }
    const failure = MOCHA_FAILURE.exec(line);
    if (failure && num(failure[1]) === next) {
      const title = mochaTitle(lines, i, failure[2]);
      if (title) {
        names.push(nameOf(title.title));
        i = title.end;
      }
      next++;
    }
  }
  close();
  return found(parts, names);
}

// ---- Playwright Test -----------------------------------------------------------------------------------------------

// The list, line and dot reporters end a run with a line for each kind of outcome that there is, in this order, and under
// `failed`, `interrupted` and `flaky` the place of each test: `[chromium] › tests/a.spec.ts:4:3 › suite › test ────`. A test that
// failed and passed on its retry is flaky, which the status of the command calls a pass. Last, when there is anything above it,
// comes a line for errors that were not any test's (a failed global setup).
const PW_KINDS = ["failed", "interrupted", "flaky", "skipped", "did not run", "passed"] as const;
const PW_COUNT = /^ {2}(\d+) (failed|interrupted|flaky|skipped|did not run)$/;
const PW_PASSED = new RegExp(`^ {2}(\\d+) passed \\((?:-|${TIME})\\)$`);
const PW_ERRORS = /^ {2}\d+ errors? (?:was|were) not a part of any test, see above for details$/;

/** A test's name from the line that gives its place, or null when the line is none. */
function pwName(raw: string): string | null {
  const line = unprefixed(raw);
  // four spaces exactly: a line indented less is another part of the output, and one indented more is a code frame
  if (!line.startsWith("    ")) return null;
  let rest = line.slice(4);
  const project = /^\[[^\]]*\] › /.exec(rest);
  if (project) rest = rest.slice(project[0].length);
  const place = /^\S+:\d+:\d+ › /.exec(rest);
  if (!place) return null;
  // the rule of `─` that fills the line out is no part of the name
  let end = rest.length;
  while (end > place[0].length && (rest[end - 1] === "─" || rest[end - 1] === " ")) end--;
  return nameOf(rest.slice(place[0].length, end));
}

function playwright(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  let block: Partial<Record<(typeof PW_KINDS)[number], number>> | null = null;
  let last = -1;
  let errors = false;
  // the block holds a line that says something only in a summary: skipped and did not run mean nothing alone, and come before the
  // line that anchors them (a test's place under failed, interrupted or flaky, or the time after passed)
  let anchored = false;
  const close = () => {
    if (block && anchored) {
      const n = (k: (typeof PW_KINDS)[number]) => block?.[k] ?? 0;
      const failed = n("failed");
      const passed = n("passed") + n("flaky");
      const total = failed + passed + n("interrupted") + n("skipped") + n("did not run");
      // a test that did not run, was interrupted, or came with an error of its own is a run that did not finish
      parts.push(part({ ran: passed + failed + n("interrupted") > 0, passed, failed, total, broke: failed > 0, fault: n("interrupted") > 0 || n("did not run") > 0 || errors }));
    }
    block = null;
    last = -1;
    errors = false;
    anchored = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = unprefixed(lines[i]);
    const count = PW_COUNT.exec(line);
    const passed = count ? null : PW_PASSED.exec(line);
    if (!count && !passed) {
      if (block && PW_ERRORS.test(line)) errors = true;
      continue;
    }
    const kind = count ? (count[2] as (typeof PW_KINDS)[number]) : "passed";
    const n = num((count ?? passed)![1]);
    const rank = PW_KINDS.indexOf(kind);
    // these three have the place of each test under them, and a line that has none is somebody else's words
    if (rank <= 2 && (i + 1 >= lines.length || pwName(lines[i + 1]) === null)) continue;
    // each kind comes once and in order, so one that does not come after the last is the first of another run's
    if (block && rank <= last) close();
    (block ??= {})[kind] = n;
    last = rank;
    if (rank <= 2 || kind === "passed") anchored = true;
    if (kind === "failed") {
      for (let j = i + 1; j <= i + n && j < lines.length; j++) {
        const name = pwName(lines[j]);
        if (name === null) break;
        names.push(name);
      }
    }
  }
  close();
  return found(parts, names);
}

// ---- Python's unittest ---------------------------------------------------------------------------------------------

// A run ends with `Ran 5 tests in 0.000s`, a blank line and its verdict: `OK`, or `FAILED (failures=1, errors=1)`, with `skipped=`,
// `expected failures=` and `unexpected successes=` when there are any; Python 3.12 and after say `NO TESTS RAN` where 3.11 and
// before say `OK`. An unexpected success makes the run FAILED. Each test that failed or raised has a header above, after a line of
// `=`: `FAIL: test_x (tests.test_a.A)` (`ERROR:` for one that raised or could not be imported).
const UT_RAN = /^Ran (\d+) tests? in \d+(?:\.\d+)?s$/;
const UT_VERDICT = /^(OK|FAILED|NO TESTS RAN)(?: \(([^()]*)\))?$/;
const UT_RULE = /^={20,}$/;
const UT_NAME = /^(?:FAIL|ERROR): (\S.*)$/;
const UT_INFO = /^(failures|errors|skipped|expected failures|unexpected successes)=(\d+)$/;

function unittest(lines: string[]): Found {
  const parts: Part[] = [];
  const names: string[] = [];
  // the line before was the rule of `=` that stands above each header: a test's own output may print `FAIL: …` anywhere else
  let afterRule = false;
  for (let i = 0; i < lines.length; i++) {
    const line = unprefixed(lines[i]);
    const name = afterRule ? UT_NAME.exec(line) : null;
    if (name) names.push(nameOf(name[1]));
    afterRule = UT_RULE.test(line);
    const ran = UT_RAN.exec(line);
    if (!ran) continue;
    // the verdict is the next line that says anything: a blank line comes between
    let at = i + 1;
    while (at < lines.length && unprefixed(lines[at]).trim() === "") at++;
    const verdict = at < lines.length ? UT_VERDICT.exec(unprefixed(lines[at])) : null;
    if (!verdict) continue;
    const info: Record<string, number> = {};
    for (const piece of (verdict[2] ?? "").split(", ")) {
      const m = UT_INFO.exec(piece);
      if (m) info[m[1]] = num(m[2]);
    }
    const total = num(ran[1]);
    const failed = (info.failures ?? 0) + (info.errors ?? 0) + (info["unexpected successes"] ?? 0);
    // a skipped test and an expected failure were run and are neither
    const passed = Math.max(0, total - failed - (info.skipped ?? 0) - (info["expected failures"] ?? 0));
    if (verdict[1] === "NO TESTS RAN") parts.push(part({ ran: false }));
    else parts.push(part({ ran: passed + failed > 0, passed, failed: failed > 0 || verdict[1] === "OK" ? failed : null, total, broke: verdict[1] === "FAILED" || failed > 0 }));
  }
  return found(parts, names);
}

const PARSERS: Record<Runner, (lines: string[]) => Found> = { vitest, jest, node, pytest, go, cargo, mocha, playwright, unittest };

// ---- an output as one reading -------------------------------------------------------------------------------------

const unique = (list: string[]): string[] => [...new Set(list)];

/** What the output of one test run says. `ok` is whether its command ended without an error, when that is known: a
 *  pass needs it not to be false. `runner` limits the reading to the runner the command named; without it every
 *  runner's summary is looked for, and the ones found are added up (a workspace runs several). */
export function readTestOutput(output: string | undefined, opts: { ok?: boolean; runner?: Runner | null } = {}): TestRead {
  if (typeof output !== "string") return { kind: "unknown", why: "no_output" };
  const text = stripAnsi(output.length > TAIL_MAX ? output.slice(-TAIL_MAX) : output).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").filter((l) => l.length <= LINE_MAX);
  const all = (opts.runner ? [PARSERS[opts.runner]] : Object.values(PARSERS)).map((parse) => parse(lines));
  const parts = all.flatMap((f) => f.parts);
  if (!parts.length) return { kind: "unknown", why: "no_summary" };
  const live = parts.filter((p) => p.ran);
  if (!live.length) return { kind: "unknown", why: "no_tests" };

  if (live.some((p) => p.broke)) {
    // a count is known only when every run that failed gave one
    const sum = (f: (p: Part) => number | null): number | null => live.reduce<number | null>((n, p) => (n === null || f(p) === null ? null : n + (f(p) as number)), 0);
    return { kind: "failed", failed: sum((p) => p.failed), total: sum((p) => p.total), names: unique(all.flatMap((f) => f.names)).slice(0, MAX_NAMES) };
  }
  if (live.some((p) => p.fault)) return { kind: "unknown", why: "errors" };
  if (opts.ok === false) return { kind: "unknown", why: "exit" };
  return { kind: "passed", passed: live.reduce<number | null>((n, p) => (n === null || p.passed === null ? null : n + p.passed), 0) };
}

// ---- a command, as the words it runs ------------------------------------------------------------------------------

/** `line` as its commands, each as its words, split where a shell would at `&&`, `||`, `;`, `|`, `&`, `(`, `)` and a
 *  line break, outside quotes. A quoted word is one word with its quotes off, so `git commit -m "pnpm test"` runs no
 *  tests. */
function commands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") endCommand();
    else if (c === " " || c === "\t") endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

/** A test run: the runner its command names, null when the command does not (a package's own `test` script runs
 *  whatever the project chose). */
interface Hit {
  runner: Runner | null;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words a command may begin with that only wrap the one that runs. */
const WRAPPERS = new Set(["time", "env", "nohup", "command", "exec"]);
const SCRIPT_IS_TEST = /^(?:t|tst|tests?)(?:[:._-].*)?$|[:._-]tests?$/;
/** Options of a package manager that take the next word as their value, so it is not the command. */
const PM_VALUE_OPTIONS = new Set(["--filter", "-F", "--filter-prod", "--prefix", "-C", "--dir", "--cwd", "--workspace"]);
/** The same for `npx` and its kind: the next word is a package, not the program. */
const RUNNER_VALUE_OPTIONS = new Set(["-p", "--package"]);

/** The words after the options `valued` takes a value for. */
function positionals(words: string[], valued: ReadonlySet<string>): { at: number; word: string }[] {
  const out: { at: number; word: string }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") break;
    if (w.startsWith("-")) {
      if (valued.has(w)) i++;
      continue;
    }
    out.push({ at: i, word: w });
  }
  return out;
}

function hitOf(words: string[]): Hit | null {
  let at = 0;
  while (at < words.length && (ASSIGNMENT.test(words[at]) || WRAPPERS.has(words[at]))) at++;
  const [head, ...rest] = words.slice(at);
  if (!head) return null;
  const program = head.split("/").pop() ?? head;
  if (program === "vitest") return { runner: "vitest" };
  if (program === "jest") return { runner: "jest" };
  if (program === "pytest" || program === "py.test") return { runner: "pytest" };
  // `playwright test` runs tests; `playwright install`, `codegen` and `show-report` do not
  if (program === "playwright") return rest[0] === "test" ? { runner: "playwright" } : null;
  if (program === "mocha" || program === "_mocha") return { runner: "mocha" };
  // runners whose output none of the nine parsers reads: a lane that ran them says so, and never that they passed
  if (program === "cypress") return rest[0] === "run" ? { runner: null } : null;
  if (program === "ava") return { runner: null };
  if (/^python[\d.]*$/.test(program)) {
    const m = rest.indexOf("-m");
    const module = m >= 0 ? rest[m + 1] : undefined;
    return module === "pytest" ? { runner: "pytest" } : module === "unittest" ? { runner: "unittest" } : null;
  }
  if (program === "node") {
    // `--test` before the script it would run
    for (const w of rest) {
      if (w === "--test") return { runner: "node" };
      if (!w.startsWith("-")) return null;
    }
    return null;
  }
  if (program === "go") return rest.find((w) => !w.startsWith("-")) === "test" ? { runner: "go" } : null;
  if (program === "cargo") {
    const sub = rest.find((w) => !w.startsWith("-") && !w.startsWith("+"));
    return sub === "test" ? { runner: "cargo" } : sub === "nextest" ? { runner: null } : null;
  }
  if (program === "npx" || program === "bunx" || program === "pnpx") {
    const p = positionals(rest, RUNNER_VALUE_OPTIONS)[0];
    return p ? hitOf(rest.slice(p.at)) : null;
  }
  if (program === "deno") return rest.find((w) => !w.startsWith("-")) === "test" ? { runner: null } : null;
  if (program === "pnpm" || program === "npm" || program === "yarn" || program === "bun") {
    const pos = positionals(rest, PM_VALUE_OPTIONS);
    let i = 0;
    if (pos[i]?.word === "workspace" || pos[i]?.word === "workspaces") i += program === "yarn" ? 2 : 1;
    const sub = pos[i]?.word;
    if (!sub) return null;
    if (sub === "run" || sub === "run-script") return SCRIPT_IS_TEST.test(pos[i + 1]?.word ?? "") ? { runner: null } : null;
    if (sub === "exec" || sub === "dlx" || sub === "x") return pos[i + 1] ? hitOf(rest.slice(pos[i + 1].at)) : null;
    // `pnpm vitest run` runs the program's own binary; any other word is a script of the package
    return hitOf(rest.slice(pos[i].at)) ?? (SCRIPT_IS_TEST.test(sub) ? { runner: null } : null);
  }
  return null;
}

/** The test runs in a command line: each command of it that runs tests. */
const hitsOf = (line: string): Hit[] => commands(line).flatMap((w) => hitOf(w) ?? []);

/** Whether any command of `line` runs tests: `pnpm test`, `vitest run src/a.test.ts`, `cd app && go test ./...`. */
export const runsTests = (line: string): boolean => hitsOf(line).length > 0;

/** Words a shell would turn into something else before `cd` sees them: a variable, a pattern, a command's output. */
const UNREADABLE = /[$`*?[\]{}]/;
/** A package manager's options that name the folder it runs in. */
const PM_FOLDER = new Set(["-C", "--dir", "--prefix", "--cwd"]);

/** `word` as an absolute folder from `at`, or null when the words cannot say (`-`, `~` with no home, an unreadable word). */
function folderFrom(word: string, at: string, home: string | null | undefined): string | null {
  if (word === "-" || UNREADABLE.test(word)) return null;
  if (word === "~" || word.startsWith("~/")) return home ? home + word.slice(1) : null;
  if (word.startsWith("~")) return null;
  if (word.startsWith("/") || /^[A-Za-z]:[\\/]/.test(word)) return word;
  return `${at.replace(/[\\/]+$/, "")}/${word}`;
}

/** Whether a test run of `line` runs outside `root`, the folder a lane works in: after a `cd` or `pushd` to a folder outside
 *  it, or with a package manager told another folder (`pnpm -C`, `npm --prefix`, `yarn --cwd`). A folder the words cannot say
 *  counts as outside, and so does any run after a `popd`: a lane that read another folder's run as its own would say its
 *  tests passed when nobody ran them on its work. A line that runs no tests runs none outside. */
export function testsRunOutside(line: string, root: string, home?: string | null): boolean {
  let at: string | null = root;
  for (const words of commands(line)) {
    let i = 0;
    while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i++;
    const [head, ...rest] = words.slice(i);
    if (!head) continue;
    if (head === "cd" || head === "pushd") {
      const to = rest.find((w) => !/^-[LPe@]+$/.test(w));
      at = at === null ? null : to === undefined ? (home ?? null) : folderFrom(to, at, home);
      continue;
    }
    if (head === "popd") {
      at = null;
      continue;
    }
    if (!hitOf(words)) continue;
    let ran = at;
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k];
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      if (!PM_FOLDER.has(flag)) continue;
      const value = eq > 0 ? w.slice(eq + 1) : rest[k + 1];
      ran = ran === null || value === undefined ? null : folderFrom(value, ran, home);
    }
    if (ran === null || !insideProject(ran, root, [])) return true;
  }
  return false;
}

/** The one runner `line`'s test runs name, or null when it names none or names more than one. A package's own `test`
 *  script names none: the output says which runner it was. */
export function runnerOf(line: string): Runner | null {
  const runners = new Set(hitsOf(line).map((h) => h.runner));
  return runners.size === 1 ? ([...runners][0] ?? null) : null;
}
