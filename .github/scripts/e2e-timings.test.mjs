// Tests for e2e-timings.mjs, run by `node --test` (the root `pnpm test` does, and CI's Desktop tests job). They build
// reports the way Playwright's JSON reporter writes them and check the times the shards are balanced by.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { format, merge, timingsOfReport, timingsOfReports } from "./e2e-timings.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "e2e-timings.mjs");
const scratch = mkdtempSync(join(tmpdir(), "e2e-timings-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A report: for each spec file, its tests' attempts in milliseconds, some under a describe block. */
function report(files, stats = { expected: 1, unexpected: 0 }) {
  return {
    stats,
    suites: Object.entries(files).map(([file, attempts]) => ({
      title: file,
      file,
      specs: [{ title: "top", file, tests: [{ results: attempts.slice(0, 1).map((duration) => ({ duration })) }] }],
      suites: [{ title: "block", file, specs: [{ title: "inner", file: "helper.ts", tests: [{ results: attempts.slice(1).map((duration) => ({ duration })) }] }], suites: [] }],
    })),
  };
}

describe("the time of a spec file", () => {
  it("adds every attempt of every test under it, retries and tests declared in a helper module included", () => {
    assert.deepEqual(timingsOfReport(report({ "a.spec.ts": [1000, 2500, 500], "b.spec.ts": [0] })), { "a.spec.ts": 4, "b.spec.ts": 0 });
  });

  it("keeps the longer time of a file two reports both measured, and ignores what is not a report", () => {
    assert.deepEqual(timingsOfReports([report({ "a.spec.ts": [1000] }), report({ "a.spec.ts": [3000], "b.spec.ts": [500] }), {}, null]), { "a.spec.ts": 3, "b.spec.ts": 0.5 });
  });
});

describe("the new timings", () => {
  it("takes measured times, keeps committed ones for files not measured, and drops files that are gone", () => {
    const base = { "a.spec.ts": 10, "kept.spec.ts": 7, "gone.spec.ts": 3 };
    const measured = { "a.spec.ts": 12.345, "new.spec.ts": 0.04, "deleted.spec.ts": 9 };
    const out = merge(base, measured, ["new.spec.ts", "a.spec.ts", "kept.spec.ts", "untimed.spec.ts"]);
    assert.deepEqual(out, { "a.spec.ts": 12.3, "kept.spec.ts": 7, "new.spec.ts": 0 });
    assert.deepEqual(Object.keys(out), ["a.spec.ts", "kept.spec.ts", "new.spec.ts"]);
    assert.equal(format(out), '{\n  "a.spec.ts": 12.3,\n  "kept.spec.ts": 7,\n  "new.spec.ts": 0\n}\n');
  });
});

describe("the command CI runs", () => {
  const specs = join(scratch, "e2e");
  mkdirSync(join(specs, "sub"), { recursive: true });
  for (const file of ["a.spec.ts", "b.spec.ts", "sub/c.spec.ts", "untimed.spec.ts"]) writeFileSync(join(specs, file), "\n");
  writeFileSync(join(specs, "timings.json"), JSON.stringify({ "b.spec.ts": 5, "a.spec.ts": 1 }));
  const run = (...args) => spawnSync(process.execPath, [script, "--dir", specs, ...args], { encoding: "utf8" });

  it("writes the timings of every report under a folder, artifacts' sub-folders included, and says what it read", () => {
    const reports = join(scratch, "reports");
    mkdirSync(join(reports, "playwright-results-2"), { recursive: true });
    writeFileSync(join(reports, "playwright-results-1.json"), JSON.stringify(report({ "a.spec.ts": [2000] })));
    writeFileSync(join(reports, "playwright-results-2", "playwright-results-2.json"), JSON.stringify(report({ "sub/c.spec.ts": [1500, 1500] })));
    writeFileSync(join(reports, "broken.json"), "{nope");
    const out = join(scratch, "timings-out.json");
    const result = run("--reports", reports, "--out", out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { "a.spec.ts": 2, "b.spec.ts": 5, "sub/c.spec.ts": 3 });
    assert.match(result.stderr, /not read: .*broken\.json/);
    assert.match(result.stderr, /2 measured in this run, 1 kept from before \(b\.spec\.ts\), 1 new, 0 dropped/);
    // The committed file is left as it was: CI writes only the artifact.
    assert.deepEqual(JSON.parse(readFileSync(join(specs, "timings.json"), "utf8")), { "b.spec.ts": 5, "a.spec.ts": 1 });
  });

  it("says when the reports held failed tests, whose times include timeouts", () => {
    const reports = join(scratch, "failed");
    mkdirSync(reports);
    writeFileSync(join(reports, "r.json"), JSON.stringify(report({ "a.spec.ts": [30000, 30000] }, { expected: 0, unexpected: 1 })));
    const result = run("--reports", reports, "--out", join(scratch, "failed.json"));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /note: 1 test failed in these reports/);
  });

  it("fails when there is no report, or no run id and no reports", () => {
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const none = run("--reports", empty, "--out", join(scratch, "none.json"));
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no Playwright report/);
    assert.match(run("--reports", empty).stderr, /--reports needs --out/);
    const usage = run("not-a-run");
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: e2e-timings\.mjs <run id>/);
  });
});
