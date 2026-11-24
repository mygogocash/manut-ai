import type { ApprovalKind } from "@manut/approval-core";
import type { Connection } from "./connection";
import { decide, type Decision, type Refusal } from "./decide";
import { DEFAULT_ROSTER, type Roster } from "./roster";

/// How much Kit, the coding engineer, does alone in one project: the dial on the design canvas's StatesCodeDev
/// board ("How much Kit does alone"). It is the rest of the team's dial in the words a developer expects, so it sits
/// on top of `decide` rather than beside it: practice, a missing project and the roster are decided there first, and
/// the dial only lets steps inside the project go without asking. Lowest first.
export const KIT_LEVELS = ["asks_every_time", "edits_alone", "edits_and_safe_commands", "everything_in_project"] as const;
export type KitLevel = (typeof KIT_LEVELS)[number];

/// A project starts at the lowest level, as the team's dial starts each new hire at its most careful stop.
export const DEFAULT_KIT_LEVEL: KitLevel = "asks_every_time";

/// What one step of Kit's work does, from what changes nothing to what customers can see.
///
/// - `read`: reads or lists files.
/// - `check`: runs the project's own checks (tests, type checks, a linter that only reports). Nothing is kept.
/// - `edit`: changes a file's text inside the project.
/// - `change`: a command that changes the project and that rewinding the turn takes back (formatting, a build, a
///   commit on Kit's own branch, a new folder).
/// - `install`: adds, removes or updates packages.
/// - `delete`: deletes files, branches or history.
/// - `push`: sends Kit's branch to the remote, or opens a pull request.
/// - `live`: anything customers can see (a deploy, a release, a publish, a merge into the main branch).
/// - `unknown`: a command nobody here can read, such as a script of the project's own or one built from others.
export const KIT_ACTIONS = ["read", "check", "edit", "change", "install", "delete", "push", "live", "unknown"] as const;
export type KitAction = (typeof KIT_ACTIONS)[number];

/// One step Kit wants to take, as the desktop read it.
export interface KitStep {
  readonly action: KitAction;
  /// It reads or writes something outside the project and the folders allowed beside it.
  readonly outside: boolean;
  /// It saves or sends a change that holds a key or a password.
  readonly holdsSecret?: boolean;
  /// A rule the developer kept with "Always allow in this project" covers it.
  readonly alwaysAllowed?: boolean;
}

export type KitDecision =
  /// Kit takes the step without asking.
  | { readonly answer: "alone" }
  /// The step waits for an approval of `kind`. `mayAlwaysAllow` says whether the ask may offer "Always allow in this
  /// project" beside Allow once.
  | { readonly answer: "ask"; readonly kind: ApprovalKind; readonly mayAlwaysAllow: boolean }
  /// The step is stopped and shown, and nobody is asked.
  | { readonly answer: "blocked"; readonly reason: "outside_project" }
  | Extract<Decision, { answer: "draft_only" | "not_my_job" | "not_connected" }>
  | { readonly answer: "refused"; readonly reason: Refusal | "unknown_action" };

/// What each level lets Kit do alone, on top of reading and checks, which never ask. Going live and steps nobody can
/// read are in no level, so they ask at every one.
const ALONE: Readonly<Record<KitLevel, ReadonlySet<KitAction>>> = {
  asks_every_time: new Set<KitAction>(),
  edits_alone: new Set<KitAction>(["edit"]),
  edits_and_safe_commands: new Set<KitAction>(["edit", "change"]),
  everything_in_project: new Set<KitAction>(["edit", "change", "install", "delete", "push"]),
};

/// The commands a kept rule may cover. An edit is the dial's to decide, and going live or a command nobody can read is
/// asked about each time.
const ALWAYS: ReadonlySet<KitAction> = new Set<KitAction>(["change", "install", "delete", "push"]);

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<string>(KIT_ACTIONS);
const KNOWN_LEVELS: ReadonlySet<string> = new Set<string>(KIT_LEVELS);

/// The level a saved setting names, or the lowest one when it names none: a broken setting means more caution, never
/// less.
export function kitLevelOf(value: unknown): KitLevel {
  return typeof value === "string" && KNOWN_LEVELS.has(value) ? (value as KitLevel) : DEFAULT_KIT_LEVEL;
}

/// Whether an ask for a step of this kind may offer "Always allow in this project".
export function mayAlwaysAllow(action: KitAction): boolean {
  return ALWAYS.has(action);
}

/// Whether Kit may take `step` alone at `level` in the project `project` is, at `now`.
///
/// Rules no level, rule or data can change: a step outside the project is blocked and shown; going live asks; a step
/// nobody can read asks; a step that saves or sends a key asks; in practice every change is a draft. Reading and
/// checks never ask, because they change nothing.
export function kitDecide(
  step: KitStep,
  level: KitLevel,
  project: Connection | null | undefined,
  now: number,
  roster: Roster = DEFAULT_ROSTER,
): KitDecision {
  if (!KNOWN_ACTIONS.has(step.action)) return { answer: "refused", reason: "unknown_action" };

  const job = decide("kit", "run_command", project, now, roster);
  if (job.answer === "refused" || job.answer === "not_my_job" || job.answer === "not_connected") return job;

  if (step.outside) return { answer: "blocked", reason: "outside_project" };
  if (step.action === "read" || step.action === "check") return { answer: "alone" };
  if (job.answer === "draft_only") return job;

  // Kit's job is a write of kind `command` in the roster. Data that calls it a read makes `decide` answer `allowed`;
  // the dial still asks as a command then, because what a step may do alone is decided here, not by the data.
  const kind: ApprovalKind = job.answer === "ask" ? job.kind : "command";
  const asks = (mayAlways: boolean): KitDecision => ({ answer: "ask", kind, mayAlwaysAllow: mayAlways });

  if (step.action === "live" || step.action === "unknown" || step.holdsSecret) return asks(false);
  if (ALONE[kitLevelOf(level)].has(step.action)) return { answer: "alone" };
  if (step.alwaysAllowed && ALWAYS.has(step.action)) return { answer: "alone" };
  return asks(ALWAYS.has(step.action));
}
