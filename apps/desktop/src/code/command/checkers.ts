// The checkers, test runners and build tools: which options of each run a program, write a file, load a plugin or send, and how a line for one is read.
// Its own file because it is one family's reading and it holds the deny-lists that the lists of options.ts back.
import { has, hasExactly, RANK, say, sends, thisMac, unknownProgram, v, type Verdict } from "./verdict";
import { KNOWN, knownOptions } from "./options";

/** Checks that only report, and tools that report unless told to fix. */
export const CHECKERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test", "mypy", "pyright", "flake8", "pylint", "shellcheck", "hadolint", "actionlint", "knip", "depcheck", "cspell", "stylelint", "markdownlint", "eslint", "biome", "ruff", "black", "isort", "prettier", "tsc", "vue-tsc", "playwright", "cypress"]);

const FIXES = ["--fix", "--write", "-w", "--apply", "--apply-unsafe", "-u", "--update", "--updateSnapshot", "--update-snapshots"];

/** make's, just's and task's own options that choose how many recipes run at once and how much they say, those of them
 *  that take a value, and the short ones written joined or bundled. */
export const RUNNER_FLAGS: Record<string, ReadonlySet<string>> = {
  make: new Set(["-k", "--keep-going", "-s", "--silent", "--quiet", "-w", "--print-directory", "--no-print-directory", "-B", "--always-make", "-n", "--dry-run", "--just-print", "-q", "--question", "-r", "--no-builtin-rules", "-R", "--no-builtin-variables", "--output-sync"]),
  just: new Set(["-q", "--quiet", "-v", "--verbose", "-n", "--dry-run", "--no-deps", "--timestamp"]),
  task: new Set(["-s", "--silent", "-v", "--verbose", "-p", "--parallel", "-f", "--force", "--dry"]),
};

export const RUNNER_VALUES: Record<string, ReadonlySet<string>> = { make: new Set(["-C", "--directory", "-j", "--jobs", "-l", "--load-average"]), just: new Set(["--color"]), task: new Set(["--concurrency"]) };

export const RUNNER_JOINED: Record<string, RegExp> = { make: /^-([ksBnqrRw]+|j[0-9]*|C.+|O[a-z]*|l[0-9.]*)$/, just: /^-[qvn]+$/, task: /^-[svpf]+$/ };

export const FRAMEWORKS = new Set(["vite", "next", "nuxt", "astro", "remix", "webpack", "rollup", "esbuild", "tsup", "parcel", "turbo", "nx"]);

/** A check's options by their name written any way a runner takes it (`--outputFile`, `--output-file`, `-outputfile`):
 *  letter case, `-` and `_` taken out, and each part of a dotted one (`--coverage.reportsDirectory`) on its own. */
const CHECK_RUNS = new Set([
  "require", "import", "loader", "experimentalloader", "plugin", "plugins", "loadplugins", "inithook", "rulesdir", "setupfiles",
  "setupfilesafterenv", "globalsetup", "globalteardown", "testresultsprocessor", "testrunner", "transform", "resolver",
  "snapshotresolver", "testsequencer", "watchplugins", "exec", "toolexec", "vettool", "overlay", "shellcheck", "pyflakes",
  "customformatter", "customsyntax", "pre", "hostnamebin", "scriptshell", "nodeoptions", "rcfile", "resolvepluginsrelativeto",
  "ldflags", "gccgoflags", "asmflags", "modfile", "overrideini", "basetemp", "preload",
  // options a runner hands to node for its workers (mocha's `--node-option`, ava's `--node-arguments`, vitest's
  // `execArgv`), where `--import` and `--require` load a program as `NODE_OPTIONS` would
  "nodeoption", "nodearguments", "nodeargs", "execargv", "customprovidermodule",
  // a debugger on an address, which runs whatever anyone who reaches it sends (item 120): a backstop for every runner, and
  // for node's own names wherever a runner hands them on
  "inspect", "inspectbrk", "inspectport", "inspectwait", "debugport", "debugbrk",
]);

/** Long options only one runner reads this way (another runner's option of the same name is harmless): vitest's diff
 *  settings, pool and workspace name a module it loads, and its benchmark's JSON is a file it writes. */
const CHECK_LONG: Record<string, Record<string, "runs" | "writes" | "config" | "loads">> = {
  vitest: { diff: "loads", pool: "loads", workspace: "config", outputjson: "writes" },
  jest: { runner: "loads" },
  // words a package manager hands to a script nobody has read may reach either
  "": { diff: "loads", pool: "loads", outputjson: "writes", runner: "loads" },
};

const CHECK_SENDS = new Set(["pastebin"]);

/** Options that name what a runner loads: a name of its own (`--reporter=dot`) is fine, a file is a program. */
const CHECK_LOADS = new Set(["reporter", "reporters", "format", "formatter", "environment", "testenvironment", "ui", "preset", "rules", "sequencer"]);

/** Options that name a settings file, which for most runners is a program: one named as settings is the project's own. */
const CHECK_CONFIG = new Set(["config", "configfile", "configpath"]);

const CHECK_WRITES = new Set([
  "output", "outputfile", "outfile", "outdir", "outputdir", "junitxml", "junit", "html", "resultlog", "reportlog", "coverprofile",
  "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "generatetrace", "generatecpuprofile", "tsbuildinfofile",
  "cachelocation", "cachedir", "coveragedirectory", "reportsdirectory", "targetdir", "logfile", "update", "updatesnapshot",
  "updatesnapshots", "write", "fix", "fuzz", "xunit", "dump",
]);

/** Each runner's short options that load a program, write, or name a settings file. */
const CHECK_SHORT: Record<string, Record<string, "runs" | "writes" | "config" | "loads">> = {
  vitest: { u: "writes", c: "config" },
  jest: { u: "writes", c: "config" },
  mocha: { r: "runs", R: "loads", u: "loads", n: "runs" },
  pytest: { p: "runs", o: "runs", c: "config" },
  "py.test": { p: "runs", o: "runs", c: "config" },
  eslint: { c: "config", f: "loads", o: "writes" },
  playwright: { c: "config", u: "writes" },
  cypress: { C: "config", c: "runs", r: "loads" },
  stylelint: { c: "config", o: "writes" },
  markdownlint: { c: "config", r: "runs", o: "writes" },
  cspell: { c: "config" },
  knip: { c: "config" },
  ruff: { o: "writes" },
  ava: { u: "writes" },
  go: { o: "writes", c: "writes" },
  "": { u: "writes", o: "writes" },
};

/** Runners that read `-name` as a long option, as Go's own flags do. */
const GO_FLAGS = new Set(["go", "actionlint"]);

const looksLikeSettings = (value: string) =>
  /(^|[._-])(config|workspace)([._-]|$)|rc(\.[a-z]+)?$|^\.[a-z0-9_-]*rc|^(pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|ruff\.toml|biome\.jsonc?|t?sconfig.*\.json|jsconfig.*\.json)$/i.test(value.split(/[\\/]/).pop() ?? "");

const namesAFile = (value: string) => /[\\/]/.test(value) || value.startsWith(".") || /\.(c|m)?[jt]sx?$|\.py$/i.test(value);

/** What a check's own options make of it, or null when they leave it a check: an option that loads a program, a settings
 *  file that is not one, a file it writes, or a service it sends to. `runner` names the runner (`""` when the words go to a
 *  script nobody has read, as `pnpm test --…` does), for its short options. */
export function checkOptions(runner: string, args: readonly string[]): Verdict | null {
  const short = CHECK_SHORT[runner] ?? {};
  const go = GO_FLAGS.has(runner);
  let found: Verdict | null = null;
  const take = (r: Verdict) => {
    if (!found || RANK[r.action] > RANK[found.action]) found = r;
  };
  const kind = (k: "runs" | "writes" | "config" | "loads", value: string | undefined) => {
    if (k === "runs") take(unknownProgram(runner || "test"));
    else if (k === "writes") take(v("change", say("kit.say.change")));
    else if (k === "config" && (value === undefined || !looksLikeSettings(value))) take(unknownProgram(runner || "test"));
    else if (k === "loads" && (value === undefined || namesAFile(value))) take(unknownProgram(runner || "test"));
  };
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.startsWith("-") || w === "-" || w === "--") continue;
    const eq = w.indexOf("=");
    const value = eq >= 0 ? w.slice(eq + 1) : args[i + 1];
    if (w.startsWith("--") || go) {
      const parts = w.slice(0, eq >= 0 ? eq : undefined).replace(/^-+/, "").toLowerCase().replace(/[-_]/g, "").split(".");
      for (const n of parts) {
        if (CHECK_SENDS.has(n)) take(sends());
        if (CHECK_RUNS.has(n)) kind("runs", value);
        if (CHECK_WRITES.has(n)) kind("writes", value);
        if (CHECK_CONFIG.has(n)) kind("config", value);
        if (CHECK_LOADS.has(n)) kind("loads", value);
        const own = CHECK_LONG[runner]?.[n];
        if (own) kind(own, value);
        if (go && short[n]) kind(short[n], value);
      }
      continue;
    }
    // short options, alone, bundled or with their value joined: the first that names one of the runner's own ends the word
    for (let j = 1; j < w.length; j++) {
      const k = short[w[j]];
      if (!k) continue;
      kind(k, j + 1 < w.length ? w.slice(j + 1) : args[i + 1]);
      break;
    }
  }
  return found;
}

/** tsc's options that write a file, by name in lower case: tsc takes either letter case, and one dash or two. */
const TSC_WRITES = new Set(["outdir", "outfile", "out", "declarationdir", "tsbuildinfofile", "generatetrace", "generatecpuprofile", "build", "b", "init", "watch", "w"]);

/** The subcommands each checker is read with as a check (item 116): any other (`vitest init`, `ruff clean`, `biome
 *  init`) is not one. A runner with none here takes filters and files after its options. */
const CHECK_SUBS: Record<string, readonly string[]> = {
  ruff: ["check", "format", "version"],
  biome: ["check", "lint", "format", "ci"],
};

export function checker(name: string, words: string[]): Verdict {
  const args = words.slice(1);
  const sub = args.find((w) => !w.startsWith("-"));
  if (CHECK_SUBS[name] && !CHECK_SUBS[name].includes(sub ?? "")) return unknownProgram(name);
  if (name === "vitest" && sub === "init") return unknownProgram(name);
  // the options of its subcommand when it has a list of its own, else the program's
  const key = sub !== undefined && KNOWN[`${name} ${sub}`] ? `${name} ${sub}` : CHECK_SUBS[name] ? `${name} ${sub}` : name;
  const known = knownOptions(key, args);
  if (known === "unknown") return unknownProgram(name);
  const opts = checkOptions(name, args);
  if (opts) return opts;
  const r = checkerOf(name, args);
  return known === "change" && RANK[r.action] < RANK.change ? v("change", say("kit.say.format"), 2) : r;
}

function checkerOf(name: string, args: string[]): Verdict {
  if (name === "playwright") return args[0] === "test" ? v("check", say("kit.say.test")) : args[0] === "install" ? thisMac() : unknownProgram(name);
  if (name === "cypress") return args[0] === "run" ? v("check", say("kit.say.test")) : unknownProgram(name);
  if (name === "tsc" || name === "vue-tsc") {
    // only `--noEmit` keeps tsc from writing, and `--noEmit false` takes it back
    const lower = args.map((w) => w.toLowerCase());
    const noEmit = lower.some((w, i) => (w === "--noemit" || w === "-noemit") && lower[i + 1] !== "false");
    const writes = lower.some((w) => w.startsWith("-") && TSC_WRITES.has(w.replace(/^-+/, "").split("=")[0]));
    return noEmit && !writes ? v("check", say("kit.say.check")) : v("change", say("kit.say.build"), 1);
  }
  if (name === "prettier") return has(args, "--write", "-w") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (name === "black" || name === "isort") return hasExactly(args, "--check", "--check-only", "-c", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 1);
  if (name === "ruff" && args[0] === "format") return hasExactly(args, "--check", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
  if (name === "biome" && args[0] === "format" && !has(args, "--write", "--apply", "--fix")) return v("check", say("kit.say.check"));
  if (has(args, ...FIXES)) return v("change", say("kit.say.format"), 2);
  return ["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test"].includes(name) ? v("check", say("kit.say.test")) : v("check", say("kit.say.check"));
}
