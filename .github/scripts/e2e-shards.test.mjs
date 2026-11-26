// Tests for e2e-shards.mjs, run by `node --test` (the root `pnpm test` does, and CI's first job on every run). A wrong
// split would leave a spec file out of every shard, and nobody would see a test that never ran, so the promises are
// pinned: the same shards for the same inputs, every file in exactly one shard, a new file still runs, and ci.yml calls
// the script the way it expects.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SPEC_DIR, assign, filterFor, listSpecFiles, median, readTimings } from "./e2e-shards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "e2e-shards.mjs");
const scratch = mkdtempSync(join(tmpdir(), "e2e-shards-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A small, fixed pseudo-random sequence, so the "many inputs" tests are the same on every run. */
function random(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

/** A spec folder holding these files (each with one line), with a timings file when one is given. */
function folder(name, files, timings) {
  const dir = join(scratch, name);
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "// a spec\n");
  }
  mkdirSync(dir, { recursive: true });
  if (timings !== undefined) writeFileSync(join(dir, "timings.json"), typeof timings === "string" ? timings : JSON.stringify(timings));
  return dir;
}

const flat = (shards) => shards.flatMap((shard) => shard.files);

describe("the split", () => {
  it("gives the same shards every time for the same files and timings, whatever order the files come in", () => {
    const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts", "e.spec.ts", "f.spec.ts"];
    const timings = { "a.spec.ts": 10, "b.spec.ts": 10, "c.spec.ts": 30, "d.spec.ts": 5, "e.spec.ts": 10, "f.spec.ts": 1 };
    const once = assign(files, timings, 3);
    assert.deepEqual(assign([...files].reverse(), timings, 3), once);
    assert.deepEqual(assign(files, { ...timings }, 3), once);
    // Longest first, each to the shard with the least time so far, ties to the lower shard and to the earlier name.
    assert.deepEqual(once.shards.map((shard) => shard.files), [["c.spec.ts"], ["a.spec.ts", "e.spec.ts"], ["b.spec.ts", "d.spec.ts", "f.spec.ts"]]);
    assert.deepEqual(once.shards.map((shard) => shard.seconds), [30, 20, 16]);
  });

  it("puts every file in exactly one shard, for many folders and shard counts", () => {
    const next = random(7);
    for (let round = 0; round < 40; round++) {
      const files = Array.from({ length: 1 + Math.floor(next() * 60) }, (_, i) => `spec-${i}.spec.ts`);
      const timings = Object.fromEntries(files.filter(() => next() < 0.8).map((file) => [file, Math.round(next() * 500) / 10]));
      for (const total of [1, 2, 3, 6, 8, 10]) {
        const { shards } = assign(files, timings, total);
        assert.equal(shards.length, total);
        assert.deepEqual(flat(shards).sort(), [...files].sort(), `round ${round}, ${total} shards`);
        for (const shard of shards) {
          const sum = shard.files.reduce((s, file) => s + (Object.hasOwn(timings, file) ? timings[file] : median(Object.values(timings))), 0);
          assert.ok(Math.abs(sum - shard.seconds) < 1e-9);
        }
      }
    }
  });

  it("keeps the longest shard within one file of the average, and a file longer than the average alone", () => {
    // As on 26 Nov 2026: one file of nearly eight minutes, and many of under half a minute.
    const timings = { "long.spec.ts": 474, ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}.spec.ts`, 10 + (i % 7) * 2])) };
    const { shards } = assign(Object.keys(timings), timings, 8);
    assert.equal(Math.max(...shards.map((shard) => shard.seconds)), 474);
    assert.deepEqual(shards.find((shard) => shard.files.includes("long.spec.ts")).files, ["long.spec.ts"]);
    const rest = shards.filter((shard) => !shard.files.includes("long.spec.ts"));
    const average = rest.reduce((sum, shard) => sum + shard.seconds, 0) / rest.length;
    for (const shard of rest) assert.ok(Math.abs(shard.seconds - average) <= 22, `${shard.seconds} against ${average}`);
  });

  it("runs a spec file that has no time yet, counted as the median, and forgets a time whose file is gone", () => {
    const timings = { "a.spec.ts": 1, "b.spec.ts": 3, "c.spec.ts": 100, "gone.spec.ts": 50 };
    const { shards, guessed, fallback } = assign(["a.spec.ts", "b.spec.ts", "c.spec.ts", "new.spec.ts"], timings, 2);
    assert.deepEqual(guessed, ["new.spec.ts"]);
    assert.equal(fallback, 26.5);
    assert.ok(flat(shards).includes("new.spec.ts"));
    assert.ok(!flat(shards).includes("gone.spec.ts"));
    assert.deepEqual(shards.map((shard) => shard.seconds), [100, 30.5]);
  });

  it("splits by name alone when there are no timings, so the shards are still whole and even", () => {
    const files = Array.from({ length: 9 }, (_, i) => `f${i}.spec.ts`);
    const { shards, fallback } = assign(files, {}, 3);
    assert.equal(fallback, 1);
    assert.deepEqual(shards.map((shard) => shard.files.length), [3, 3, 3]);
  });

  it("refuses a shard count that is not a whole number of at least one", () => {
    for (const total of [0, -1, 2.5, Number.NaN]) assert.throws(() => assign(["a.spec.ts"], {}, total), /whole number/);
  });

  it("takes the median of an odd and an even list", () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 1);
  });
});

describe("the spec folder and the timings file", () => {
  it("lists spec files as Playwright's default testMatch does, in sub-folders too, and never node_modules", () => {
    const dir = folder("list", ["b.spec.ts", "a.spec.ts", "sub/c.test.tsx", "d.spec.mjs", "helper.ts", "fixtures/x.json",
      "node_modules/pkg/e.spec.ts", "notes.spec.md", "start.ts"]);
    assert.deepEqual(listSpecFiles(dir), ["a.spec.ts", "b.spec.ts", "d.spec.mjs", "sub/c.test.tsx"]);
  });

  it("uses the usable times of a timings file, and says why when the file cannot be used", () => {
    const good = folder("good", [], { "a.spec.ts": 2.5, "b.spec.ts": "slow", "c.spec.ts": -1, "d.spec.ts": 0 });
    assert.deepEqual(readTimings(join(good, "timings.json")), { timings: { "a.spec.ts": 2.5, "d.spec.ts": 0 } });
    assert.match(readTimings(join(scratch, "none.json")).problem, /is missing/);
    assert.match(readTimings(join(folder("broken", [], "{oops"), "timings.json")).problem, /could not be read/);
    assert.match(readTimings(join(folder("list-shaped", [], "[1, 2]"), "timings.json")).problem, /not an object/);
  });

  it("makes a filter that matches its own file's absolute path and no other", () => {
    const dir = "/work/apps/desktop/e2e";
    const re = new RegExp(filterFor(dir, "term.spec.ts"), "gi");
    const test = (path) => ((re.lastIndex = 0), re.test(path));
    assert.ok(test("/work/apps/desktop/e2e/term.spec.ts"));
    for (const other of ["/work/apps/desktop/e2e/term.spec.tsx", "/work/apps/desktop/e2e/xterm.spec.ts",
      "/work/apps/desktop/e2e/sub/term.spec.ts", "/work/apps/desktop/e2e/termXspec.ts"]) assert.ok(!test(other), other);
    // A name with characters that mean something in a regular expression still matches only itself.
    const odd = new RegExp(filterFor(dir, "a+b (1).spec.ts"), "gi");
    assert.ok(odd.test("/work/apps/desktop/e2e/a+b (1).spec.ts"));
    // Playwright reads an argument of the form /.../flags as a regular expression literal; a filter never has that form.
    assert.doesNotMatch(filterFor(dir, "term.spec.ts"), /^\/(.*)\/([gi]*)$/);
  });
});

describe("the command", () => {
  const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "sub/d.spec.ts", "new.spec.ts"];
  const dir = folder("cli", files, { "a.spec.ts": 40, "b.spec.ts": 30, "c.spec.ts": 20, "sub/d.spec.ts": 10 });
  const run = (...args) => spawnSync(process.execPath, [script, "--dir", dir, ...args], { encoding: "utf8" });

  it("prints each shard's filters, one a line, and every file is in exactly one shard", () => {
    const seen = [];
    for (let k = 1; k <= 3; k++) {
      const out = run("--total", "3", "--shard", String(k));
      assert.equal(out.status, 0, out.stderr);
      const lines = out.stdout.trim().split("\n");
      for (const line of lines) assert.match(line, /^\^\/.*\\\.spec\\\.ts\$$/);
      seen.push(...lines);
      assert.match(out.stderr, new RegExp(`^### Shard ${k} of 3\\n`));
    }
    assert.equal(seen.length, files.length);
    assert.equal(new Set(seen).size, files.length);
    for (const file of files) assert.ok(seen.includes(filterFor(dir, file)), file);
  });

  it("names a file that has no time yet in the summary of the shard that runs it", () => {
    const shardOf = [1, 2, 3].find((k) => run("--total", "3", "--shard", String(k)).stdout.includes("new\\.spec"));
    assert.match(run("--total", "3", "--shard", String(shardOf)).stderr, /1 spec file with no time yet, counted as the median \(25\.0s\): new\.spec\.ts\./);
  });

  it("fails, and prints no filter, for a shard with no file, as Playwright with no filter would run every file", () => {
    const out = run("--total", "6", "--shard", "6");
    assert.equal(out.status, 1);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /shard 6 of 6 has no spec file: there are only 5/);
  });

  it("fails on a shard that is not one of the shards, or a missing count", () => {
    assert.equal(run("--total", "3", "--shard", "4").status, 1);
    assert.equal(run("--total", "3", "--shard", "0").status, 1);
    assert.equal(run("--shard", "1").status, 1);
    assert.equal(run("--total", "3", "--bogus", "1").status, 1);
  });

  it("prints the whole plan when no shard is named", () => {
    const out = execFileSync(process.execPath, [script, "--dir", dir, "--total", "2"], { encoding: "utf8" });
    assert.match(out, /^5 spec files in 2 shards; no shard can be shorter than the longest file, 40s:\n {2}shard 1: /);
  });
});

describe("this repository", () => {
  const ci = readFileSync(join(here, "..", "workflows", "ci.yml"), "utf8");
  const job = (name) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, name);
    const next = ci.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };
  const shards = /\n {8}shard: \[([0-9, ]+)\]\n/.exec(job("e2e"))?.[1].split(",").map(Number);

  it("runs ci.yml's shards as 1 to N, from this script, and adds up exactly N of them", () => {
    assert.ok(shards && shards.length >= 2, "the e2e matrix lists its shards");
    assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
    assert.match(job("e2e"), /node \.github\/scripts\/e2e-shards\.mjs --total \$\{\{ strategy\.job-total \}\} --shard \$\{\{ matrix\.shard \}\}/);
    assert.doesNotMatch(job("e2e"), /--shard=/);
    assert.match(job("e2e-summary"), new RegExp(`playwright-summary\\.mjs .*--shards ${shards.length} `));
  });

  it("has a usable timings file, and puts every spec file there is in exactly one of ci.yml's shards", () => {
    const { timings, problem } = readTimings(join(SPEC_DIR, "timings.json"));
    assert.equal(problem, undefined);
    assert.ok(Object.keys(timings).length > 0);
    const specs = listSpecFiles(SPEC_DIR);
    const { shards: split } = assign(specs, timings, shards.length);
    assert.deepEqual(flat(split).sort(), specs);
    for (const shard of split) assert.ok(shard.files.length > 0);
  });
});
