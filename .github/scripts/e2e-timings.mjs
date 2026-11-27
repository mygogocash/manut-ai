// Measures how long each desktop Playwright spec file took, from the shards' JSON reports, for the timings file that
// .github/scripts/e2e-shards.mjs balances the shards by (apps/desktop/e2e/timings.json, spec file -> seconds).
//
// A file's time is the sum of every attempt of every test in it, retries included, because that is the time its shard
// spends on it. Files the reports do not measure (a shard that left no report) keep their committed time, and files
// that are no longer in the spec folder are dropped, so the result always describes the files there are.
//
// Usage:
//   node .github/scripts/e2e-timings.mjs <run id> [--repo <owner/name>]
//       The lead: downloads that CI run's shard reports with `gh` and rewrites apps/desktop/e2e/timings.json. Commit the
//       change when the shards have drifted apart (see what it prints, and `node .github/scripts/e2e-shards.mjs --total 9`).
//   node .github/scripts/e2e-timings.mjs --reports <dir> --out <file>
//       CI's all-shards job: the same file, written for the run's `e2e-timings` artifact. Nothing is committed from CI.
// Both take --dir <spec folder> (default apps/desktop/e2e) and --base <timings file> (default timings.json in it).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SPEC_DIR, listSpecFiles, readTimings } from "./e2e-shards.mjs";

/** Every .json file under `dir`: `gh run download` puts each artifact in a folder of its own. */
function reportFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...reportFiles(path));
    else if (entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

/** Seconds per spec file in one report. The top-level suites are the spec files (a test declared in a helper module
 *  still sits under the spec file that calls it), keyed as Playwright names them: relative to the spec folder. */
export function timingsOfReport(report) {
  const out = {};
  for (const top of report?.suites ?? []) {
    if (typeof top?.file !== "string") continue;
    let ms = 0;
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) ms += Number(result.duration) || 0;
      for (const child of suite.suites ?? []) walk(child);
    };
    walk(top);
    out[top.file] = (out[top.file] ?? 0) + ms / 1000;
  }
  return out;
}

/** Seconds per spec file over several reports. A file in two reports (two runs given together) keeps the longer. */
export function timingsOfReports(reports) {
  const out = {};
  for (const report of reports) {
    for (const [file, seconds] of Object.entries(timingsOfReport(report))) out[file] = Math.max(out[file] ?? 0, seconds);
  }
  return out;
}

/** The new timings: measured times, then the committed ones for files not measured, for the files there are only,
 *  rounded to a tenth of a second and sorted by name so a refresh shows as a short diff. */
export function merge(base, measured, files) {
  const there = new Set(files);
  const out = {};
  for (const file of [...there].sort()) {
    const seconds = Object.hasOwn(measured, file) ? measured[file] : base[file];
    if (typeof seconds === "number" && Number.isFinite(seconds)) out[file] = Math.round(seconds * 10) / 10;
  }
  return out;
}

export const format = (timings) => `${JSON.stringify(timings, null, 2)}\n`;

/** Reads every report under `dir`, and names the ones that could not be read. */
function loadReports(dir) {
  const reports = [];
  const problems = [];
  for (const file of reportFiles(dir)) {
    try {
      const report = JSON.parse(readFileSync(file, "utf8"));
      if (!report || typeof report !== "object" || !Array.isArray(report.suites)) throw new Error("it is not a Playwright JSON report");
      reports.push(report);
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }
  return { reports, problems };
}

/** What changed between two timings, for the person who runs this. */
function describe(before, after, measured) {
  const added = Object.keys(after).filter((file) => !Object.hasOwn(before, file));
  const dropped = Object.keys(before).filter((file) => !Object.hasOwn(after, file));
  const kept = Object.keys(after).filter((file) => !Object.hasOwn(measured, file));
  const total = Object.values(after).reduce((sum, s) => sum + s, 0);
  const longest = Object.entries(after).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, s]) => `${file} ${s}s`);
  return [
    `${Object.keys(after).length} spec files, ${Math.round(total)}s in all; the longest: ${longest.join(", ")}.`,
    `${Object.keys(measured).filter((file) => Object.hasOwn(after, file)).length} measured in this run, ${kept.length} kept from before${kept.length ? ` (${kept.slice(0, 5).join(", ")}${kept.length > 5 ? ", ..." : ""})` : ""}, ${added.length} new, ${dropped.length} dropped as no longer there.`,
  ].join("\n");
}

function options(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(reports|out|dir|base|repo)$/.exec(argv[i]);
    if (match) {
      if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
      out[match[1]] = argv[++i];
    } else if (argv[i].startsWith("--")) throw new Error(`unknown option ${argv[i]}`);
    else out.positional.push(argv[i]);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let scratch;
  try {
    const opts = options(process.argv.slice(2));
    const dir = resolve(opts.dir ?? SPEC_DIR);
    const basePath = resolve(opts.base ?? join(dir, "timings.json"));
    let reportsDir = opts.reports;
    let out = opts.out;
    if (!reportsDir) {
      const run = opts.positional[0];
      if (!/^\d+$/.test(run ?? "")) throw new Error("usage: e2e-timings.mjs <run id> [--repo <owner/name>], or --reports <dir> --out <file>");
      scratch = mkdtempSync(join(tmpdir(), "e2e-timings-"));
      // The shards' own reports, not the run's timings artifact, so a run from before that artifact existed works too.
      execFileSync("gh", ["run", "download", run, "--repo", opts.repo ?? "mygogocash/manut-ai", "--pattern", "playwright-results-*", "--dir", scratch], { stdio: ["ignore", "ignore", "inherit"] });
      reportsDir = scratch;
      out ??= basePath;
    }
    if (!out) throw new Error("--reports needs --out");
    if (!statSync(reportsDir).isDirectory()) throw new Error(`${reportsDir} is not a folder`);
    const { reports, problems } = loadReports(reportsDir);
    for (const problem of problems) console.error(`not read: ${problem}`);
    if (reports.length === 0) throw new Error(`no Playwright report in ${reportsDir}`);
    const failed = reports.reduce((sum, report) => sum + (Number(report.stats?.unexpected) || 0), 0);
    if (failed > 0) console.error(`note: ${failed} test${failed === 1 ? "" : "s"} failed in these reports, so some times include a timeout and a retry.`);
    const { timings: before } = readTimings(basePath);
    const measured = timingsOfReports(reports);
    const after = merge(before, measured, listSpecFiles(dir));
    writeFileSync(out, format(after));
    console.error(`wrote ${out}\n${describe(before, after, measured)}`);
  } catch (error) {
    console.error(`e2e-timings: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
