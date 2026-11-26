// Which workflows the person allowed to run (item 91). A workflow file is written by whoever can write in `~/.manut/workflows`:
// the person, another program of theirs, or an agent. So a file runs only once the person has looked at every one of its steps
// on Settings › Workflows and pressed "Allow this workflow to run" for it, and only while it is still exactly what they looked
// at. What is kept for each file is the digest of its exact text then (file.ts `digest`) and its project's real path then.
//
// The record lives with the app's own settings on this computer (`localStorage` `manut.workflows.allowed`, beside
// `manut.workflows`), never in the workflows folder, so nothing that writes a workflow file can write its allowance too. A
// record that cannot be read, or an entry that is not exactly an allowance, allows nothing: the file is "not allowed yet".
import type { Workflow } from "./file";

/** What the person allowed for one file. */
export interface Allowance {
  /** SHA-256 of the file's exact text the person looked at, lowercase hex. */
  digest: string;
  /** The project folder's real path when they allowed it. */
  project: string;
  /** When, in ms. */
  at: number;
}

/** Allowances by file name. */
export type Allowances = Record<string, Allowance>;

export const ALLOW_KEY = "manut.workflows.allowed";
/** At most this many files keep an allowance; the oldest goes first. The folder lists at most 100 files. */
export const ALLOWED_MAX = 200;

/** Where a workflow stands: allowed and unchanged since, never allowed (a new file, a renamed one, one that took over another's
 *  name), or changed since the person allowed it. */
export type Standing = "allowed" | "not_allowed" | "changed";

/** A file name the shell lists (src-tauri/src/workflows.rs `plain_name`). */
const plainFile = (f: string) => f.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(f);
const isDigest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** The saved allowances; anything that is not exactly an allowance is left out, so it allows nothing. */
export function parseAllowances(text: string | null): Allowances {
  const out: Allowances = {};
  let v: unknown;
  try {
    v = text ? JSON.parse(text) : {};
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [file, a] of Object.entries(v as Record<string, unknown>)) {
    if (!plainFile(file) || !a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (!isDigest(o.digest) || typeof o.project !== "string" || !o.project || typeof o.at !== "number" || !Number.isFinite(o.at)) continue;
    out[file] = { digest: o.digest, project: o.project, at: o.at };
  }
  return out;
}

/** Where `wf` stands against `allowed`. */
export function standingOf(wf: Pick<Workflow, "file" | "digest">, allowed: Allowances): Standing {
  const a = Object.hasOwn(allowed, wf.file) ? allowed[wf.file] : undefined;
  if (!a) return "not_allowed";
  return a.digest === wf.digest ? "allowed" : "changed";
}

/** `allowed` held to ALLOWED_MAX, the newest kept. */
export function boundAllowances(allowed: Allowances): Allowances {
  const list = Object.entries(allowed);
  if (list.length <= ALLOWED_MAX) return allowed;
  return Object.fromEntries(list.sort((a, b) => b[1].at - a[1].at).slice(0, ALLOWED_MAX));
}

export function readAllowances(): Allowances {
  try {
    return parseAllowances(typeof localStorage === "undefined" ? null : localStorage.getItem(ALLOW_KEY));
  } catch {
    return {};
  }
}

/** Saves `allowed`. With no storage nothing is kept, so nothing is allowed after the app restarts: it fails closed. */
export function saveAllowances(allowed: Allowances): void {
  try {
    localStorage.setItem(ALLOW_KEY, JSON.stringify(boundAllowances(allowed)));
  } catch {
    /* no storage */
  }
}
