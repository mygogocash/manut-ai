// Tests for playwright-summary.mjs, run by `node --test` (the root `pnpm test` does). They run the script as CI does,
// on reports written the way Playwright's JSON reporter writes them, and read what it prints.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "playwright-summary.mjs");
const root = mkdtempSync(join(tmpdir(), "pw-summary-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** What the script prints for these arguments. GITHUB_STEP_SUMMARY is left out so that it prints. */
function summarise(...args) {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  return execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
}

/** The exit status, what it printed and what it logged, for a run that may fail. */
function check(...args) {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const out = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** A report with the fields the script reads. `failed` is a list of [file, line, title, projects], where `projects` is
 *  optional: the [projectName, status] pairs of a spec that ran in several Playwright projects. */
function report({ shard, expected = 0, unexpected = 0, flaky = 0, skipped = 0, duration = 1000, failed = [], errors = [] } = {}) {
  const files = new Map();
  for (const [file, line, title, projects] of failed) {
    if (!files.has(file)) files.set(file, { title: file, file, specs: [], suites: [] });
    const tests = projects?.map(([projectName, status]) => ({ projectName, status }));
    files.get(file).specs.push({ title, ok: false, file, line, ...(tests ? { tests } : {}) });
  }
  return {
    config: shard ? { shard: { current: shard[0], total: shard[1] } } : {},
    suites: [...files.values()],
    errors: errors.map((message) => ({ message })),
    stats: { startTime: "2026-11-24T00:00:00.000Z", duration, expected, skipped, unexpected, flaky },
  };
}

/** A directory holding these reports as shard files; `raw` entries are written as they are. */
function run(name, reports, raw = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  reports.forEach((r, i) => writeFileSync(join(dir, `playwright-results-${i + 1}.json`), JSON.stringify(r)));
  for (const [file, text] of Object.entries(raw)) writeFileSync(join(dir, file), text);
  return dir;
}

describe("a shard's own summary", () => {
  it("shows its counts under the title it was given, and does not look for other shards", () => {
    const dir = run("own", [report({ shard: [2, 6], expected: 130, unexpected: 1, flaky: 2, skipped: 40, duration: 125_000, failed: [["tasks.spec.ts", 12, "a row opens"]] })]);
    const out = summarise("--title", "Desktop Playwright, shard 2 of 6", join(dir, "playwright-results-1.json"));
    assert.match(out, /^### Desktop Playwright, shard 2 of 6\n/);
    assert.match(out, /\| Passed \| Failed \| Flaky \| Skipped \| Time \|/);
    assert.match(out, /\| 130 \| 1 \| 2 \| 40 \| 2m 5s \|/);
    assert.match(out, /1 failing test<\/summary>/);
    assert.match(out, /- tasks\.spec\.ts:12 › a row opens/);
    assert.doesNotMatch(out, /shards? .* did not/);
  });
});

describe("the summary of a whole run", () => {
  it("adds the shards' counts, names the slowest one's time and lists every failing test", () => {
    const dir = run("whole", [
      report({ shard: [1, 3], expected: 100, skipped: 10, duration: 60_000 }),
      report({ shard: [2, 3], expected: 90, unexpected: 2, flaky: 1, skipped: 5, duration: 300_000, failed: [["term.spec.ts", 5, "one"], ["term.spec.ts", 9, "two"]] }),
      report({ shard: [3, 3], expected: 80, skipped: 1, duration: 90_000 }),
    ]);
    const out = summarise("--title", "Desktop Playwright (all shards)", dir);
    assert.match(out, /^### Desktop Playwright \(all shards\)\n/);
    assert.match(out, /\| Passed \| Failed \| Flaky \| Skipped \| Slowest shard \|/);
    assert.match(out, /\| 270 \| 2 \| 1 \| 16 \| 5m 0s \|/);
    assert.match(out, /2 failing tests<\/summary>/);
    assert.match(out, /- term\.spec\.ts:5 › one\n- term\.spec\.ts:9 › two/);
    assert.doesNotMatch(out, /did not/);
  });

  it("names a shard that left no report, even when only one report is there", () => {
    const dir = run("missing", [report({ shard: [1, 4], expected: 10 }), report({ shard: [3, 4], expected: 20 })]);
    assert.match(summarise(dir), /Only 2 of 4 shards left a report; shards 2, 4 did not/);
    const one = run("missing-one", [report({ shard: [2, 6], expected: 10 })]);
    assert.match(summarise(one), /Only 1 of 6 shards left a report; shards 1, 3, 4, 5, 6 did not/);
  });

  it("says which reports it could not read and still counts the others", () => {
    const dir = run("corrupt", [report({ shard: [1, 2], expected: 7 })], { "playwright-results-2.json": "{not json" });
    const out = summarise(dir);
    assert.match(out, /\| 7 \| 0 \| 0 \| 0 \|/);
    assert.match(out, /Reports that could not be read:/);
    assert.match(out, /playwright-results-2\.json/);
    assert.match(out, /shard 2 did not/);
  });

  it("puts the shard in front of an error that belongs to no test", () => {
    const dir = run("errors", [report({ shard: [1, 2] }), report({ shard: [2, 2], errors: ["\u001b[31mError: web server\u001b[39m\nmore"] })]);
    const out = summarise(dir);
    assert.match(out, /Errors outside the tests:/);
    assert.match(out, /- shard 2: Error: web server\n/);
    assert.doesNotMatch(out, /\u001b/);
  });
});

describe("what is written for people to read", () => {
  it("escapes a test title, so it is not read as HTML", () => {
    const dir = run("escape", [report({ shard: [1, 1], unexpected: 1, failed: [["a.spec.ts", 1, "<img src=x onerror=1> & more"]] })]);
    const out = summarise(join(dir, "playwright-results-1.json"));
    assert.match(out, /- a\.spec\.ts:1 › &lt;img src=x onerror=1&gt; &amp; more/);
    assert.doesNotMatch(out, /<img/);
  });

  it("says so when there is no report at all, and never fails the step", () => {
    assert.match(summarise(join(root, "nope.json")), /No usable report at `[^`]*nope\.json`\.\n- [^\n]*nope\.json: not found/);
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.match(summarise(empty), /No usable report at/);
    assert.match(summarise(), /No report was given\./);
  });
});

describe("a job that runs its specs in several projects", () => {
  it("names the projects a failing test failed in, and only those", () => {
    const projects = [["iPhone 17 (WebKit)", "expected"], ["Pixel 8 (Chromium)", "unexpected"], ["Android 360x740 (Chromium)", "unexpected"]];
    const dir = run("projects", [report({ unexpected: 2, failed: [["owner-pages.spec.ts", 14, "light › approval page: a reply", projects]] })]);
    const out = summarise("--title", "Web on phones", join(dir, "playwright-results-1.json"));
    assert.match(out, /- owner-pages\.spec\.ts:14 › light › approval page: a reply \[Pixel 8 \(Chromium\), Android 360x740 \(Chromium\)\]\n/);
    assert.doesNotMatch(out, /iPhone/);
  });

  it("adds no brackets for a test whose project has no name, as the desktop's report has none", () => {
    const dir = run("unnamed", [report({ unexpected: 1, failed: [["a.spec.ts", 1, "one", [["", "unexpected"]]], ["b.spec.ts", 2, "two"]] })]);
    const out = summarise(join(dir, "playwright-results-1.json"));
    assert.match(out, /- a\.spec\.ts:1 › one\n- b\.spec\.ts:2 › two\n/);
  });
});

describe("the note under the title", () => {
  it("is the desktop's sentence unless one is given, and can be left out", () => {
    const file = join(run("note", [report({ expected: 3 })]), "playwright-results-1.json");
    assert.match(summarise(file), /^### Desktop Playwright\n\nThis job may fail without failing the run while the inherited specs are brought up to date\.\n\n\| Passed/);
    assert.match(summarise("--note", "A failing test fails the run.", file), /^### Desktop Playwright\n\nA failing test fails the run\.\n\n\| Passed/);
    const none = summarise("--title", "Web on phones", "--note", "", file);
    assert.match(none, /^### Web on phones\n\n\| Passed/);
    assert.doesNotMatch(none, /may fail/);
  });

  it("is escaped like every other word", () => {
    const file = join(run("note-escape", [report({ expected: 1 })]), "playwright-results-1.json");
    const out = summarise("--note", "<b>bold</b> & more", file);
    assert.match(out, /&lt;b&gt;bold&lt;\/b&gt; &amp; more/);
    assert.doesNotMatch(out, /<b>/);
  });
});

describe("shards run on lists of files", () => {
  // e2e-shards.mjs gives each shard its files, so Playwright writes no shard into the report; the file name says which.
  it("names a shard that left no report from the file names and --shards", () => {
    const dir = run("lists", [report({ expected: 10 }), report({ expected: 20 }), report({ expected: 5 })]);
    const out = summarise("--shards", "5", dir);
    assert.match(out, /\| 35 \| 0 \| 0 \| 0 \|/);
    assert.match(out, /Only 3 of 5 shards left a report; shards 4, 5 did not/);
    assert.doesNotMatch(summarise("--shards", "3", dir), /did not/);
  });

  it("puts the shard from the file name in front of an error that belongs to no test", () => {
    const dir = run("list-errors", [report({}), report({ errors: ["Timed out waiting 1500s for the test suite to run"] })]);
    assert.match(summarise("--shards", "2", dir), /- shard 2: Timed out waiting 1500s/);
  });
});

describe("--strict, for the job whose result is the suite's", () => {
  it("passes a run where every shard reported and nothing failed, flaky tests included", () => {
    const dir = run("strict-green", [report({ shard: [1, 2], expected: 10, flaky: 2 }), report({ expected: 3, skipped: 1 })]);
    const result = check("--strict", "--shards", "2", dir);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /This fails the run/);
  });

  it("fails, after writing the summary, on a failed test, a missing shard, an unreadable report or an error", () => {
    const cases = [
      [run("strict-failed", [report({ expected: 1, unexpected: 1, failed: [["a.spec.ts", 3, "breaks"]] }), report({ expected: 1 })]), /1 failed test/],
      [run("strict-missing", [report({ expected: 1 })]), /a shard left no report/],
      [run("strict-unreadable", [report({ expected: 1 })], { "playwright-results-2.json": "{" }), /1 report could not be read/],
      [run("strict-error", [report({ expected: 1 }), report({ errors: ["Error: web server"] })]), /1 error outside the tests/],
    ];
    for (const [dir, why] of cases) {
      const result = check("--strict", "--shards", "2", dir);
      assert.equal(result.status, 1, dir);
      assert.match(result.stdout, /^### Desktop Playwright\n/);
      assert.match(result.stdout, new RegExp(`\\*\\*This fails the run:\\*\\* .*${why.source}`));
      assert.match(result.stderr, why);
    }
  });

  it("fails when there is no report at all, and never fails without --strict", () => {
    const empty = join(root, "strict-empty");
    mkdirSync(empty);
    assert.equal(check("--strict", "--shards", "2", empty).status, 1);
    assert.match(check("--strict", "--shards", "2", empty).stderr, /no report/);
    const failedDir = run("lenient", [report({ unexpected: 3 })]);
    assert.equal(check("--shards", "4", failedDir).status, 0);
    assert.equal(check(empty).status, 0);
  });
});
