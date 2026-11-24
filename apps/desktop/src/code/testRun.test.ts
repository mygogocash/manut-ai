// A test run read from its command and its output (src/code/testRun.ts). The outputs in __fixtures__/test-output are
// what the runners printed for the same small project, one test of which expects "590.00" and gets "59.00": vitest
// 3.2.7 (also through `pnpm test`, and with colours forced on), node 26.13's own runner (the spec and the TAP
// reporters), pytest 8.4.2 and cargo 1.100 were run on this Mac and saved as they came. Jest and Go are not installed
// here, so their files are written from each runner's documented default output; a tab stands where Go prints one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_NAMES, readTestOutput, runnerOf, runsTests, stripAnsi, testsRunOutside } from "./testRun";

const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", "test-output", `${name}.txt`), "utf8");
const read = (name: string, ok?: boolean) => readTestOutput(fixture(name), { ok });

// Mocha, Playwright Test and Python's unittest are kept as test strings below, not as fixture files. Playwright Test 1.65.1 and
// Python 3.9.6's unittest were run on this Mac, in the same small project as the fixtures (one test expects "590.00" and gets
// "59.00"), and are as they came apart from this Mac's folder, which reads as the project's. Mocha is not installed here and was
// not downloaded: its samples are what its documentation shows for the spec reporter, and each says if it is word for word.
const text = (...lines: string[]): string => lines.join("\n");

/** Playwright Test, list reporter, piped (no colours): five tests, all passed. */
const PW_PASS = text(
  "",
  "Running 5 tests using 1 worker",
  "",
  "  ✓  1 tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR (1ms)",
  "  ✓  2 tests/promptpay.spec.ts:7:3 › promptpay › shows the shop name (0ms)",
  "  ✓  3 tests/promptpay.spec.ts:8:3 › promptpay › reads the shop ID (0ms)",
  "  ✓  4 tests/promptpay.spec.ts:9:3 › promptpay › keeps the total (0ms)",
  "  ✓  5 tests/promptpay.spec.ts:10:3 › promptpay › adds a QR (0ms)",
  "",
  "  5 passed (309ms)",
  "",
);

/** The same run with the first test failing: its error block comes before the summary, which names the test again. */
const PW_FAIL = text(
  "",
  "Running 5 tests using 1 worker",
  "",
  "  ✘  1 tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR (3ms)",
  "  ✓  2 tests/promptpay.spec.ts:7:3 › promptpay › shows the shop name (1ms)",
  "  ✓  3 tests/promptpay.spec.ts:8:3 › promptpay › reads the shop ID (0ms)",
  "  ✓  4 tests/promptpay.spec.ts:9:3 › promptpay › keeps the total (0ms)",
  "  ✓  5 tests/promptpay.spec.ts:10:3 › promptpay › adds a QR (0ms)",
  "",
  "",
  "  1) tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR ────────────────────────",
  "",
  "    Error: expect(received).toBe(expected) // Object.is equality",
  "",
  '    Expected: "590.00"',
  '    Received: "59.00"',
  "",
  '      3 | test.describe("promptpay", () => {',
  '      4 |   test("locks the amount into the QR", async () => {',
  '    > 5 |     expect("59.00").toBe(process.env.WANT ?? "59.00");',
  "        |                     ^",
  "      6 |   });",
  '      7 |   test("shows the shop name", async () => { expect("Baan Mali").toContain("Mali"); });',
  '      8 |   test("reads the shop ID", async () => { expect(process.env.SHOP ?? "0000000000").toHaveLength(10); });',
  "        at /Users/fon/baanmali-preorder/tests/promptpay.spec.ts:5:21",
  "",
  "    Error Context: test-results/promptpay-promptpay-locks-the-amount-into-the-QR/error-context.md",
  "",
  "  1 failed",
  "    tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR ─────────────────────────",
  "  4 passed (493ms)",
  "",
);

/** The failed run's summary with colours on (FORCE_COLOR=1), as the shell hands it on. */
const PW_FAIL_COLOUR = text(
  "\u001b[2m    Error Context: test-results/promptpay-promptpay-locks-the-amount-into-the-QR/error-context.md\u001b[22m",
  "",
  "\u001b[31m  1 failed\u001b[39m",
  "\u001b[31m    tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR \u001b[2m─────────────────────────\u001b[22m\u001b[39m",
  "\u001b[32m  4 passed\u001b[39m\u001b[2m (501ms)\u001b[22m",
  "",
);

/** A run of six tests, one of them `test.skip`: the summary counts it apart from the ones that passed. */
const PW_FAIL_SKIP = text(
  "  1 failed",
  "    tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR ─────────────────────────",
  "  1 skipped",
  "  4 passed (526ms)",
  "",
);

/** `--retries=1`: a test that failed and passed on its retry is flaky, which Playwright's exit status calls a pass. */
const PW_FLAKY = text(
  "  1 flaky",
  "    tests/flaky.spec.ts:2:1 › passes on its second try ─────────────────────────────────────────────",
  "  5 passed (505ms)",
  "",
);

/** `--max-failures=1`: the run stopped at the first failure, so four tests never ran, and it says an error was outside any test. */
const PW_STOPPED = text(
  "  1 failed",
  "    tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR ─────────────────────────",
  "  4 did not run",
  "  1 error was not a part of any test, see above for details",
  "",
);

/** A project named `chromium` in the config puts its name before each test's place. */
const PW_FAIL_PROJECT = text(
  "  1 failed",
  "    [chromium] › tests/promptpay.spec.ts:4:3 › promptpay › locks the amount into the QR ────────────",
  "  4 passed (266ms)",
  "",
);

/** What `playwright test` says when it finds no test to run, and when a spec file has a syntax error (nothing runs at all). */
const PW_NOTHING = text("Error: No tests found.", "Make sure that arguments are regular expressions matching test files.", "You may need to escape symbols like \"$\" or \"*\" and quote the arguments.", "");
const PW_SYNTAX = text("SyntaxError: /Users/fon/baanmali-preorder/tests/broken.spec.ts: Unexpected token (3:0)", "", "   at broken.spec.ts:3", "", "  1 | import { test } from \"@playwright/test\";", "  2 | test(\"x\", async () => {", "> 3 |", "    | ^", "");

/** unittest (Python 3.9.6), the quiet form: five tests, all passed. */
const UT_PASS = text(".....", "----------------------------------------------------------------------", "Ran 5 tests in 0.000s", "", "OK", "");

/** The same run with a test failing: its header names it, after a line of `=`. */
const UT_FAIL = text(
  "..F..",
  "======================================================================",
  "FAIL: test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "/Users/fon/baanmali-preorder/tests/test_promptpay.py", line 6, in test_locks_the_amount_into_the_qr',
  '    self.assertEqual("59.00", os.environ.get("WANT", "59.00"))',
  "AssertionError: '59.00' != '590.00'",
  "- 59.00",
  "+ 590.00",
  "?   +",
  "",
  "",
  "----------------------------------------------------------------------",
  "Ran 5 tests in 0.000s",
  "",
  "FAILED (failures=1)",
  "",
);

/** One test failed, one raised, one was skipped and one is an expected failure: the verdict counts each kind apart. */
const UT_MIXED = text(
  "xsFE.",
  "======================================================================",
  "ERROR: test_reads_the_shop_id (tests.test_promptpay.PromptPay)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "/Users/fon/baanmali-preorder/tests/test_promptpay.py", line 11, in test_reads_the_shop_id',
  '    raise ValueError("no PROMPTPAY_SHOP_ID")',
  "ValueError: no PROMPTPAY_SHOP_ID",
  "",
  "======================================================================",
  "FAIL: test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "/Users/fon/baanmali-preorder/tests/test_promptpay.py", line 6, in test_locks_the_amount_into_the_qr',
  '    self.assertEqual("59.00", "590.00")',
  "AssertionError: '59.00' != '590.00'",
  "",
  "----------------------------------------------------------------------",
  "Ran 5 tests in 0.000s",
  "",
  "FAILED (failures=1, errors=1, skipped=1, expected failures=1)",
  "",
);

/** A test module that could not be imported is an error of a test that unittest makes up for it. */
const UT_IMPORT_ERROR = text(
  "E",
  "======================================================================",
  "ERROR: test_broken_import (unittest.loader._FailedTest)",
  "----------------------------------------------------------------------",
  "ImportError: Failed to import test module: test_broken_import",
  "Traceback (most recent call last):",
  '  File "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/lib/python3.9/unittest/loader.py", line 154, in loadTestsFromName',
  "    module = __import__(module_name)",
  "ModuleNotFoundError: No module named 'nothing_here_exists'",
  "",
  "",
  "----------------------------------------------------------------------",
  "Ran 1 test in 0.000s",
  "",
  "FAILED (errors=1)",
  "",
);

/** Mocha's spec reporter, word for word from its documentation ("Getting started"): one test, passed. */
const MOCHA_DOCS_PASS = text("  Array", "    #indexOf()", "      ✓ should return -1 when the value is not present", "", "  1 passing (9ms)", "");

/** Mocha's documentation (the third-party interface page) shows one run with a test passed, one pending and one failed, word for
 *  word, apart from the stack trace's last lines: the failure is listed under its number with its whole title on one line. */
const MOCHA_DOCS_FAIL = text(
  "  Example",
  "    - Here's the addition we made to the UI",
  "    ✓ passing test",
  "    1) failing test",
  "",
  "",
  "  1 passing (5ms)",
  "  1 pending",
  "  1 failing",
  "",
  "  1) Example failing test:",
  "     Error: it failed!",
  "      at Context.<anonymous> (/Users/danielstjules/Desktop/example/test.js:11:11)",
  "      at callFn (/Users/danielstjules/Desktop/example/node_modules/mocha/lib/runnable.js:266:21)",
  "      at Test.Runnable.run",
  "",
);

/** Written by hand in the same form, not run and not from the documentation: five tests of the canvas's project, all passed. */
const MOCHA_PASS = text(
  "  promptpay",
  "    ✔ shows the shop name",
  "    ✔ reads the shop ID",
  "    ✔ keeps the total",
  "    ✔ adds a QR",
  "    ✔ locks the amount into the QR",
  "",
  "",
  "  5 passing (14ms)",
  "",
);

/** Written by hand, not run: a title that is a suite and a test is continued over indented lines in the list of failures, each
 *  level two spaces further in, with the colon after the last. A hook that failed is listed as the test it was for. */
const MOCHA_FAIL = text(
  "  promptpay",
  "    ✔ shows the shop name",
  "    ✔ reads the shop ID",
  "    1) locks the amount into the QR",
  "    2) \"before each\" hook for \"keeps the total\"",
  "",
  "",
  "  2 passing (11ms)",
  "  2 failing",
  "",
  "  1) promptpay",
  "       locks the amount into the QR:",
  "",
  "      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "",
  "'59.00' !== '590.00'",
  "",
  "      + expected - actual",
  "",
  "      -59.00",
  "      +590.00",
  "      ",
  "      at Context.<anonymous> (test/promptpay.test.js:6:12)",
  "      at process.processImmediate (node:internal/timers:491:21)",
  "",
  "  2) promptpay",
  '       "before each" hook for "keeps the total":',
  "     Error: connect ECONNREFUSED 127.0.0.1:5432",
  "      at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)",
  "",
);

describe("a test run's output", () => {
  describe("vitest", () => {
    it("reads a run that passed, with its count", () => {
      expect(read("vitest-pass")).toEqual({ kind: "passed", passed: 2 });
    });

    it("reads a run that failed: how many of how many, and which test", () => {
      expect(read("vitest-fail")).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay > locks the amount into the QR"] });
    });

    it("reads the same run with its colours on, and through pnpm's own lines", () => {
      expect(read("vitest-fail-color")).toEqual(read("vitest-fail"));
      expect(read("pnpm-vitest-fail")).toEqual(read("vitest-fail"));
    });

    it("leaves a run that found no tests unknown", () => {
      expect(read("vitest-none")).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("names a file that could not run, since no test of it ran", () => {
      const out = [" FAIL  tests/broken.test.ts [ tests/broken.test.ts ]", "SyntaxError: Unexpected token", "", " Test Files  1 failed (1)", "      Tests  no tests"].join("\n");
      expect(readTestOutput(out)).toEqual({ kind: "failed", failed: null, total: null, names: ["tests/broken.test.ts"] });
    });

    it("never reads errors outside the tests as a pass", () => {
      const out = [" Test Files  1 passed (1)", "      Tests  3 passed (3)", "     Errors  1 error"].join("\n");
      expect(readTestOutput(out)).toEqual({ kind: "unknown", why: "errors" });
    });

    it("drops the project a workspace run puts before a test's name", () => {
      expect(readTestOutput([" FAIL  |unit| src/a.test.ts > a > b", "      Tests  1 failed (1)"].join("\n"))).toMatchObject({ names: ["a > b"] });
    });
  });

  describe("jest", () => {
    it("reads a run that passed", () => {
      expect(read("jest-pass")).toEqual({ kind: "passed", passed: 14 });
    });

    it("reads a run that failed, whichever order its counts come in", () => {
      expect(read("jest-fail")).toEqual({ kind: "failed", failed: 1, total: 14, names: ["promptpay › locks the amount into the QR"] });
    });

    it("reads a suite that could not run as a failed run, and names its file", () => {
      expect(read("jest-suite-failed")).toEqual({ kind: "failed", failed: null, total: null, names: ["tests/broken.test.ts"] });
    });

    it("leaves a run that found no tests unknown", () => {
      expect(readTestOutput("No tests found, exiting with code 1\n")).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput("Test Suites: 0 total\nTests:       0 total\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });
  });

  describe("node's own runner", () => {
    it("reads a run that passed", () => {
      expect(read("node-pass")).toEqual({ kind: "passed", passed: 2 });
    });

    it("reads a run that failed: its summary counts, and the test its list of failing tests names", () => {
      expect(read("node-fail")).toEqual({ kind: "failed", failed: 1, total: 5, names: ["locks the amount into the QR"] });
    });

    it("reads the TAP reporter's failure, and leaves out the suite that failed only because of it", () => {
      expect(read("node-tap-fail")).toEqual({ kind: "failed", failed: 1, total: 5, names: ["locks the amount into the QR"] });
    });

    it("counts a test that never finished as one that failed", () => {
      const out = ["ℹ tests 4", "ℹ suites 0", "ℹ pass 2", "ℹ fail 1", "ℹ cancelled 1", "ℹ skipped 0", "ℹ todo 0"].join("\n");
      expect(readTestOutput(out)).toMatchObject({ kind: "failed", failed: 2, total: 4 });
    });

    it("leaves a run of no tests unknown", () => {
      expect(readTestOutput("ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });
  });

  describe("pytest", () => {
    it("reads a run that passed", () => {
      expect(read("pytest-pass")).toEqual({ kind: "passed", passed: 2 });
    });

    it("reads a run that failed, with the test's id from its short summary", () => {
      expect(read("pytest-fail")).toEqual({ kind: "failed", failed: 1, total: 5, names: ["test_promptpay.py::test_locks_the_amount_into_the_qr"] });
    });

    it("reads the quiet form of the summary, and counts an error as a failure", () => {
      expect(readTestOutput("..F\n1 failed, 2 passed in 0.12s\n")).toMatchObject({ kind: "failed", failed: 1, total: 3 });
      expect(readTestOutput("ERROR test_a.py - ImportError: no module\n2 errors in 0.05s\n")).toEqual({ kind: "failed", failed: 2, total: 2, names: ["test_a.py"] });
      // a line of captured logging that starts with ERROR is not a test
      expect(readTestOutput("ERROR    root:test_a.py:5 a log line\n1 failed in 0.05s\n")).toMatchObject({ names: [] });
    });

    it("leaves a run that collected nothing unknown", () => {
      expect(readTestOutput("============================ no tests ran in 0.01s =============================\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });
  });

  describe("go test", () => {
    it("reads packages that passed, though a run without -v gives no count", () => {
      expect(read("go-pass")).toEqual({ kind: "passed", passed: null });
    });

    it("counts a verbose run's tests", () => {
      expect(read("go-pass-verbose")).toEqual({ kind: "passed", passed: 2 });
    });

    it("reads a failing test by its name, with no total when it was not run with -v", () => {
      expect(read("go-fail")).toEqual({ kind: "failed", failed: 1, total: null, names: ["TestLocksTheAmountIntoTheQR"] });
    });

    it("gives the total of a verbose run, a skipped test among them", () => {
      expect(read("go-fail-verbose")).toEqual({ kind: "failed", failed: 1, total: 4, names: ["TestLocksTheAmountIntoTheQR"] });
    });

    it("reads a package that would not build as a failed run, which the output says", () => {
      expect(read("go-build-failed")).toEqual({ kind: "failed", failed: null, total: null, names: [] });
    });

    it("leaves a package with no test files unknown", () => {
      expect(read("go-no-tests")).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput("ok  \texample.com/shop/x\t0.002s [no tests to run]\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });
  });

  describe("cargo test", () => {
    it("adds up the test binaries of a run that passed", () => {
      expect(read("cargo-pass")).toEqual({ kind: "passed", passed: 2 });
    });

    it("reads a run that failed and names the test", () => {
      expect(read("cargo-fail")).toEqual({ kind: "failed", failed: 1, total: 3, names: ["tests::locks_the_amount_into_the_qr"] });
    });

    it("adds up every binary when the run goes on past the failure", () => {
      expect(read("cargo-nofailfast")).toEqual({ kind: "failed", failed: 1, total: 4, names: ["tests::locks_the_amount_into_the_qr"] });
    });

    it("leaves a build that did not compile unknown, since no test ran", () => {
      expect(read("cargo-compile-error")).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("leaves a binary with no tests unknown", () => {
      expect(readTestOutput("running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });
  });

  describe("mocha", () => {
    it("reads the documentation's own run that passed", () => {
      expect(readTestOutput(MOCHA_DOCS_PASS)).toEqual({ kind: "passed", passed: 1 });
    });

    it("reads a run that passed, with its count", () => {
      expect(readTestOutput(MOCHA_PASS)).toEqual({ kind: "passed", passed: 5 });
      expect(readTestOutput(MOCHA_PASS, { runner: "mocha" })).toEqual({ kind: "passed", passed: 5 });
    });

    it("reads the documentation's run that failed: its counts, with a pending test among them, and the test its list of failures names", () => {
      expect(readTestOutput(MOCHA_DOCS_FAIL)).toEqual({ kind: "failed", failed: 1, total: 3, names: ["Example failing test"] });
    });

    it("names a test by its whole title when the list continues it over indented lines, and a hook by the test it was for", () => {
      expect(readTestOutput(MOCHA_FAIL)).toEqual({
        kind: "failed",
        failed: 2,
        total: 4,
        names: ["promptpay > locks the amount into the QR", 'promptpay > "before each" hook for "keeps the total"'],
      });
    });

    it("takes a name only from a line numbered as the next failure, and only from a title that ends in its colon", () => {
      const counts = "  1 passing (4ms)\n  1 failing\n\n";
      // a line numbered out of order in a test's own output is not the list's
      expect(readTestOutput(`${counts}  7) not a failure:\n  1) a real one:\n`)).toEqual({ kind: "failed", failed: 1, total: 2, names: ["a real one"] });
      // a title that goes on past the lines that may carry one, or whose next line is not further in, is no name
      expect(readTestOutput(`${counts}  1) suite\nand then a line that is not indented\n`)).toEqual({ kind: "failed", failed: 1, total: 2, names: [] });
      expect(readTestOutput(`${counts}  1) suite\nsome heading of the output:\n`)).toEqual({ kind: "failed", failed: 1, total: 2, names: [] });
      expect(readTestOutput(`${counts}  1) suite\n${"       more\n".repeat(12)}       found:\n`)).toEqual({ kind: "failed", failed: 1, total: 2, names: [] });
      expect(readTestOutput(`${counts}  1) suite\n${"       more\n".repeat(3)}       found:\n`)).toMatchObject({ names: ["suite > more > more > more > found"] });
      // the list comes only after a count of failures: a numbered line before one, or after a run of none, is nobody's
      expect(readTestOutput("  1) a:\n  3 passing (4ms)\n  1) b:\n")).toEqual({ kind: "passed", passed: 3 });
    });

    it("reads the counts when the list of failures was cut away by the end the shell hands on, with no name", () => {
      // mocha prints its counts before the list, so a long list pushes them out of the end the shell sends: then nothing is read
      const counts = MOCHA_FAIL.slice(0, MOCHA_FAIL.indexOf("  1) promptpay"));
      expect(readTestOutput(counts)).toEqual({ kind: "failed", failed: 2, total: 4, names: [] });
      expect(readTestOutput(MOCHA_FAIL.slice(MOCHA_FAIL.indexOf("  1) promptpay")))).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("leaves a run in which no test ran unknown: none passed, or only pending ones", () => {
      expect(readTestOutput("\n  0 passing (2ms)\n")).toEqual({ kind: "unknown", why: "no_tests" });
      expect(readTestOutput("\n  0 passing (2ms)\n  3 pending\n")).toEqual({ kind: "unknown", why: "no_tests" });
    });

    it("does not take a pass from a run whose command ended in an error, and reads a failure whatever the status said", () => {
      expect(readTestOutput(MOCHA_PASS, { ok: false })).toEqual({ kind: "unknown", why: "exit" });
      expect(readTestOutput(MOCHA_FAIL, { ok: true })).toMatchObject({ kind: "failed", failed: 2 });
      expect(readTestOutput(MOCHA_FAIL, { ok: false })).toMatchObject({ kind: "failed", failed: 2 });
    });

    it("reads only mocha's summary when the command names mocha, and mocha's is not read for another runner", () => {
      expect(readTestOutput(fixture("vitest-pass"), { runner: "mocha" })).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(MOCHA_PASS, { runner: "vitest" })).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(MOCHA_PASS, { runner: "playwright" })).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("reads no line that only looks like a count: the first one carries the time, and the others come after it", () => {
      for (const out of ["  3 passing\n", "  1 failing\n  1) a:\n", "  2 pending\n", "3 passes (5ms)\n", "  3 passing (5ms) more\n"]) {
        expect(readTestOutput(out, { runner: "mocha" }), JSON.stringify(out)).toEqual({ kind: "unknown", why: "no_summary" });
      }
    });

    it("adds up the runs of a workspace, each line led by pnpm's package prefix", () => {
      const prefixed = (pkg: string, out: string) => out.split("\n").map((l) => `${pkg} test: ${l}`).join("\n");
      expect(readTestOutput(`${prefixed("apps/api", MOCHA_PASS)}\n${prefixed("packages/format", MOCHA_DOCS_PASS)}`)).toEqual({ kind: "passed", passed: 6 });
      expect(readTestOutput(`${prefixed("apps/api", MOCHA_PASS)}\n${prefixed("packages/format", MOCHA_FAIL)}`)).toMatchObject({ kind: "failed", failed: 2, total: 9 });
    });
  });

  describe("Playwright Test", () => {
    it("reads a run that passed, with its count", () => {
      expect(readTestOutput(PW_PASS)).toEqual({ kind: "passed", passed: 5 });
      expect(readTestOutput(PW_PASS, { runner: "playwright" })).toEqual({ kind: "passed", passed: 5 });
    });

    it("reads a run that failed: how many of how many, and which test the summary lists, whatever the error block above it says", () => {
      expect(readTestOutput(PW_FAIL)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay › locks the amount into the QR"] });
    });

    it("reads the same summary with its colours on", () => {
      expect(readTestOutput(PW_FAIL_COLOUR)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay › locks the amount into the QR"] });
    });

    it("counts a skipped test in the total and not among the ones that passed", () => {
      expect(readTestOutput(PW_FAIL_SKIP)).toEqual({ kind: "failed", failed: 1, total: 6, names: ["promptpay › locks the amount into the QR"] });
      expect(readTestOutput("  2 skipped\n  3 passed (1.1s)\n")).toEqual({ kind: "passed", passed: 3 });
    });

    it("takes a project's name off the test's place, and names a test once", () => {
      expect(readTestOutput(PW_FAIL_PROJECT)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay › locks the amount into the QR"] });
      const twice = ["  2 failed", "    [chromium] › a.spec.ts:3:1 › a › b ───", "    [webkit] › a.spec.ts:3:1 › a › b ───", "  3 passed (2.0s)"].join("\n");
      expect(readTestOutput(twice)).toEqual({ kind: "failed", failed: 2, total: 5, names: ["a › b"] });
    });

    it("names each test the summary lists under failed, as many as it counts and no more", () => {
      const two = ["  2 failed", "    a.spec.ts:3:1 › a › first ───", "    b.spec.ts:7:1 › b ───", "  3 passed (2.0s)"].join("\n");
      expect(readTestOutput(two)).toEqual({ kind: "failed", failed: 2, total: 5, names: ["a › first", "b"] });
      // one failed: the next place is another kind's (here a flaky test's) and is not named
      const one = ["  1 failed", "    a.spec.ts:3:1 › a ───", "    b.spec.ts:7:1 › b ───", "  1 passed (1ms)"].join("\n");
      expect(readTestOutput(one)).toMatchObject({ failed: 1, names: ["a"] });
      // a flaky test is listed under its own line, and is no failure
      expect(readTestOutput(["  1 failed", "    a.spec.ts:3:1 › a ───", "  1 flaky", "    b.spec.ts:7:1 › b ───", "  1 passed (1ms)"].join("\n"))).toMatchObject({ failed: 1, total: 3, names: ["a"] });
    });

    it("reads a flaky test as one that passed, as Playwright's own status does, and never when the command ended in an error", () => {
      // 5 passed and 1 flaky: the flaky one is not in the line that counts the passed
      expect(readTestOutput(PW_FLAKY)).toEqual({ kind: "passed", passed: 6 });
      expect(readTestOutput(PW_FLAKY, { ok: false })).toEqual({ kind: "unknown", why: "exit" });
    });

    it("reads a run that stopped at its first failure as failed, with the tests that did not run in its total", () => {
      expect(readTestOutput(PW_STOPPED)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay › locks the amount into the QR"] });
    });

    it("leaves a run that stopped without a failure unknown: a test that did not run, or was interrupted, or an error outside the tests is no pass", () => {
      const interrupted = ["  1 interrupted", "    tests/a.spec.ts:3:1 › x ───", "  4 did not run", ""].join("\n");
      expect(readTestOutput(interrupted)).toEqual({ kind: "unknown", why: "errors" });
      // in the order Playwright prints them: did not run, then passed
      expect(readTestOutput("  2 did not run\n  3 passed (1.2s)\n")).toEqual({ kind: "unknown", why: "errors" });
      expect(readTestOutput("  4 did not run\n", { runner: "playwright" })).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput("  3 passed (1.2s)\n  1 error was not a part of any test, see above for details\n")).toEqual({ kind: "unknown", why: "errors" });
      expect(readTestOutput("  3 passed (1.2s)\n  2 errors were not a part of any test, see above for details\n")).toEqual({ kind: "unknown", why: "errors" });
    });

    it("leaves a run that found no test, or could not load one, unknown", () => {
      expect(readTestOutput(PW_NOTHING)).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(PW_SYNTAX)).toEqual({ kind: "unknown", why: "no_summary" });
      // every test skipped: nothing ran, and a line of skipped tests alone is no more than words
      expect(readTestOutput("  2 skipped\n", { runner: "playwright" })).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("reads no line that only looks like a summary: passed carries the time, and failed is followed by the test", () => {
      for (const out of [
        "  3 passed\n",
        "  3 failed\n",
        "  3 failed\n  more words\n",
        "  3 failed\n    a plain line with no place\n",
        // a place with fewer or more than four spaces before it is not the summary's
        "  3 failed\n  abtests/a.spec.ts:3:1 › x\n",
        "  3 failed\n      tests/a.spec.ts:3:1 › x\n",
        "  3 flaky\n",
        "3 passed (1.2s)\n",
        "   3 passed (1.2s)\n",
        "  3 passed (soon)\n",
      ]) {
        expect(readTestOutput(out, { runner: "playwright" }), JSON.stringify(out)).toEqual({ kind: "unknown", why: "no_summary" });
      }
    });

    it("does not take a pass from a run whose command ended in an error, and reads a failure whatever the status said", () => {
      expect(readTestOutput(PW_PASS, { ok: false })).toEqual({ kind: "unknown", why: "exit" });
      expect(readTestOutput(PW_FAIL, { ok: true })).toMatchObject({ kind: "failed", failed: 1 });
    });

    it("is read as Playwright's only when the command names it", () => {
      expect(readTestOutput(PW_PASS, { runner: "vitest" })).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(fixture("vitest-pass"), { runner: "playwright" })).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("adds up the runs of a workspace, each line led by pnpm's package prefix, and a block of one run is not another's", () => {
      const prefixed = (pkg: string, out: string) => out.split("\n").map((l) => `${pkg} test:e2e: ${l}`).join("\n");
      expect(readTestOutput(`${prefixed("apps/web", PW_PASS)}\n${prefixed("apps/desktop", PW_PASS)}`)).toEqual({ kind: "passed", passed: 10 });
      expect(readTestOutput(`${prefixed("apps/web", PW_PASS)}\n${prefixed("apps/desktop", PW_FAIL)}`)).toEqual({ kind: "failed", failed: 1, total: 10, names: ["promptpay › locks the amount into the QR"] });
      // two failed blocks in a row are two runs, whatever they name
      expect(readTestOutput(`${PW_FAIL_PROJECT}${PW_FAIL_PROJECT}`)).toMatchObject({ kind: "failed", failed: 2, total: 10 });
    });
  });

  describe("unittest", () => {
    it("reads a run that passed, with its count", () => {
      expect(readTestOutput(UT_PASS)).toEqual({ kind: "passed", passed: 5 });
      expect(readTestOutput(UT_PASS, { runner: "unittest" })).toEqual({ kind: "passed", passed: 5 });
    });

    it("reads a run that failed: how many of how many, and which test its header after the line of equals signs names", () => {
      expect(readTestOutput(UT_FAIL)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay)"] });
    });

    it("reads the verbose form, whose lines `… ok` and `… FAIL` are no header", () => {
      const verbose = text(
        "test_adds_a_qr (tests.test_promptpay.PromptPay) ... ok",
        "test_keeps_the_total (tests.test_promptpay.PromptPay) ... ok",
        "test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay) ... FAIL",
        "test_reads_the_shop_id (tests.test_promptpay.PromptPay) ... ok",
        "test_shows_the_shop_name (tests.test_promptpay.PromptPay) ... ok",
        "",
        UT_FAIL.split("\n").slice(1).join("\n"),
      );
      expect(readTestOutput(verbose)).toEqual({ kind: "failed", failed: 1, total: 5, names: ["test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay)"] });
    });

    it("counts a test that raised as one that failed, and a skipped test or an expected failure as neither passed nor failed", () => {
      expect(readTestOutput(UT_MIXED)).toEqual({
        kind: "failed",
        failed: 2,
        total: 5,
        names: ["test_reads_the_shop_id (tests.test_promptpay.PromptPay)", "test_locks_the_amount_into_the_qr (tests.test_promptpay.PromptPay)"],
      });
    });

    it("reads a test module that could not be imported as the failed test unittest makes up for it", () => {
      expect(readTestOutput(UT_IMPORT_ERROR)).toEqual({ kind: "failed", failed: 1, total: 1, names: ["test_broken_import (unittest.loader._FailedTest)"] });
    });

    it("reads an unexpected success as a failure, as unittest does, with no name since it prints none", () => {
      expect(readTestOutput(text(".u", "-".repeat(70), "Ran 2 tests in 0.000s", "", "FAILED (unexpected successes=1)", ""))).toEqual({ kind: "failed", failed: 1, total: 2, names: [] });
    });

    it("counts only the tests that ran and were not skipped among the ones that passed", () => {
      expect(readTestOutput(text(".s.", "-".repeat(70), "Ran 3 tests in 0.000s", "", "OK (skipped=1)", ""))).toEqual({ kind: "passed", passed: 2 });
      expect(readTestOutput(text(".x.", "-".repeat(70), "Ran 3 tests in 0.000s", "", "OK (expected failures=1)", ""))).toEqual({ kind: "passed", passed: 2 });
      expect(readTestOutput(text(".", "-".repeat(70), "Ran 1 test in 0.000s", "", "OK", ""))).toEqual({ kind: "passed", passed: 1 });
    });

    it("leaves a run of no tests unknown: Python before 3.12 says OK of none, and 3.12 and after say NO TESTS RAN", () => {
      expect(readTestOutput(text("", "-".repeat(70), "Ran 0 tests in 0.000s", "", "OK", ""))).toEqual({ kind: "unknown", why: "no_tests" });
      expect(readTestOutput(text("", "-".repeat(70), "Ran 0 tests in 0.000s", "", "NO TESTS RAN", ""))).toEqual({ kind: "unknown", why: "no_tests" });
    });

    it("leaves a run in which every test was skipped unknown, since nothing passed", () => {
      expect(readTestOutput(text("s", "-".repeat(70), "Ran 1 test in 0.000s", "", "OK (skipped=1)", ""))).toEqual({ kind: "unknown", why: "no_tests" });
    });

    it("leaves a run that says how many tests ran and no verdict unknown", () => {
      expect(readTestOutput(text("....", "-".repeat(70), "Ran 5 tests in 0.000s", ""))).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(text("Ran 5 tests in 0.000s", "", "that is all", "OK"))).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("takes no name from a line that only looks like a header, and keeps the counts", () => {
      // a test's own output that says FAIL: or ERROR: is no header, since no line of `=` stands above it
      const out = text("FAIL: not a header", "ERROR: nor is this", "-".repeat(70), "Ran 1 test in 0.100s", "", "FAILED (failures=1)", "");
      expect(readTestOutput(out)).toEqual({ kind: "failed", failed: 1, total: 1, names: [] });
      // and a short line of `=` is a rule of some other kind
      expect(readTestOutput(text("=".repeat(19), "FAIL: x (a.B)", "-".repeat(70), "Ran 1 test in 0.100s", "", "FAILED (failures=1)", ""))).toMatchObject({ names: [] });
      // and the verdict is the next line that says anything, whatever number of blank lines come between
      expect(readTestOutput(text("=".repeat(70), "FAIL: x (a.B)", "-".repeat(70), "Ran 1 test in 0.1s", "", "", "", "FAILED (failures=1)", ""))).toMatchObject({ failed: 1, names: ["x (a.B)"] });
    });

    it("does not take a pass from a run whose command ended in an error, and reads a failure whatever the status said", () => {
      expect(readTestOutput(UT_PASS, { ok: false })).toEqual({ kind: "unknown", why: "exit" });
      expect(readTestOutput(UT_FAIL, { ok: true })).toMatchObject({ kind: "failed", failed: 1 });
    });

    it("is read as unittest's only when the command names it", () => {
      expect(readTestOutput(UT_PASS, { runner: "pytest" })).toEqual({ kind: "unknown", why: "no_summary" });
      expect(readTestOutput(fixture("pytest-pass"), { runner: "unittest" })).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("adds up the runs of a workspace, each line led by pnpm's package prefix", () => {
      const prefixed = (pkg: string, out: string) => out.split("\n").map((l) => `${pkg} test: ${l}`).join("\n");
      expect(readTestOutput(`${prefixed("services/pay", UT_PASS)}\n${prefixed("services/shop", UT_PASS)}`)).toEqual({ kind: "passed", passed: 10 });
      expect(readTestOutput(`${prefixed("services/pay", UT_PASS)}\n${prefixed("services/shop", UT_FAIL)}`)).toMatchObject({ kind: "failed", failed: 1, total: 10 });
    });
  });

  describe("the three newest readers beside the others", () => {
    it("read nothing from the outputs of the six that came before them, and are not read in theirs", () => {
      for (const name of ["vitest-pass", "vitest-fail", "jest-pass", "jest-fail", "node-pass", "node-fail", "pytest-pass", "pytest-fail", "go-pass", "go-fail", "cargo-pass", "cargo-fail"]) {
        for (const runner of ["mocha", "playwright", "unittest"] as const) {
          expect(readTestOutput(fixture(name), { runner }), `${name} as ${runner}`).toMatchObject({ kind: "unknown" });
        }
      }
      // with no runner named every reader is tried, and a run of one is read as it always was
      expect(read("vitest-fail")).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay > locks the amount into the QR"] });
      expect(readTestOutput(`${fixture("vitest-pass")}\n${MOCHA_PASS}\n${PW_PASS}\n${UT_PASS}`)).toEqual({ kind: "passed", passed: 17 });
    });

    it("are not slowed by lines made to look like their summaries, each as long as a line may be", () => {
      const lines = [
        `  ${"1 passing ".repeat(190)}(`,
        `${"1) ".repeat(600)}`,
        `${"Ran 1 tests in ".repeat(130)}`,
        `${"=".repeat(1_999)}`,
        `${"FAIL: ".repeat(330)}`,
        `  ${"1 failed ".repeat(220)}`,
        `    ${"a › ".repeat(480)}`,
        `${"OK (".repeat(480)}`,
        `${"x ".repeat(300)}test: ${"y ".repeat(300)}`,
      ];
      const out = Array.from({ length: 60 }, () => lines.join("\n")).join("\n");
      const at = performance.now();
      for (const runner of ["mocha", "playwright", "unittest", undefined] as const) readTestOutput(out, { runner });
      expect(performance.now() - at).toBeLessThan(1_500);
    });
  });

  describe("several runs in one output", () => {
    it("adds up a workspace's packages, each line led by pnpm's package prefix", () => {
      const out = [...fixture("vitest-pass").split("\n").map((l) => `packages/format test: ${l}`), ...fixture("vitest-pass").split("\n").map((l) => `apps/desktop test: ${l}`)].join("\n");
      expect(readTestOutput(out)).toEqual({ kind: "passed", passed: 4 });
    });

    it("reads one failing package among passing ones as a failed run", () => {
      const out = `${fixture("vitest-pass")}\n${fixture("vitest-fail")}`;
      expect(readTestOutput(out)).toEqual({ kind: "failed", failed: 1, total: 7, names: ["promptpay > locks the amount into the QR"] });
    });

    it("adds up different runners, and fails the whole when one of them failed", () => {
      expect(readTestOutput(`${fixture("vitest-pass")}\n${fixture("cargo-pass")}`)).toEqual({ kind: "passed", passed: 4 });
      expect(readTestOutput(`${fixture("vitest-pass")}\n${fixture("pytest-fail")}`)).toMatchObject({ kind: "failed", failed: 1, total: 7 });
    });

    it("has no count for a run that gave none, so the total of a pass is not a guess", () => {
      expect(readTestOutput(`${fixture("vitest-pass")}\n${fixture("go-pass")}`)).toEqual({ kind: "passed", passed: null });
    });
  });

  describe("what is never read as a pass", () => {
    it("leaves output with no summary unknown", () => {
      // the last seven are what mocha, Playwright and unittest print some of, and not the whole of
      for (const out of ["", "   \n\n", "Done in 3.2s\n", "Tests are fun\n", "all good", "PASS\n", "OK\n", "Ran 3 tests in 0.1s\n", "  3 passed\n", "  3 failed\n", "  3 passing\n", "  1 failing\n", "  2 skipped\n"]) {
        expect(readTestOutput(out), JSON.stringify(out)).toMatchObject({ kind: "unknown" });
        expect(readTestOutput(out, { ok: true }), JSON.stringify(out)).toMatchObject({ kind: "unknown" });
      }
      expect(readTestOutput(undefined)).toEqual({ kind: "unknown", why: "no_output" });
    });

    it("does not take a pass from a run whose command ended with an error", () => {
      expect(read("vitest-pass", false)).toEqual({ kind: "unknown", why: "exit" });
      expect(read("go-pass", false)).toEqual({ kind: "unknown", why: "exit" });
    });

    it("does not call an unreadable run that ended with an error a failure either, for the output does not say so", () => {
      expect(readTestOutput("sh: vitest: command not found\n", { ok: false })).toEqual({ kind: "unknown", why: "no_summary" });
    });

    it("trusts the output over an exit status that hid the failure (`|| true`)", () => {
      expect(read("vitest-fail", true)).toMatchObject({ kind: "failed", failed: 1 });
    });

    it("reads a passed run whose exit status is not known", () => {
      expect(read("vitest-pass", undefined)).toEqual({ kind: "passed", passed: 2 });
    });
  });

  describe("an output cut from its head, as the shell sends only the end of a long one", () => {
    it("still reads the summary, with no name when the failure's lines were cut away", () => {
      const tail = fixture("vitest-fail").slice(-260);
      expect(readTestOutput(tail)).toEqual({ kind: "failed", failed: 1, total: 5, names: [] });
    });

    it("reads only the end of an output of megabytes, quickly", () => {
      const out = `${"x".repeat(80)}\n`.repeat(40_000) + fixture("vitest-pass");
      const at = performance.now();
      expect(readTestOutput(out)).toEqual({ kind: "passed", passed: 2 });
      expect(performance.now() - at).toBeLessThan(500);
    });

    it("is not slowed by lines made to look like a summary, each as long as a line may be", () => {
      const lines = [`Tests ${"1 passed | ".repeat(170)}`, "= ".repeat(950), `${"1 passed, ".repeat(190)}in`, "ok  ".repeat(480), `${"FAIL ".repeat(380)}`, `● ${"a ".repeat(900)}`];
      const out = Array.from({ length: 60 }, () => lines.join("\n")).join("\n");
      const at = performance.now();
      readTestOutput(out);
      expect(performance.now() - at).toBeLessThan(500);
      // and a line past the limit is not read at all
      expect(readTestOutput(`Tests  1 passed (1)${" ".repeat(3_000)}x`)).toMatchObject({ kind: "unknown" });
    });
  });

  describe("which tests failed", () => {
    it("keeps the first few names, each once and each short", () => {
      const lines = Array.from({ length: 30 }, (_, i) => ` FAIL  a.test.ts > case ${i % 15} ${"x".repeat(300)}`);
      const r = readTestOutput([...lines, "      Tests  30 failed (30)"].join("\n"));
      if (r.kind !== "failed") throw new Error("expected a failed run");
      expect(r.names).toHaveLength(MAX_NAMES);
      expect(new Set(r.names).size).toBe(r.names.length);
      expect(Math.max(...r.names.map((n) => n.length))).toBeLessThanOrEqual(160);
    });
  });
});

describe("stripAnsi", () => {
  it("takes out colours, cursor moves and window titles, and keeps the words", () => {
    expect(stripAnsi("\u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m | \u001b[32m3 passed\u001b[39m")).toBe("1 failed | 3 passed");
    expect(stripAnsi("a\u001b[2K\u001b[1Gb\u001b]0;title\u0007c")).toBe("abc");
    expect(stripAnsi("plain text, 100% (3)")).toBe("plain text, 100% (3)");
  });
});

describe("whether a command runs tests", () => {
  const yes = [
    "pnpm test",
    "npm test",
    "npm t",
    "npm run test",
    "npm run test:unit",
    "npm run-script test",
    "yarn test",
    "yarn run test:e2e",
    "bun test",
    "pnpm --filter @manut/desktop test",
    "pnpm -r --workspace-concurrency=1 --if-present --no-bail test",
    "pnpm -C apps/desktop test -- --run",
    "pnpm run test --reporter=verbose",
    "pnpm exec vitest run src/code/testRun.test.ts",
    "pnpm vitest run",
    "npx vitest run",
    "npx --yes jest --ci",
    "vitest",
    "vitest run tests/*.test.ts",
    "jest",
    "node --test",
    "node --test tests/",
    "node --test-reporter=spec --test",
    "pytest -q",
    "py.test",
    "python -m pytest",
    "python3 -m pytest tests/ -x",
    "go test ./...",
    "go test -v -run TestX ./pkg",
    "cargo test",
    "cargo test --workspace --no-fail-fast",
    "npx playwright test",
    "pnpm exec playwright test",
    "pnpm playwright test --project=chromium",
    "playwright test e2e/kit-code.spec.ts --reporter=line --workers=2",
    "npx playwright test --reporter=list",
    "mocha",
    "npx mocha",
    "npx mocha 'test/**/*.js' --reporter dot",
    "pnpm exec mocha --recursive",
    "./node_modules/.bin/mocha test/",
    "python -m unittest",
    "python3 -m unittest discover",
    "python3 -m unittest discover -s tests -v",
    "python3.12 -m unittest tests.test_promptpay",
    "cd svc && python -m unittest -v",
    "cd apps/desktop && pnpm test",
    "CI=1 pnpm test",
    "FORCE_COLOR=0 NODE_ENV=test npx vitest run",
    "time pnpm test",
    "pnpm lint && pnpm test",
    "pnpm typecheck; pnpm test | tail -20",
    "pnpm test || true",
    "(cd packages/format && pnpm test)",
    "echo start\npnpm test",
  ];
  const no = [
    "pnpm install",
    "pnpm build",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm add vitest",
    "npm install jest",
    "npm run build",
    "yarn add -D pytest",
    "git commit -m 'test'",
    "git commit -m \"fix: pnpm test\"",
    "echo go test",
    "echo \"cargo test\"",
    "cat tests/a.test.ts",
    "ls test",
    "grep -r pytest .",
    "go build ./...",
    "go vet ./...",
    "cargo build",
    "cargo check",
    "node index.js",
    "node scripts/test-data.js",
    "python app.py",
    "playwright install",
    "npx playwright install chromium",
    "playwright show-report",
    "npx playwright codegen http://localhost:3000",
    "pnpm add -D mocha",
    "npm install --save-dev @playwright/test",
    "echo mocha",
    "cat test/mocha.opts",
    "python -m venv .venv",
    "python -m http.server 8000",
    "python -m pip install unittest2",
    "python3 -m unittester",
    "pnpm --filter test build",
    "",
    "   ",
  ];

  it.each(yes)("is a test run: %s", (line) => expect(runsTests(line)).toBe(true));
  it.each(no)("is not a test run: %s", (line) => expect(runsTests(line)).toBe(false));
});

describe("the runner a command names", () => {
  const cases: [string, ReturnType<typeof runnerOf>][] = [
    ["vitest run", "vitest"],
    ["pnpm exec vitest run", "vitest"],
    ["npx jest --ci", "jest"],
    ["node --test", "node"],
    ["pytest -q", "pytest"],
    ["python3 -m pytest", "pytest"],
    ["go test ./...", "go"],
    ["cd svc && go test -v ./...", "go"],
    ["cargo test --workspace", "cargo"],
    ["mocha", "mocha"],
    ["npx mocha --reporter dot", "mocha"],
    ["pnpm exec mocha test/", "mocha"],
    ["npx playwright test", "playwright"],
    ["pnpm exec playwright test --project=chromium", "playwright"],
    ["python -m unittest", "unittest"],
    ["python3 -m unittest discover -s tests", "unittest"],
    ["cd svc && python3.12 -m unittest -v", "unittest"],
    // two different runners in one line, and the ones whose output nothing reads
    ["mocha && npx playwright test", null],
    ["python -m unittest && pytest", null],
    ["npx ava", null],
    ["cypress run", null],
    ["npx playwright test && npx playwright test --project=webkit", "playwright"],
    // a package's own `test` script runs whatever the project chose, so the output says which
    ["pnpm test", null],
    ["npm run test:unit", null],
    // two different runners in one line: neither is the one
    ["cargo test && go test ./...", null],
    ["pnpm install", null],
  ];
  it.each(cases)("%s", (line, runner) => expect(runnerOf(line)).toBe(runner));
});

describe("where a command runs its tests, for a lane in a folder of its own", () => {
  const LANE = "/Users/fon/.manut/lanes/baanmali-preorder/promptpay-qr";
  const HOME = "/Users/fon";
  const outside = (line: string) => testsRunOutside(line, LANE, HOME);

  it("runs them in the lane's folder, or one inside it", () => {
    for (const line of ["pnpm test", "cd apps/web && pnpm test", `cd ${LANE}/apps/web && vitest run`, "cd apps && cd web && go test ./...", "pnpm -C apps/web test", "npm --prefix=apps/web test", "cd .. && cd promptpay-qr && pnpm test", "FOO=1 pnpm test", "pnpm build && ls"]) {
      expect(outside(line), line).toBe(false);
    }
  });

  it("runs them outside when the words send them to another folder: the developer's own, another lane's, up and out", () => {
    for (const line of [
      "cd /Users/fon/work/baanmali-preorder && pnpm test",
      "cd ~/work/baanmali-preorder && pnpm test",
      "cd ../other-lane && pnpm test",
      "pushd /tmp && vitest run",
      "pnpm -C /Users/fon/work/baanmali-preorder test",
      "pnpm --dir ../.. test",
      "yarn --cwd=/Users/fon/work/baanmali-preorder test",
      "cd && pnpm test",
    ]) {
      expect(outside(line), line).toBe(true);
    }
  });

  it("counts a folder the words cannot say as outside: a variable, a pattern, the last folder, after a popd", () => {
    for (const line of ["cd $PROJECT && pnpm test", "cd \"$(git rev-parse --show-toplevel)\" && pnpm test", "cd app* && pnpm test", "cd - && pnpm test", "popd && pnpm test"]) {
      expect(outside(line), line).toBe(true);
    }
    // `~` with no home folder known
    expect(testsRunOutside("cd ~/x && pnpm test", LANE, null)).toBe(true);
  });

  it("runs none outside when it runs no tests, wherever it goes", () => {
    expect(outside("cd /Users/fon/work/baanmali-preorder && pnpm build")).toBe(false);
    // a quoted word is one word: no `cd` here
    expect(outside('git commit -m "cd /tmp && pnpm test"')).toBe(false);
  });
});
