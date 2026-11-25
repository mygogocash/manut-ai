// The preview of a lane (docs/code-editor.md, "The preview of a lane"; the design canvas's Code board, Preview): the project
// started with its own dev server in the lane's own folder, so the developer sees what Kit made in their own browser. This file is
// what is decided, as pure functions with no page and no clock of their own: which command starts it (from the folder's
// package.json, by `@manut/preview-command`, which never chooses a script that looks like it publishes), which secrets it runs
// with and what each is set to (`previewEnv` for the names Kit's changes read, `sampleEnv` for the ones the folder's
// `.env.example` names), and what each thing the shell says of a running preview makes of it: Starting, Running at, Stopped,
// Ended, Could not start. The shell runs it (src-tauri/src/preview.rs), previewStore.ts keeps each lane's, and LanePane.tsx
// draws it.
import { findDevUrl, withoutEscapes } from "@manut/dev-url";
import { readEnvExample, sampleEnv } from "@manut/env-example";
import { previewCommand, type NoneWhy } from "@manut/preview-command";
import type { Key } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { kindOf, previewEnv, type Need } from "./preview";

/** What a lane's folder holds for choosing the command (the shell's `preview_read`): its package.json (null: it has none; empty:
 *  one the shell could not read, which reads as unreadable), the names at its root, and its `.env.example` (null: none). */
export interface PreviewProject {
  packageJson: string | null;
  files: string[];
  envExample: string | null;
}

/** The shell's answer as a `PreviewProject`, or null when it is not one. */
export function readProject(raw: unknown): PreviewProject | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  if (!Array.isArray(r.files)) return null;
  return { packageJson: text(r.packageJson), files: r.files.filter((f): f is string => typeof f === "string"), envExample: text(r.envExample) };
}

/** The command that starts the preview, as the shell runs it (`argv`) and as the view names it (`label`), or why there is none. */
export type PreviewPlan = { argv: string[]; label: string } | { none: NoneWhy };

export function planOf(project: PreviewProject): PreviewPlan {
  const c = previewCommand({ packageJson: project.packageJson, files: project.files });
  if ("none" in c) return { none: c.none };
  return { argv: [...c.argv], label: c.argv.join(" ") };
}

// ---- what it runs with ------------------------------------------------------------------------------------------

/** The names a preview runs with the shell's own values, never a secret's: what a dev server needs to run, and the loader's
 *  (src-tauri/src/preview.rs `reserved`, which refuses a start that names one). */
export function reservedName(name: string): boolean {
  return ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH", "TERM"].includes(name) || /^LC_[A-Z_]+$/.test(name) || name.startsWith("DYLD_") || name.startsWith("LD_");
}

/** A variable's name as the shell takes one. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The secrets a preview runs with, as name and value, in name order. Each variable the folder's `.env.example` marks as a
 *  secret (`readEnvExample`'s own rule) gets `sampleEnv`'s plainly fake value. Then every name that says what kind of secret it
 *  is, each one Kit's changes read (`needs`) and each one `.env.example` names (`kindOf`), goes through `previewEnv`, the one
 *  rule: a sample, unless the owner added that very secret. So a shop ID is all zeros wherever it was found, though its line in
 *  `.env.example` wrote a real-looking one, and an added secret is real. Never a value from this computer's environment, never a
 *  value written in `.env.example`. A name the shell keeps for itself is left out (`reservedName`). The shell sets each one
 *  explicitly, so it wins over a `.env` file the project's framework loads. */
export function previewSecrets(needs: readonly Need[], envExample: string | null, added: Readonly<Record<string, string>> = {}): [string, string][] {
  const env = new Map<string, string>();
  const example = envExample ? readEnvExample(envExample).vars : [];
  for (const [name, value] of Object.entries(sampleEnv(example.filter((v) => v.secret)))) env.set(name, value);
  const known = new Map<string, Need>(needs.map((n) => [n.name, n]));
  for (const v of example) {
    const kind = kindOf(v.name);
    if (kind && !known.has(v.name)) known.set(v.name, { name: v.name, kind });
  }
  for (const slot of previewEnv([...known.values()], added)) env.set(slot.name, slot.value);
  return [...env.entries()].filter(([name]) => NAME.test(name) && !reservedName(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---- a run ------------------------------------------------------------------------------------------------------

/** How long a preview may take to print its address before the view stops saying it is starting (it runs on: a first build
 *  can take longer, and an address printed later is still read). */
export const START_WAIT_MS = 60_000;
/** How many of its last lines a run keeps, in memory only. */
export const TAIL = 200;
/** How many of them the view shows when it ended or printed no address. */
export const SHOWN = 6;

export type PreviewPhase =
  /** Nothing runs. */
  | "idle"
  /** Start was pressed: the shell is starting it, or it runs and has not printed its address yet. */
  | "starting"
  /** It printed its address. */
  | "running"
  /** It runs, but printed no address the app can open in its first minute. */
  | "quiet"
  /** Stop was pressed, and it has not ended yet. */
  | "stopping"
  /** It ended because it was stopped: Stop, its session closing, a reload, the app quitting. */
  | "stopped"
  /** It ended by itself. */
  | "ended"
  /** The shell would not start it. */
  | "failed";

export interface PreviewRun {
  phase: PreviewPhase;
  /** The shell's id for it, while it runs. */
  id: number | null;
  /** The command it runs (`pnpm run dev`). */
  label: string;
  /** Its address, once it printed one. */
  url: string | null;
  /** Its exit code, once it ended by itself (null: a signal ended it). */
  code: number | null;
  /** Why it could not start: the shell's word. */
  why: string | null;
  /** Its last lines, as a person reads them (a terminal's escapes taken out), at most `TAIL`. */
  lines: string[];
  /** When Start was pressed (ms). */
  since: number;
}

export const NOT_STARTED: PreviewRun = Object.freeze({ phase: "idle", id: null, label: "", url: null, code: null, why: null, lines: [], since: 0 }) as PreviewRun;

/** Whether something of it runs, or may: Start is not offered then. */
export const isLive = (run: PreviewRun): boolean => run.phase === "starting" || run.phase === "running" || run.phase === "quiet" || run.phase === "stopping";

/** Start was pressed for `label` at `now`. */
export const startingRun = (label: string, now: number): PreviewRun => ({ ...NOT_STARTED, phase: "starting", label, since: now });

/** The shell started it as `id`. A Stop pressed before its answer came (`stopping`) still holds. */
export const startedRun = (run: PreviewRun, id: number): PreviewRun => (isLive(run) ? { ...run, id } : run);

/** The shell would not start it, and why. */
export const refusedRun = (run: PreviewRun, why: string): PreviewRun => ({ ...run, phase: "failed", id: null, why });

/** It printed `lines`. They are kept as a person reads them, the last `TAIL` of them; while it is starting (or quiet) the first
 *  address of this computer among them (`findDevUrl`) is where it runs. Nothing is taken after it ended. */
export function linesRun(run: PreviewRun, lines: readonly string[]): PreviewRun {
  if (!isLive(run) || lines.length === 0) return run;
  const kept = [...run.lines, ...lines.map(withoutEscapes)].slice(-TAIL);
  const found = run.url === null && (run.phase === "starting" || run.phase === "quiet") ? findDevUrl(lines) : null;
  return found ? { ...run, lines: kept, url: found.url, phase: "running" } : { ...run, lines: kept };
}

/** Stop was pressed. */
export const stoppingRun = (run: PreviewRun): PreviewRun => (isLive(run) ? { ...run, phase: "stopping" } : run);

/** It ended: stopped when the shell ended it or Stop was pressed, else by itself with `code`. */
export function exitRun(run: PreviewRun, code: number | null, stopped: boolean): PreviewRun {
  if (!isLive(run)) return run;
  if (stopped || run.phase === "stopping") return { ...run, phase: "stopped", id: null, code: null };
  return { ...run, phase: "ended", id: null, code };
}

/** At `now`: a preview that runs and printed no address within `wait` of its Start is no longer said to be starting. */
export function waitedRun(run: PreviewRun, now: number, wait: number = START_WAIT_MS): PreviewRun {
  return run.phase === "starting" && run.id !== null && now - run.since >= wait ? { ...run, phase: "quiet" } : run;
}

/** The last lines the view shows, each with any key hidden by the app's one masker: a dev server can print anything. */
export const lastLines = (run: PreviewRun, n: number = SHOWN): string[] => run.lines.slice(-n).map((l) => maskSecrets(l));

// ---- the words for why ------------------------------------------------------------------------------------------

/** Why there is no command, in words. */
export const NONE_WORDS: Readonly<Record<NoneWhy, Key>> = {
  no_package_json: "lane.preview.none.no_package_json",
  unreadable: "lane.preview.none.unreadable",
  no_script: "lane.preview.none.no_script",
  refused: "lane.preview.none.refused",
};

/** The words for why the shell would not start or read it: the shell's codes have words of their own, and anything else is the
 *  system's own words, keys hidden and cut short. */
export function whyWords(why: string): { key: Key; vars?: Record<string, string> } {
  const codes: Record<string, Key> = {
    not_a_lane: "lane.preview.why.not_a_lane",
    bad_command: "lane.preview.why.bad_command",
    bad_env: "lane.preview.why.bad_env",
    changed: "lane.preview.why.changed",
    running: "lane.preview.why.running",
    unsupported: "lane.preview.why.unsupported",
  };
  if (Object.prototype.hasOwnProperty.call(codes, why)) return { key: codes[why] };
  const missing = /^missing:(pnpm|yarn|bun|npm)$/.exec(why);
  if (missing) return { key: "lane.preview.why.missing", vars: { manager: missing[1] } };
  const words = [...maskSecrets(why.replace(/\s+/g, " ").trim())];
  return { key: "lane.preview.why.other", vars: { words: words.length > 160 ? `${words.slice(0, 159).join("")}…` : words.join("") } };
}
