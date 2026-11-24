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
      for (const out of ["", "   \n\n", "Done in 3.2s\n", "Tests are fun\n", "all good", "PASS\n"]) {
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
