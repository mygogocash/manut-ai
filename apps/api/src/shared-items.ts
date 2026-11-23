/// Published shared run records (OFC-21, #460, `docs/office-sharing.md`):
/// the text an owner's Mac publishes for one run it picked to share, and the
/// strict check every publish passes before anything is stored.
///
/// The record mirrors the per-run half of `OfficeSharePayload` in
/// `GoGoCode/Models/OfficeShareScope.swift`, field for field, with the names
/// and shapes Swift's encoder writes (UUIDs as strings, dates as ISO 8601):
///
/// | Record field | Swift field |
/// | --- | --- |
/// | `run.id` | `SharedRun.id` (`UUID`) |
/// | `run.state` | `SharedRun.state`, the state in words |
/// | `run.deliverableNames` | `SharedRun.deliverableNames` |
/// | `run.revisionNumbers` | `SharedRun.revisionNumbers` |
/// | `reviews[].revisionID` | `SharedReview.revisionID` (`UUID`) |
/// | `reviews[].revisionNumber` | `SharedReview.revisionNumber` |
/// | `reviews[].outcome` | `SharedReview.outcome` (`OfficeReviewDecision.Outcome` raw value) |
/// | `reviews[].decidedAt` | `SharedReview.decidedAt` (`Date`, ISO 8601) |
/// | `decisions[].instanceID` | `SharedDecision.instanceID` (`UUID`) |
/// | `decisions[].runID` | `SharedDecision.runID` (`UUID?`), required here |
/// | `decisions[].title` | `SharedDecision.title`, already redacted on the Mac |
/// | `brief` | `brief`, absent unless the owner ticked Include the brief |
///
/// The payload's other fields are not part of a run's record: the company
/// name lives on the company, Roles' public summaries are not per run, and
/// comments arrive through their own route. Sending any of them here, or any
/// other key at any level, is refused rather than dropped, so a publisher
/// that starts sending more than the schema learns it at once instead of
/// believing it was stored. That is also how file contents, paths,
/// transcripts, sources and instructions stay out: the schema has no field
/// for them, and a deliverable name that is really a path is refused.
import { isValidSharedItemId } from "./companies";

/// The largest record body accepted, in bytes. Far above what the caps below
/// allow for an ordinary run, and far below the object's generic body bound,
/// so one run's record can never crowd the company's storage.
export const SHARED_RECORD_MAX_BYTES = 64 * 1024;

/// The most runs one company may have published at once. Their ids live in
/// one stored index, read on every list, so the count stays bounded; a share
/// covers runs the owner picked by hand, like `MAX_SHARED_SCOPE`.
export const MAX_SHARED_ITEMS = 1000;

/// Per-field caps. A state is a few words; a deliverable is a file name, and
/// file names stop at 255 on APFS; a decision title is one redacted sentence.
export const SHARED_LIMITS = {
  stateLength: 80,
  deliverableNames: 100,
  deliverableNameLength: 255,
  revisionNumbers: 500,
  reviews: 500,
  decisions: 200,
  titleLength: 500,
  briefLength: 16_000,
} as const;

export type SharedReviewOutcome = "accepted" | "changesRequested";

const REVIEW_OUTCOMES: readonly string[] = ["accepted", "changesRequested"];

/// One run's shared record as published and as read back, holding only the
/// fields in the table above.
export type SharedRunRecord = {
  run: { id: string; state: string; deliverableNames: string[]; revisionNumbers: number[] };
  reviews: { revisionID: string; revisionNumber: number; outcome: SharedReviewOutcome; decidedAt: string }[];
  decisions: { instanceID: string; runID: string; title: string }[];
  brief?: string;
};

/// The record as stored: the published fields plus when it was first
/// published and last replaced, which the server stamps and the Mac never
/// sends.
export type StoredSharedRun = SharedRunRecord & { publishedAt: string; updatedAt: string };

export type SharedRecordCheck =
  | { ok: true; record: SharedRunRecord }
  | { ok: false; error: "unknown_field" | "invalid_shared_record" | "run_id_mismatch"; field: string };

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/// Control characters, which no single-line field may hold.
const CONTROL = /[\u0000-\u001f\u007f]/;
/// Control characters other than tab, line feed and carriage return, which
/// multi-line text (a decision title, the brief) may hold.
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/// Thrown inside the check and turned into its refusal, so each field reads
/// as one line rather than a ladder of early returns.
class Refusal {
  readonly error: "unknown_field" | "invalid_shared_record" | "run_id_mismatch";
  readonly field: string;

  constructor(error: Refusal["error"], field: string) {
    this.error = error;
    this.field = field;
  }
}

function invalid(field: string): never {
  throw new Refusal("invalid_shared_record", field);
}

/// The object at `field`, refusing anything that is not a plain object or
/// that holds a key outside `allowed`.
function objectAt(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field || "record");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Refusal("unknown_field", field ? `${field}.${key.slice(0, 64)}` : key.slice(0, 64));
    }
  }
  return record;
}

function arrayAt(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

/// Text with something in it, within `max` characters, and free of control
/// characters (`multiline` lets tab and line breaks through).
function textAt(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(field);
  if ((multiline ? CONTROL_EXCEPT_LINES : CONTROL).test(value)) invalid(field);
  return value;
}

function uuidAt(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(field);
  return value;
}

function revisionAt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(field);
  return value;
}

/// A deliverable is named, never located: `OfficeDeliverable.fileName` is a
/// name inside the run's folder, so a separator or a dot segment means a path
/// is trying to travel as a name.
function deliverableNameAt(value: unknown, field: string): string {
  const name = textAt(value, field, SHARED_LIMITS.deliverableNameLength);
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") invalid(field);
  return name;
}

function dateAt(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) invalid(field);
  return value;
}

/// Checks one published record for the run at `runId` and rebuilds it from
/// the checked fields alone, so nothing the check did not name is stored.
///
/// Beyond shape and size, two rules keep the record about this run only: the
/// run's id must be the one in the path, and every decision must name this
/// run (a decision without a run, or for another one, belongs to work that
/// was not picked). A review must refer to one of the run's own revision
/// numbers, which is how `OfficeShareScope.build` derives them.
export function checkSharedRecord(body: unknown, runId: string): SharedRecordCheck {
  try {
    if (!isValidSharedItemId(runId)) throw new Refusal("run_id_mismatch", "run.id");
    const top = objectAt(body, "", ["run", "reviews", "decisions", "brief"]);

    const runIn = objectAt(top.run, "run", ["id", "state", "deliverableNames", "revisionNumbers"]);
    const id = uuidAt(runIn.id, "run.id");
    if (id !== runId) throw new Refusal("run_id_mismatch", "run.id");
    const state = textAt(runIn.state, "run.state", SHARED_LIMITS.stateLength);
    const deliverableNames = arrayAt(
      runIn.deliverableNames,
      "run.deliverableNames",
      SHARED_LIMITS.deliverableNames,
    ).map((name, i) => deliverableNameAt(name, `run.deliverableNames.${i}`));
    const revisionNumbers = arrayAt(
      runIn.revisionNumbers,
      "run.revisionNumbers",
      SHARED_LIMITS.revisionNumbers,
    ).map((number, i) => revisionAt(number, `run.revisionNumbers.${i}`));
    if (new Set(revisionNumbers).size !== revisionNumbers.length) invalid("run.revisionNumbers");
    const known = new Set(revisionNumbers);

    // OfficeSharePayload decodes absent lists as empty, so they may be left out.
    const reviews = arrayAt(top.reviews ?? [], "reviews", SHARED_LIMITS.reviews).map((value, i) => {
      const field = `reviews.${i}`;
      const review = objectAt(value, field, ["revisionID", "revisionNumber", "outcome", "decidedAt"]);
      const revisionNumber = revisionAt(review.revisionNumber, `${field}.revisionNumber`);
      if (!known.has(revisionNumber)) invalid(`${field}.revisionNumber`);
      if (typeof review.outcome !== "string" || !REVIEW_OUTCOMES.includes(review.outcome)) {
        invalid(`${field}.outcome`);
      }
      return {
        revisionID: uuidAt(review.revisionID, `${field}.revisionID`),
        revisionNumber,
        outcome: review.outcome as SharedReviewOutcome,
        decidedAt: dateAt(review.decidedAt, `${field}.decidedAt`),
      };
    });

    const decisions = arrayAt(top.decisions ?? [], "decisions", SHARED_LIMITS.decisions).map((value, i) => {
      const field = `decisions.${i}`;
      const decision = objectAt(value, field, ["instanceID", "runID", "title"]);
      const instanceID = uuidAt(decision.instanceID, `${field}.instanceID`);
      if (decision.runID !== id) throw new Refusal("run_id_mismatch", `${field}.runID`);
      return { instanceID, runID: id, title: textAt(decision.title, `${field}.title`, SHARED_LIMITS.titleLength, true) };
    });

    const record: SharedRunRecord = { run: { id, state, deliverableNames, revisionNumbers }, reviews, decisions };
    // Absent and null both mean the owner left Include the brief off.
    if (top.brief !== undefined && top.brief !== null) {
      record.brief = textAt(top.brief, "brief", SHARED_LIMITS.briefLength, true);
    }
    return { ok: true, record };
  } catch (thrown) {
    if (thrown instanceof Refusal) return { ok: false, error: thrown.error, field: thrown.field };
    throw thrown;
  }
}

/// Storage key for one run's record inside its company's object. The index
/// of published run ids sits beside them under `SHARED_INDEX_KEY`, in
/// first-published order.
export function sharedKey(runId: string): string {
  return `shared:${runId}`;
}

export const SHARED_INDEX_KEY = "shared-index";
