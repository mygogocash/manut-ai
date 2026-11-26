// Splits the desktop's Playwright spec files across CI's shards by how long each one took, so the shards finish
// together. Playwright's own `--shard` splits by test count, and a few spec files are far longer than the rest: on 26
// Nov 2026 one shard ran for 17 minutes while another was done in 6, so every run waited on the slowest.
//
// Each spec file goes whole to one shard, because a shard runs one worker against one mock bridge that holds shared
// state (apps/desktop/playwright.config.ts) and a file's tests may depend on running in order. The files are taken
// longest first, and each goes to the shard with the least time so far (ties to the lower shard); a file with the same
// time as another goes by its name. The same files and timings therefore always give the same shards.
//
// A spec file therefore runs after different neighbours whenever the times change, so it must not depend on what ran
// before it on the shared mock bridge: a file that counts notes or asks resets the bridge first (`mock.reset`), and a
// file that leaves an ask open resets it after (26 Nov 2026: disk-chip.spec.ts, placed after clarify-shots.spec.ts,
// counted the interview that file left open).
//
// The times come from apps/desktop/e2e/timings.json (spec file -> seconds), which a CI run writes afresh as its
// `e2e-timings` artifact and the lead commits with .github/scripts/e2e-timings.mjs. The files themselves come from the
// folder, not from that list: a spec file added since the timings were taken counts as the median and still runs, and
// one deleted since is simply not there.
//
// Usage:
//   node .github/scripts/e2e-shards.mjs --total <n> --shard <k>   the Playwright filters of shard k, one a line, on
//                                                                 stdout; what it holds, as Markdown, on stderr
//   node .github/scripts/e2e-shards.mjs --total <n>               every shard's file count and time, to choose n
// Options: --dir <spec folder> (default apps/desktop/e2e), --timings <file> (default timings.json in that folder).
//
// A filter is the file's absolute path as an anchored regular expression: Playwright reads each argument as a regular
// expression against absolute paths, so `e2e/term.spec.ts` alone would also pick `e2e/term.spec.tsx` or a file of the
// same name in a sub-folder.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SPEC_DIR = join(root, "apps", "desktop", "e2e");

/** Playwright's default testMatch, `**\/*.@(spec|test).?(c|m)[jt]s?(x)`, which the desktop's config keeps. */
export const SPEC = /\.(spec|test)\.(c|m)?[jt]sx?$/;

/** Every spec file under `dir`, as a path relative to it with forward slashes, sorted. node_modules is never read, as
 *  Playwright never reads it. */
export function listSpecFiles(dir) {
  const found = [];
  const walk = (sub) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const path = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.isFile() && SPEC.test(entry.name)) found.push(path);
    }
  };
  walk("");
  return found.sort(byName);
}

/** Plain code-unit order, so the result does not depend on the machine's locale. */
function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The timings file's entries that are a usable number of seconds, and what was wrong when the file could not be
 *  used. A missing or broken file is not fatal: every file then counts the same, and the shards are still whole. */
export function readTimings(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { timings: {}, problem: error.code === "ENOENT" ? `${path} is missing` : `${path} could not be read (${error.message})` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { timings: {}, problem: `${path} is not an object of file -> seconds` };
  const timings = {};
  for (const [file, seconds] of Object.entries(raw)) {
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) timings[file] = seconds;
  }
  return { timings };
}

/** The middle value, or the mean of the two middle ones. With nothing timed, every file counts as one second. */
export function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The shards: each a list of files, sorted by name, with the seconds they are expected to take. Every file is in
 * exactly one shard.
 *
 * @param {string[]} files
 * @param {Record<string, number>} timings
 * @param {number} total
 * @returns {{ shards: { files: string[], seconds: number }[], guessed: string[], fallback: number }}
 */
export function assign(files, timings, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`the number of shards must be a whole number of at least 1, not ${total}`);
  const fallback = median(Object.values(timings));
  const unique = [...new Set(files)];
  const guessed = unique.filter((file) => !Object.hasOwn(timings, file)).sort(byName);
  const cost = (file) => (Object.hasOwn(timings, file) ? timings[file] : fallback);
  const order = unique.sort((a, b) => cost(b) - cost(a) || byName(a, b));
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const file of order) {
    let least = 0;
    for (let i = 1; i < total; i++) if (shards[i].seconds < shards[least].seconds) least = i;
    shards[least].files.push(file);
    shards[least].seconds += cost(file);
  }
  for (const shard of shards) shard.files.sort(byName);
  return { shards, guessed, fallback };
}

/** The Playwright argument that picks exactly this one file. */
export function filterFor(dir, file) {
  return `^${resolve(dir, file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

const specFiles = (n) => `${n} spec file${n === 1 ? "" : "s"}`;
const clock = (seconds) => {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Reads `--name value` pairs. */
function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(total|shard|dir|timings)$/.exec(argv[i]);
    if (!match || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    out[match[1]] = argv[++i];
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const opts = options(process.argv.slice(2));
    const total = Number(opts.total);
    const dir = resolve(opts.dir ?? SPEC_DIR);
    const timingsPath = resolve(opts.timings ?? join(dir, "timings.json"));
    const files = listSpecFiles(dir);
    const { timings, problem } = readTimings(timingsPath);
    const { shards, guessed, fallback } = assign(files, timings, total);
    // What a reader should know about the times: the file was unusable, or some files have no time yet.
    const notes = (among) => {
      const untimed = guessed.filter((file) => among.includes(file));
      if (problem) return [`The timings could not be used (${problem}), so every spec file counts the same.`];
      if (untimed.length === 0) return [];
      return [`${specFiles(untimed.length)} with no time yet, counted as the median (${fallback.toFixed(1)}s): ${untimed.join(", ")}.`];
    };
    if (opts.shard === undefined) {
      // The whole plan, for choosing the number of shards.
      console.log(`${specFiles(files.length)} in ${total} shards; no shard can be shorter than the longest file, ${clock(Math.max(0, ...files.map((f) => (Object.hasOwn(timings, f) ? timings[f] : fallback))))}:`);
      shards.forEach((shard, i) => console.log(`  shard ${i + 1}: ${specFiles(shard.files.length)}, about ${clock(shard.seconds)}`));
      for (const note of notes(files)) console.log(note);
    } else {
      const k = Number(opts.shard);
      if (!Number.isInteger(k) || k < 1 || k > total) throw new Error(`shard ${opts.shard} is not one of 1 to ${total}`);
      const shard = shards[k - 1];
      // An empty list would make Playwright run every spec file, so a shard with none fails instead.
      if (shard.files.length === 0) throw new Error(`shard ${k} of ${total} has no spec file: there are only ${files.length}`);
      for (const file of shard.files) console.log(filterFor(dir, file));
      console.error([
        `### Shard ${k} of ${total}`,
        "",
        `${specFiles(shard.files.length)}, about ${clock(shard.seconds)} by the committed timings (the longest shard: about ${clock(Math.max(...shards.map((s) => s.seconds)))}).`,
        ...notes(shard.files).flatMap((note) => ["", note]),
        "",
        "<details><summary>The files</summary>",
        "",
        ...shard.files.map((file) => `- ${file} (${clock(Object.hasOwn(timings, file) ? timings[file] : fallback)})`),
        "",
        "</details>",
        "",
      ].join("\n"));
    }
  } catch (error) {
    console.error(`e2e-shards: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
