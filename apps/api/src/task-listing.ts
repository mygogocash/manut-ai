/// One task as the shop's task list gives it (`GET /v1/tasks`, task-list.ts): what the lists show and no more. Its
/// document and its proposals whole; its runs without their steps, their fencing tokens or the revision they were given,
/// which only their executor uses; the newest draft a member wrote on it; and from its log only the entries the lists read
/// (`listsRead`). The task object builds it from its own storage (`/listing` in task-object.ts), so the rest of the log
/// never leaves the task.
///
/// This module imports only types from task-object.ts, which imports it, so neither loads the other.

import type { ActionProposalJSON, AttemptJSON, DraftJSON, TaskDocJSON, TaskEventJSON } from "./task-object";

/// The most runs one listed task carries, as the export caps them (`MAX_EXPORT_ATTEMPTS` in task-object.ts): claims grow
/// without bound, so a task that was claimed again and again must not swell the page.
export const MAX_LISTED_ATTEMPTS = 200;

/// One run of a task as the list gives it: how it stands and when it must report by.
export type ListedAttempt = Pick<AttemptJSON, "id" | "executorId" | "status" | "outcome" | "reason" | "finishedAt" |
  "deadline" | "leaseUntil">;

/// One task as the list gives it. `events` is the part of its log the lists read (`listsRead`), oldest first, and
/// `drafts` its newest draft, as a list of at most one.
export type ListedTask = {
  task: TaskDocJSON;
  events: TaskEventJSON[];
  actions: ActionProposalJSON[];
  attempts: ListedAttempt[];
  attemptsTruncated: boolean;
  drafts: DraftJSON[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether the lists read this entry of a task's log: the entry that made the task (its time is when the task began),
/// each run's claim (the only order runs have, and when each began), and what a run reported that the lists show, a
/// handoff note (whom it passed the job to) and a spend report (its model, tokens and cost). The desktop and the
/// operator's jobs list (workers.ts `jobOf`) read these and nothing else of the log.
export function listsRead(event: TaskEventJSON): boolean {
  if (event.kind === "created" || /^attempt:claim:/.test(event.via ?? "")) return true;
  return event.kind === "agent" && isRecord(event.event) &&
    (event.event.type === "handoffNote" || event.event.type === "spend");
}

/// A task as the list gives it, from what its object holds: `actions` already read for the asking tenant, `drafts` oldest
/// first as the object keeps them, and `attempts` in the order the object listed them, of which the first
/// `MAX_LISTED_ATTEMPTS` are kept, as the export keeps them.
export function listingOf(parts: { task: TaskDocJSON; events: readonly TaskEventJSON[];
  actions: readonly ActionProposalJSON[]; attempts: readonly AttemptJSON[]; drafts: readonly DraftJSON[] }): ListedTask {
  const newest = parts.drafts.at(-1);
  return {
    task: parts.task,
    events: parts.events.filter(listsRead),
    actions: [...parts.actions],
    attempts: parts.attempts.slice(0, MAX_LISTED_ATTEMPTS).map((attempt) => ({
      id: attempt.id,
      executorId: attempt.executorId,
      status: attempt.status,
      ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
      deadline: attempt.deadline,
      leaseUntil: attempt.leaseUntil,
    })),
    attemptsTruncated: parts.attempts.length > MAX_LISTED_ATTEMPTS,
    drafts: newest ? [newest] : [],
  };
}
