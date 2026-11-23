/// A thread as GoSpark saves it: `threads/<uuid>.json`. Ported from `ThreadDocument` in
/// GoSpark's `Shared/Timeline.swift`, so a thread written by GoSpark can be read here.
///
/// A thread file that will not decode takes the whole conversation with it, so every field
/// tolerates a missing or wrong-typed value and one unreadable row costs only itself.
/// `compareMarks` is not read: it records GoSpark's two-model compare, which no event carries.

import {
  type DecodeContext,
  type ISODate,
  type UUID,
  compact,
  isObject,
  liveDecodeContext,
  readDate,
  readList,
  readString,
  readUUID,
  readValue,
} from "./coding";
import { type SparkTaskAttempt, type TaskBrief, decodeSparkTaskAttempt, decodeTaskBrief } from "./task";
import {
  type Attachment,
  type ContextUsage,
  type MessageSource,
  type TimelineItem,
  type TurnRecord,
  decodeAttachment,
  decodeContextUsage,
  decodeMessageSource,
  decodeTimelineItem,
  decodeTurnRecord,
  encodeTimelineItem,
} from "./timeline";

/// One queued follow-up prompt, sent as its own message once the running turn finishes. The
/// queue is the client's own, so it can be reordered, edited or dropped; no event reports it.
export interface FollowUpPrompt {
  readonly id: UUID;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly createdAt: ISODate;
  /// GoSpark's Design Mode capture, carried unread.
  readonly design?: unknown;
  readonly source: MessageSource;
}

export function decodeFollowUpPrompt(
  json: unknown,
  context: DecodeContext = liveDecodeContext,
): FollowUpPrompt | undefined {
  if (!isObject(json)) return undefined;
  const design = readValue(json, "design");
  return compact({
    id: readUUID(json, "id") ?? context.newID(),
    text: readString(json, "text") ?? "",
    attachments: readList(json, "attachments", decodeAttachment) ?? [],
    createdAt: readDate(json, "createdAt") ?? context.now(),
    design: isObject(design) ? design : undefined,
    source: decodeMessageSource(readValue(json, "source")),
  });
}

export interface ThreadDocument {
  readonly threadID: UUID;
  readonly items: readonly TimelineItem[];
  readonly turns: readonly TurnRecord[];
  readonly usage?: ContextUsage;
  readonly followUps: readonly FollowUpPrompt[];
  /// A cross-provider handover waiting for the next send.
  readonly pendingHandoff?: string;
  /// History for an imported thread, used only if its provider cannot reload its own session.
  readonly resumeFallbackHandoff?: string;
  /// The thread's editable task brief, if the person attached one.
  readonly taskBrief?: TaskBrief;
  /// The task's attempts on this thread, oldest first. Empty for a chat with no brief.
  readonly attempts: readonly SparkTaskAttempt[];
}

/// A thread document from parsed JSON. `undefined` only when the value is not an object, which
/// is what a truncated file parses to (`parseJSON`).
///
/// A missing or corrupt `threadID` takes a fresh id rather than costing the history. GoSpark's
/// file name is the real identity, so the caller that knows it corrects the id straight after.
export function decodeThreadDocument(
  json: unknown,
  context: DecodeContext = liveDecodeContext,
): ThreadDocument | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    threadID: readUUID(json, "threadID") ?? context.newID(),
    items: readList(json, "items", (item) => decodeTimelineItem(item, context)) ?? [],
    turns: readList(json, "turns", (turn) => decodeTurnRecord(turn, context)) ?? [],
    usage: decodeContextUsage(readValue(json, "usage")),
    followUps: readList(json, "followUps", (prompt) => decodeFollowUpPrompt(prompt, context)) ?? [],
    pendingHandoff: readString(json, "pendingHandoff"),
    resumeFallbackHandoff: readString(json, "resumeFallbackHandoff"),
    taskBrief: decodeTaskBrief(readValue(json, "taskBrief"), context),
    attempts: readList(json, "attempts", (attempt) => decodeSparkTaskAttempt(attempt, context)) ?? [],
  });
}

/// The document as GoSpark writes it, ready for `JSON.stringify`. Only the rows need
/// translating; every other value already has GoSpark's keys.
export function encodeThreadDocument(document: ThreadDocument): unknown {
  return { ...document, items: document.items.map(encodeTimelineItem) };
}
