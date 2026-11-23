import { bindingBreak } from "./binding";
import type { ApprovalRecord, ApprovalRequest, Running, Standing } from "./types";

/// What a surface knows when it asks where a request stands: the revision it is showing, what
/// the runtime is running now, and the time.
export interface StandingView {
  readonly seenRevision: number;
  readonly running: Running;
  readonly now: number;
}

/// Where the request a person is looking at stands, read without deciding anything.
///
/// This is the same rule `evaluateDecision` refuses by, so a surface never offers buttons that
/// every press would have refused, and never hides buttons that would have worked. The order
/// goes from the most final answer to the least:
///
/// 1. Decided wins over everything, so a second tap hears who decided rather than a reason that
///    arose later, such as the request expiring after it was decided.
/// 2. Withdrawn, then a turn or attempt that is no longer running: the request is gone for good.
/// 3. Expired: nothing about it can be decided any more, whichever revision is shown.
/// 4. Changed: the request still waits, but at a revision the person has not seen yet, so the
///    surface shows the new one.
export function requestStanding(record: ApprovalRecord | undefined, view: StandingView): Standing {
  if (record === undefined) return { state: "superseded", reason: "not_found" };
  if (record.status === "decided") return { state: "decided", reason: "decided", decision: record.decision };
  if (record.status === "withdrawn") return { state: "superseded", reason: "withdrawn" };
  const request = record.request;
  const broken = bindingBreak(request, view.running);
  if (broken !== undefined) return { state: "superseded", reason: broken };
  if (request.expiresAt !== undefined && isExpired(request, view.now)) {
    return { state: "expired", reason: "expired", expiredAt: request.expiresAt };
  }
  if (request.revision !== view.seenRevision) {
    return { state: "changed", reason: "revised", currentRevision: request.revision };
  }
  return { state: "open", reason: "waiting" };
}

/// Whether the request's time is up. `expiresAt` is the first instant it can no longer be
/// decided, so a decision arriving exactly then is already too late.
export function isExpired(request: ApprovalRequest, now: number): boolean {
  return request.expiresAt !== undefined && now >= request.expiresAt;
}
