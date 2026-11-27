// The package managers' words: scripts by name, options that take a value, options that are harmless, and the subcommands that run none of the project's scripts.
// Its own file so the lists are read apart from the code that follows a `pnpm`, `npm`, `yarn` or `bun` line (`packageManager`, in classify.ts).
import { live, say, takesWord, v, type Verdict } from "./verdict";

/** A package.json script, a make target or a task, by its name. Known names only: any other may do anything. */
export function script(name: string, head: number): Verdict {
  const n = name.toLowerCase();
  if (/deploy|release|publish|ship|(^|[:._-])prod(uction)?($|[:._-])/.test(n)) return live();
  // A name that only looks says so: "check" anywhere in it ("format:check", "prettier-check"), or "lint" at its end. One
  // that also fixes or writes ("lint:fix") still changes files. A name kept from this rule is read below as a check, or as
  // unknown, which asks every time, so it is never let through as anything freer than what it says.
  const onlyLooks = n.includes("check") || n.endsWith("lint");
  if (/fix|write|format|fmt|prettier/.test(n) && !onlyLooks) return v("change", say("kit.say.format"), head);
  if (/^(test|tests|spec|e2e|coverage|cover)([:._-].*)?$/.test(n) || /[:._-](test|tests|spec|e2e)$/.test(n)) return v("check", say("kit.say.test"));
  if (/^(check|checks|lint|typecheck|type-check|types|tsc|verify|validate|ci)([:._-].*)?$/.test(n) || /[:._-](check|lint|typecheck)$/.test(n))
    return v("check", say("kit.say.check"));
  if (/^(build|compile|bundle|generate|gen|codegen|prepare)([:._-].*)?$/.test(n)) return v("change", say("kit.say.build"), head);
  if (/^(dev|start|serve|preview|watch|storybook)([:._-].*)?$/.test(n)) return v("change", say("kit.say.run"), head);
  return v("unknown", say("kit.say.script", { name }));
}

export const PM_VALUE = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd", "--reporter", "--loglevel", "--workspace-dir", "--depth", "--audit-level", "--workspace-concurrency", "--resume-from", "--test-pattern", "--omit", "--include", "--tag"]);

/** A package manager's own options that choose where and how it works and nothing more. Any other may set what it runs
 *  every script with (`--script-shell`, `--node-options`, `--config.script-shell`, `--userconfig`, a settings file): so a
 *  command with one is not read in advance. pnpm, yarn and bun hand the words after a script's name to the script; npm reads
 *  every option before `--` as its own. */
const PM_FLAGS = new Set([
  "-r", "--recursive", "-w", "--workspace-root", "--silent", "-s", "--if-present", "--parallel", "--stream", "--no-bail", "--bail",
  "--aggregate-output", "--sequential", "--frozen-lockfile", "--no-frozen-lockfile", "--prefer-frozen-lockfile", "--prefer-offline", "--offline",
  "--prod", "--production", "-P", "--dev", "-D", "--save-dev", "-E", "--save-exact", "--exact", "-O", "--save-optional", "--save-peer",
  "--save-prod", "--no-optional", "--optional", "--peer", "--ignore-scripts", "-y", "--yes", "--json", "--long", "--version", "-v", "-h",
  "--help", "--color", "--no-color", "-q", "--quiet", "--verbose", "--workspaces", "--include-workspace-root", "--fix", "--latest", "-L",
  "--no-save", "--save", "-S", "--legacy-peer-deps", "--lockfile-only", "--fix-lockfile", "--strict-peer-dependencies", "--no-lockfile",
  "--pure-lockfile", "--immutable", "--non-interactive", "--no-audit", "--no-fund", "--no-package-lock", "--no-progress", "--reverse",
  "--fail-if-no-match", "--report-summary", "--interactive", "-i", "--dry-run",
]);

/** The first of a package manager's own options that is not one it is read with, or null. */
export function strangePmOption(words: string[], from: number, to: number): string | null {
  for (let i = from; i < to; i++) {
    const w = words[i];
    if (w === "--") break;
    if (!w.startsWith("-") || w === "-") continue;
    if (PM_FLAGS.has(w)) continue;
    if (PM_VALUE.has(w.split("=")[0])) {
      if (!w.includes("=") && takesWord(words[i + 1])) i++;
      continue;
    }
    return w;
  }
  return null;
}

/** A package named by where it is fetched from rather than by its name, or a registry the agent chose: asking it reaches a
 *  computer the words name, and the address can carry anything out. */
export const PKG_ADDRESS = /:\/\/|^(git\+|git@|github:|gitlab:|bitbucket:|gist:|file:)|@(git\+|https?:|file:|github:|git@)/;

/** A package manager's own subcommands: none of them runs a script of the project's by its name. */
export const PM_OWN = new Set([
  "add", "install", "i", "in", "ci", "remove", "rm", "uninstall", "un", "unlink", "update", "up", "upgrade", "dedupe", "prune", "audit", "dlx",
  "exec", "x", "publish", "deploy", "pack", "config", "ls", "list", "why", "outdated", "view", "info", "show", "root", "bin", "help", "doctor",
  "explain", "licenses", "create", "init", "link", "global", "store", "env", "setup", "import", "patch", "rebuild", "fetch", "server", "pkg",
]);
