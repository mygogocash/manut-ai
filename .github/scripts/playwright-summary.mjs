// Writes a Playwright suite's result into the CI job summary: how many tests passed, failed, were flaky or were
// skipped, and which ones failed. It serves the desktop suite and the web app's phone specs (the `web-phones` jobs).
//
// The desktop suite runs as shards side by side (the `e2e` job's matrix, each shard a set of whole spec files chosen by
// .github/scripts/e2e-shards.mjs). Each shard calls this with its own report and a title naming it; the all-shards job
// calls it with every shard's report, and the counts are added up.
//
// Usage: node .github/scripts/playwright-summary.mjs [--title <text>] [--note <text>] [--shards <n>] [--strict]
//        <report.json | directory>...
// A report is what Playwright's JSON reporter writes; a directory stands for the .json files in it. --note is the
// sentence under the title (a default one without it, none with an empty one). A failing test that ran in several
// Playwright projects (the web app's phones run each spec) is listed once with the projects it failed in. The summary
// is appended to the file GitHub names in GITHUB_STEP_SUMMARY, or printed when run outside Actions.
//
// --shards is how many shards the run had, so a shard that left no report is named. A report says which shard it was
// when Playwright's own --shard made it; a shard run on a list of files does not, so its number is read from its file
// name, playwright-results-<n>.json, as the e2e job names it.
//
// Without --strict the script never fails the step: a missing or unreadable report is itself what the summary then
// says. With --strict, which the all-shards job uses so that a shard's failure fails the run, it exits 1 after writing
// the summary when any test failed, an error stopped the suite outside a test, a report is missing or unreadable, or
// fewer shards reported than --shards names. A test that passed on its retry is flaky, which does not fail it.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
let title = "Desktop Playwright";
let note = "A failing test fails the run. A test that passed only when run again is counted as flaky.";
let expectedShards = 0;
let strict = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--title") title = args[++i] ?? title;
  else if (args[i] === "--note") note = args[++i] ?? note;
  else if (args[i] === "--shards") expectedShards = Math.max(0, Math.floor(Number(args[++i])) || 0);
  else if (args[i] === "--strict") strict = true;
  else inputs.push(args[i]);
}

// Test titles and error messages come from people and tools; escaping keeps them from being read as HTML.
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Playwright colours its messages for a terminal; the summary shows them as plain text.
const plain = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");
const duration = (ms) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Every report path the inputs stand for, what went wrong with an input that stands for none, and whether a
 *  directory was given: that is how the job that adds the shards up asks, where a shard's own job gives its one file. */
function collect(paths) {
  const files = [];
  const problems = [];
  let wholeRun = false;
  for (const path of paths) {
    try {
      if (statSync(path).isDirectory()) {
        wholeRun = true;
        const inside = readdirSync(path).filter((name) => name.endsWith(".json")).sort();
        if (inside.length === 0) problems.push(`no report in ${path}`);
        for (const name of inside) files.push(join(path, name));
      } else files.push(path);
    } catch (error) {
      problems.push(`${path}: ${error.code === "ENOENT" ? "not found" : plain(error.message)}`);
    }
  }
  return { files, problems, wholeRun };
}

/** Which shard a report is: what Playwright's --shard wrote in it, or else the number in its file name. */
function shardOf({ file, report }) {
  const own = Number(report.config?.shard?.current);
  if (own > 0) return own;
  const named = /-(\d+)\.json$/.exec(basename(file));
  return named ? Number(named[1]) : 0;
}

/** Each readable report, and what went wrong with each that is not. */
function load(files) {
  const reports = [];
  const problems = [];
  for (const file of files) {
    try {
      const report = JSON.parse(readFileSync(file, "utf8"));
      if (!report || typeof report !== "object" || !report.stats) throw new Error("it has no stats");
      reports.push({ file, report });
    } catch (error) {
      problems.push(`${file}: ${plain(error.message)}`);
    }
  }
  return { reports, problems };
}

/** The tests that did not end as expected, under the describe blocks that hold them. The top-level suites are the
 *  spec files, so their titles are left out: each line already starts with the file. */
function failing(report) {
  const failed = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      if (spec.ok) continue;
      // A spec runs once in each project, and its title says nothing of which: name the ones it failed in. A report
      // with no named projects (the desktop's) adds nothing.
      const projects = (spec.tests ?? []).filter((test) => test.status === "unexpected" && test.projectName).map((test) => test.projectName);
      failed.push(`${spec.file}:${spec.line} › ${[...titles, spec.title].join(" › ")}${projects.length > 0 ? ` [${projects.join(", ")}]` : ""}`);
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, []);
  return failed;
}

const lines = [`### ${escape(title)}`, ""];
/** What makes a --strict run fail, in a few words each. */
const broken = [];

try {
  const { files, problems: missing, wholeRun } = collect(inputs);
  const { reports, problems: unreadable } = load(files);
  const problems = [...missing, ...unreadable];

  if (reports.length === 0) {
    broken.push("no report");
    lines.push(
      inputs.length === 0 ? "No report was given." : `No usable report at ${inputs.map((input) => `\`${escape(input)}\``).join(", ")}.`,
      ...problems.map((problem) => `- ${escape(problem)}`),
      "",
      "Playwright stopped before it could write one; the log of the step that ran the suite says why.",
    );
  } else {
    // Shards run side by side, so the suite took as long as its slowest one; the counts are added.
    const sum = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    let slowest = 0;
    for (const { report } of reports) {
      for (const key of Object.keys(sum)) sum[key] += Number(report.stats[key]) || 0;
      slowest = Math.max(slowest, Number(report.stats.duration) || 0);
    }
    const several = wholeRun || reports.length > 1;
    lines.push(
      ...(note ? [escape(note), ""] : []),
      `| Passed | Failed | Flaky | Skipped | ${several ? "Slowest shard" : "Time"} |`,
      "| ---: | ---: | ---: | ---: | ---: |",
      `| ${sum.expected} | ${sum.unexpected} | ${sum.flaky} | ${sum.skipped} | ${duration(slowest)} |`,
    );

    // Which shards reported: each report says which of how many it was, so a shard that left none can be named. A
    // shard's own job holds only its report, so only the job that adds them up says this.
    const total = Math.max(expectedShards, ...reports.map(({ report }) => Number(report.config?.shard?.total) || 0));
    if (wholeRun && total > 0) {
      const seen = new Set(reports.map(shardOf));
      const absent = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !seen.has(n));
      if (absent.length > 0) {
        lines.push("", `Only ${reports.length} of ${total} shards left a report; ${absent.length === 1 ? "shard" : "shards"} ${absent.join(", ")} did not, so those specs are not counted.`);
        broken.push(`${absent.length === 1 ? "a shard" : `${absent.length} shards`} left no report`);
      }
    }
    if (problems.length > 0) {
      broken.push(`${plural(problems.length, "report", "reports")} could not be read`);
      lines.push("", "Reports that could not be read:", "");
      for (const problem of problems) lines.push(`- ${escape(problem)}`);
    }

    // Errors that belong to no single test, such as a web server that never started, explain a run with no tests.
    const errors = [];
    for (const entry of reports) {
      const shard = shardOf(entry);
      for (const error of entry.report.errors ?? []) {
        const message = plain(error.message ?? "").split("\n")[0];
        if (message) errors.push(several && shard ? `shard ${shard}: ${message}` : message);
      }
    }
    if (errors.length > 0) {
      broken.push(plural(errors.length, "error outside the tests", "errors outside the tests"));
      lines.push("", "Errors outside the tests:", "");
      for (const message of errors) lines.push(`- ${escape(message)}`);
    }

    if (sum.unexpected > 0) broken.push(plural(sum.unexpected, "failed test", "failed tests"));
    const failed = reports.flatMap(({ report }) => failing(report));
    if (failed.length > 0) {
      lines.push("", `<details><summary>${plural(failed.length, "failing test", "failing tests")}</summary>`, "");
      for (const entry of failed) lines.push(`- ${escape(entry)}`);
      lines.push("", "</details>");
    }
  }
} catch (error) {
  broken.push("the summary could not be written");
  lines.push(`The summary could not be written: ${escape(plain(error.message))}.`);
}

if (strict && broken.length > 0) lines.push("", `**This fails the run:** ${escape(broken.join("; "))}.`);
const markdown = `${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
else process.stdout.write(markdown);
if (strict && broken.length > 0) {
  // The reason also goes to the log, where a person reading the failed step looks first.
  console.error(`Failing: ${broken.join("; ")}.`);
  process.exitCode = 1;
}
