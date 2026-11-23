// Writes the desktop Playwright suite's result into the CI job summary: how many tests passed, failed, were flaky
// or were skipped, and which ones failed. That job may fail without failing the run while the specs inherited
// from Oh My Hermes are brought up to date, so this summary is where the suite's state gets read.
//
// Usage: node .github/scripts/playwright-summary.mjs <report.json>
// The report is what Playwright's JSON reporter writes. The summary is appended to the file GitHub names in
// GITHUB_STEP_SUMMARY, or printed when run outside Actions. The script never fails the step: a missing or
// unreadable report is itself what the summary then says.
import { appendFileSync, readFileSync } from "node:fs";

const reportPath = process.argv[2];
const lines = ["### Desktop Playwright", ""];

// Test titles and error messages come from people and tools; escaping keeps them from being read as HTML.
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Playwright colours its messages for a terminal; the summary shows them as plain text.
const plain = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");
const duration = (ms) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const { expected, unexpected, flaky, skipped } = report.stats;
  lines.push(
    "This job may fail without failing the run while the inherited specs are brought up to date.",
    "",
    "| Passed | Failed | Flaky | Skipped | Time |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${expected} | ${unexpected} | ${flaky} | ${skipped} | ${duration(report.stats.duration)} |`,
  );

  // Errors that belong to no single test, such as a web server that never started, explain a run with no tests.
  const errors = (report.errors ?? []).map((error) => plain(error.message ?? "").split("\n")[0]).filter(Boolean);
  if (errors.length > 0) {
    lines.push("", "Errors outside the tests:", "");
    for (const message of errors) lines.push(`- ${escape(message)}`);
  }

  // Every test that did not end as expected, under the describe blocks that hold it. The top-level suites are
  // the spec files, so their titles are left out: each line already starts with the file.
  const failed = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      if (!spec.ok) failed.push(`${spec.file}:${spec.line} › ${[...titles, spec.title].join(" › ")}`);
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, []);
  if (failed.length > 0) {
    lines.push("", `<details><summary>${failed.length} failing ${failed.length === 1 ? "test" : "tests"}</summary>`, "");
    for (const entry of failed) lines.push(`- ${escape(entry)}`);
    lines.push("", "</details>");
  }
} catch (error) {
  lines.push(
    `No usable report at \`${escape(reportPath ?? "(no path given)")}\`: ${escape(plain(error.message))}.`,
    "",
    "Playwright stopped before it could write one; the log of the step that ran the suite says why.",
  );
}

const markdown = `${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
else process.stdout.write(markdown);
