// A workflow file (item 77b), read and checked. A workflow is one JSON file in `~/.manut/workflows/`: a name, the project folder
// it works in, the coding agent, the steps in order (each a message to the agent, plain text) and, optionally, when it runs by
// itself and in which zone. JSON, not T3 Code's TypeScript workflows: a file that is only data runs no code of its own, every
// other file the app keeps is JSON, and the browser reads it with no new parser.
//
//   {
//     "name": "Nightly tests",
//     "project": "/Users/nam/code/shop-site",
//     "agent": "claude",
//     "steps": ["Run the tests and list the ones that fail.", "Fix the failing tests, then run them again."],
//     "schedule": { "kind": "daily", "at": "02:00" },
//     "timeZone": "Asia/Bangkok"
//   }
//
// The schedule is a routine's trigger (`@manut/routine-rules`): every day, chosen days or a day of the month, each at a time,
// checked by that package rather than by a second grammar. Every field is checked, and a file that fails says the first reason
// in plain words; nothing here writes or removes a file (the shell only reads the folder, src-tauri/src/workflows.rs).
//
// Each workflow carries the digest of its file's exact text (item 91). A run starts only while that digest is the one the person
// allowed (allow.ts), so the steps that run are always the ones they looked at: any change to the file, a space included, is a
// file to look at again.
import { createRoutine, type RoutineRefusal, type Trigger } from "@manut/routine-rules";
import { sha256Hex } from "../runtime/http/sha256";

/** The file's format version. A file may leave it out. */
export const WORKFLOW_VERSION = 1;
/** At most this many steps: a workflow is a short list of messages, not a script. */
export const STEPS_MAX = 20;
/** A step's length cap, in characters. */
export const STEP_MAX = 4000;
/** The fields a workflow file may have. Any other is refused by name, so a misspelt `shedule` is not quietly ignored. */
export const FIELDS = ["version", "name", "project", "agent", "steps", "schedule", "timeZone"] as const;

export type ScheduleTrigger = Extract<Trigger, { kind: "daily" | "weekly" | "monthly" }>;

export interface Workflow {
  /** The file's name in the folder, which is the workflow's id. */
  file: string;
  name: string;
  /** The project's folder, absolute. */
  project: string;
  /** The coding agent's id, as Settings › Providers lists it (`claude`, `codex`, ...). */
  agent: string;
  steps: string[];
  /** When it runs by itself; none: only when Run now is pressed. */
  schedule?: ScheduleTrigger;
  /** The zone its time is in; none: this computer's. */
  timeZone?: string;
  /** SHA-256 of the file's exact text, as lowercase hex: what the person allows (allow.ts), and what a run is held to. */
  digest: string;
}

/** Why a file is not a workflow. The shell's own reasons come first (src-tauri/src/workflows.rs). */
export type WorkflowWhy =
  | "link"
  | "too_big"
  | "not_text"
  | "unreadable"
  | "file_name"
  | "json"
  | "shape"
  | "version"
  | "field"
  | "name"
  | "project"
  | "agent"
  | "steps"
  | "step"
  | "schedule"
  | "time"
  | "weekdays"
  | "day"
  | "zone"
  | "duplicate";

/** One file of the folder as the page lists it: a workflow, or why it is not one (`detail`: the field, the step's number or the
 *  other file, as the reason's words need it). */
export type WorkflowFile = { file: string; workflow: Workflow } | { file: string; why: WorkflowWhy; detail?: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An absolute folder path, written plainly: no control characters and no `..` part, so the project named is the one that is read. */
export function plainFolder(p: unknown): p is string {
  if (typeof p !== "string" || p.length > 1024 || /[\u0000-\u001f]/.test(p)) return false;
  if (!(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p))) return false;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  // the disk's top is no project
  if (parts.length === 0 || (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]))) return false;
  return !parts.some((x) => x === ".." || x === ".");
}

const ROUTINE_WHY: Partial<Record<RoutineRefusal, WorkflowWhy>> = {
  invalid_name: "name",
  invalid_trigger: "schedule",
  invalid_time: "time",
  invalid_weekdays: "weekdays",
  invalid_day: "day",
  invalid_time_zone: "zone",
};

/** The first reason routine-rules gives for this name, schedule and zone, as a workflow's reason; null when it takes them. */
function routineWhy(name: string, trigger: unknown, timeZone: string): WorkflowWhy | null {
  const made = createRoutine({ id: "workflow", name, action: "brief", timeZone, trigger: trigger as Trigger });
  return made.ok ? null : (ROUTINE_WHY[made.reason] ?? "schedule");
}

/** Reads file `file`'s text as a workflow, checking every field. */
export function readWorkflow(file: string, text: string): WorkflowFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { file, why: "json" };
  }
  if (!isObject(v)) return { file, why: "shape" };
  const extra = Object.keys(v).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra !== undefined) return { file, why: "field", detail: extra.slice(0, 40) };
  if (v.version !== undefined && v.version !== WORKFLOW_VERSION) return { file, why: "version" };
  const name = typeof v.name === "string" ? v.name.trim() : "";
  // the name's rule is a routine's (1 to 80 characters): asked of the package with a schedule it always takes
  if (!name || routineWhy(name, { kind: "daily", at: "00:00" }, "UTC") === "name") return { file, why: "name" };
  if (!plainFolder(v.project)) return { file, why: "project" };
  if (typeof v.agent !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(v.agent)) return { file, why: "agent" };
  if (!Array.isArray(v.steps) || v.steps.length === 0 || v.steps.length > STEPS_MAX) return { file, why: "steps" };
  const steps: string[] = [];
  for (const [i, s] of v.steps.entries()) {
    const step = typeof s === "string" ? s.trim() : "";
    if (!step || step.length > STEP_MAX) return { file, why: "step", detail: String(i + 1) };
    steps.push(step);
  }
  if (v.timeZone !== undefined && (typeof v.timeZone !== "string" || routineWhy(name, { kind: "daily", at: "00:00" }, v.timeZone) === "zone")) return { file, why: "zone" };
  const workflow: Workflow = { file, name, project: v.project, agent: v.agent, steps, digest: sha256Hex(text) };
  if (typeof v.timeZone === "string") workflow.timeZone = v.timeZone;
  if (v.schedule !== undefined) {
    const s = v.schedule;
    // a workflow runs at a time: a routine's window and stock triggers are not a workflow's
    if (!isObject(s) || (s.kind !== "daily" && s.kind !== "weekly" && s.kind !== "monthly")) return { file, why: "schedule" };
    const why = routineWhy(name, s, workflow.timeZone ?? "UTC");
    if (why) return { file, why };
    workflow.schedule = s as ScheduleTrigger;
  }
  return { file, workflow };
}

/** The shell's reason for a file it did not read, as a workflow's. */
const SHELL_WHY: Record<string, WorkflowWhy> = { link: "link", too_big: "too_big", not_text: "not_text", unreadable: "unreadable", name: "file_name" };

/** Every file the shell listed, read in its order. Two files with the same name are told apart by the first one: the later one is
 *  listed with the reason, so "Run workflow: Nightly tests" always means one file. */
export function readFolder(files: readonly { name: string; text?: string; why?: string }[]): WorkflowFile[] {
  const out: WorkflowFile[] = [];
  const byName = new Map<string, string>();
  for (const f of files) {
    if (f.text === undefined) {
      out.push({ file: f.name, why: SHELL_WHY[f.why ?? ""] ?? "unreadable" });
      continue;
    }
    const read = readWorkflow(f.name, f.text);
    if ("workflow" in read) {
      const key = read.workflow.name.toLocaleLowerCase();
      const first = byName.get(key);
      if (first !== undefined) {
        out.push({ file: f.name, why: "duplicate", detail: first });
        continue;
      }
      byName.set(key, f.name);
    }
    out.push(read);
  }
  return out;
}
