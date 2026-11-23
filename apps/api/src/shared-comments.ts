/// Comments people write on shared work (OFC-21, #460, `docs/office-sharing.md`):
/// the one field a commenter sends, the strict check it passes, and how the
/// company's object keys what it stores.
///
/// A comment is text and nothing else. The commenter cannot say who wrote it
/// or what kind of author they are: the object stamps `authorKind` and
/// `memberId` from the verified session, so a body that names an author, a
/// mention, an approval or a run is refused rather than trusted. Nothing here
/// starts anything either: a comment is stored beside the run's shared record
/// and never becomes a run, a task, a proposal or an approval (AC5).

/// The longest comment accepted, in characters: a remark on a run, not a
/// document. Counted as JavaScript string length, like the shared record's
/// caps in `shared-items.ts`.
export const COMMENT_TEXT_MAX = 4000;

/// The largest comment body accepted, in bytes. Room for a comment at its
/// cap in any script and its JSON escaping, and far below the object's
/// generic body bound.
export const COMMENT_MAX_BYTES = 32 * 1024;

/// The most comments one shared run may hold. Each run's comments are counted
/// and read in order, so the count stays bounded; past it the run takes no
/// more until a retention rule exists (`docs/office-sharing.md`, Open
/// decisions), because nothing here deletes or expires a comment.
export const MAX_COMMENTS_PER_RUN = 500;

/// Who wrote a comment, in words the Mac shows as **Person** or **AI
/// teammate**. Only people comment through the cloud today: an AI teammate's
/// output review travels in the run's shared record instead, so it can never
/// be read as a person's comment or approval.
export type CommentAuthorKind = "person";

/// One comment as stored and as read back. `memberId` is the commenter's
/// verified tenant id, the same opaque Apple subject that keys the company's
/// member rows and records who decided an approval. It is never a name: who
/// wrote a comment comes from who signed in, not from what the commenter
/// calls themselves.
export type StoredComment = {
  id: string;
  runId: string;
  authorKind: CommentAuthorKind;
  memberId: string;
  text: string;
  createdAt: string;
};

export type CommentCheck =
  | { ok: true; text: string }
  | { ok: false; error: "unknown_field" | "invalid_comment"; field: string };

/// Control characters other than tab, line feed and carriage return: a
/// comment may span lines, but nothing else invisible rides along.
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/// Checks one comment body. It must be an object holding `text` and no other
/// key; any other key is refused by name, so a client that starts sending an
/// author, a mention or an approval learns at once that none of it is stored.
export function checkComment(body: unknown): CommentCheck {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_comment", field: "comment" };
  }
  for (const key of Object.keys(body)) {
    if (key !== "text") return { ok: false, error: "unknown_field", field: key.slice(0, 64) };
  }
  const text = (body as { text?: unknown }).text;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > COMMENT_TEXT_MAX ||
    CONTROL_EXCEPT_LINES.test(text)
  ) {
    return { ok: false, error: "invalid_comment", field: "text" };
  }
  return { ok: true, text };
}

/// Storage key for a run's comment count, which is also the sequence number
/// of its newest comment: comments are never deleted one at a time, so the
/// count and the last number stay the same.
export function commentCountKey(runId: string): string {
  return `comment-count:${runId}`;
}

/// Storage key for a run's `seq`th comment (1-based). Run ids hold no colon
/// (`isValidSharedItemId`), so one run's keys never run into another's, and
/// none of them starts with the `shared:` prefix of the run records.
export function commentKey(runId: string, seq: number): string {
  return `comment:${runId}:${String(seq).padStart(6, "0")}`;
}
