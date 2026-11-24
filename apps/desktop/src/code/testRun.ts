// A test run, read from its command and its output, for a lane's state (src/code/lane.ts).
//
// Two questions are asked apart. Whether a command runs tests is read from its words (`runsTests`): the dial's own
// reading (command.ts) answers whether Kit may run a command alone, and it calls an unquoted pattern unreadable, which
// a test run is not. What a run found is read from its output (`readTestOutput`): vitest, jest, node's own runner,
// pytest, `go test` and `cargo test` each print a summary, and the counts and the failing tests' names are taken from
// it. Pure: nothing runs and nothing is looked up.
//
// The rule that matters is the one about a pass. A run is read as passed only when its output says tests ran, says
// none failed, and its command did not end with an error. Anything else the parser cannot read is `unknown`, which
// never shows as Checked: a lane that says tests passed when they did not would send a developer to a pull request on
// a broken change. A failure is the other way round: it is read from what the output says, whatever the exit status
// said, because a command such as `vitest run || true` hides its failure from the status and not from its output.

/** What the output of a test run says. */
export type TestRead =
  /** Tests ran and none failed; `passed` is how many, or null when the runner gives no count (`go test` without -v). */
  | { kind: "passed"; passed: number | null }
  /** The output says the run failed. `failed` of `total` tests (null when it gives no count), and which, when it names
   *  them: at most `MAX_NAMES`, each cut to a short line. */
  | { kind: "failed"; failed: number | null; total: number | null; names: string[] }
  /** The output does not say. It is never a pass. */
  | { kind: "unknown"; why: "no_output" | "no_summary" | "no_tests" | "errors" | "exit" };

export type Runner = "vitest" | "jest" | "node" | "pytest" | "go" | "cargo";

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

const PARSERS: Record<Runner, (lines: string[]) => Found> = { vitest, jest, node, pytest, go, cargo };

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
  // runners whose output none of the six parsers reads: a lane that ran them says so, and never that they passed
  if (program === "playwright") return rest[0] === "test" ? { runner: null } : null;
  if (program === "cypress") return rest[0] === "run" ? { runner: null } : null;
  if (program === "mocha" || program === "ava") return { runner: null };
  if (/^python[\d.]*$/.test(program)) {
    const m = rest.indexOf("-m");
    const module = m >= 0 ? rest[m + 1] : undefined;
    return module === "pytest" ? { runner: "pytest" } : module === "unittest" ? { runner: null } : null;
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

/** The one runner `line`'s test runs name, or null when it names none or names more than one. A package's own `test`
 *  script names none: the output says which runner it was. */
export function runnerOf(line: string): Runner | null {
  const runners = new Set(hitsOf(line).map((h) => h.runner));
  return runners.size === 1 ? ([...runners][0] ?? null) : null;
}
