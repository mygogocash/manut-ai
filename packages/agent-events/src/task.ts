/// A task's brief and its attempts, as a thread document carries them. Ported from GoSpark's
/// `Shared/TaskBrief.swift` and `Shared/SparkTaskAttempt.swift`.
///
/// Only the shapes and their decoding are here. The rules that open, close and retry an attempt
/// belong to whatever runs the task, and the events never carry either type: an approval or a
/// question only names the attempt it was asked in (`ApprovalRequest.attemptID`).

import {
  type DecodeContext,
  type ISODate,
  type UUID,
  asUUID,
  compact,
  isObject,
  liveDecodeContext,
  readBool,
  readCase,
  readDate,
  readInt,
  readList,
  readStrictList,
  readString,
  readUUID,
} from "./coding";

export const TASK_BRIEF_OUTCOMES = ["draft", "active", "blocked", "completed", "cancelled"] as const;
export type TaskBriefOutcome = (typeof TASK_BRIEF_OUTCOMES)[number];

export interface TaskCriterion {
  readonly id: UUID;
  /// What counts as done, in the person's words.
  readonly text: string;
  readonly isSatisfied: boolean;
  readonly satisfiedAt?: ISODate;
}

/// An editable task brief. The brief is what the person said, kept apart from what the agent
/// claims: a provider turn ending never completes the task.
export interface TaskBrief {
  readonly id: UUID;
  readonly playbookID: string;
  readonly playbookVersion: number;
  readonly objective: string;
  readonly scope: string;
  readonly criteria: readonly TaskCriterion[];
  readonly outcome: TaskBriefOutcome;
  readonly updatedAt: ISODate;
}

/// A criterion from JSON. Identity is required: a criterion without one is dropped rather than
/// kept as satisfaction no brief can show.
export function decodeTaskCriterion(json: unknown): TaskCriterion | undefined {
  if (!isObject(json)) return undefined;
  const id = readUUID(json, "id");
  if (id === undefined) return undefined;
  return compact({
    id,
    text: readString(json, "text") ?? "",
    isSatisfied: readBool(json, "isSatisfied") ?? false,
    satisfiedAt: readDate(json, "satisfiedAt"),
  });
}

export function decodeTaskBrief(json: unknown, context: DecodeContext = liveDecodeContext): TaskBrief | undefined {
  if (!isObject(json)) return undefined;
  return {
    id: readUUID(json, "id") ?? context.newID(),
    playbookID: readString(json, "playbookID") ?? "",
    playbookVersion: readInt(json, "playbookVersion") ?? 1,
    objective: readString(json, "objective") ?? "",
    scope: readString(json, "scope") ?? "",
    criteria: readList(json, "criteria", decodeTaskCriterion) ?? [],
    outcome: readCase(json, "outcome", TASK_BRIEF_OUTCOMES) ?? "draft",
    updatedAt: readDate(json, "updatedAt") ?? context.now(),
  };
}

/// How an attempt ended. `finished` means the provider ended its turn, which is not the task
/// being done. `interrupted`: the provider's session went away under it, so a call it was
/// making may or may not have done its work. `cancelled`: the person stopped it.
export const ATTEMPT_OUTCOMES = ["running", "finished", "interrupted", "failed", "cancelled"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/// One execution of a task, with the input revision it started from and the attempt it retries.
/// Lineage is immutable: a retry is a new attempt naming its ancestor, never the old one
/// reopened, so what an earlier attempt did stays on record.
export interface SparkTaskAttempt {
  readonly id: UUID;
  readonly taskID: UUID;
  readonly startedAt: ISODate;
  readonly endedAt?: ISODate;
  readonly inputRevision: string;
  /// The attempt this one retries. Absent for a first attempt.
  readonly ancestorID?: UUID;
  readonly outcome: AttemptOutcome;
  /// The turns this attempt ran, oldest first.
  readonly turnIDs: readonly UUID[];
  /// The start checkpoint of the attempt's first turn, once that turn has taken it.
  readonly baseCheckpoint?: string;
}

/// The outcome of an attempt that names none: running until it has an end, finished after.
export function attemptOutcome(endedAt: ISODate | undefined): AttemptOutcome {
  return endedAt === undefined ? "running" : "finished";
}

/// An attempt from JSON. Identity is required: an attempt without one could be nobody's
/// ancestor. A record from before outcomes, or with one this build does not know, reads by the
/// only thing it can say, which is whether it has an end.
export function decodeSparkTaskAttempt(
  json: unknown,
  context: DecodeContext = liveDecodeContext,
): SparkTaskAttempt | undefined {
  if (!isObject(json)) return undefined;
  const id = readUUID(json, "id");
  const taskID = readUUID(json, "taskID");
  if (id === undefined || taskID === undefined) return undefined;
  const endedAt = readDate(json, "endedAt");
  return compact({
    id,
    taskID,
    startedAt: readDate(json, "startedAt") ?? context.now(),
    endedAt,
    inputRevision: readString(json, "inputRevision") ?? "",
    ancestorID: readUUID(json, "ancestorID"),
    outcome: readCase(json, "outcome", ATTEMPT_OUTCOMES) ?? attemptOutcome(endedAt),
    turnIDs: readStrictList(json, "turnIDs", asUUID) ?? [],
    baseCheckpoint: readString(json, "baseCheckpoint"),
  });
}
