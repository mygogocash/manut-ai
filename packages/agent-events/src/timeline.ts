/// The rows of a thread's timeline and the values they hold. Ported from GoSpark's
/// `Shared/Timeline.swift`.
///
/// Every interface here keeps GoSpark's JSON key names, so a value written with
/// `JSON.stringify` is the JSON GoSpark writes and a GoSpark thread file reads back through the
/// decoders. The one exception is `TimelineItem`: its `content` is a tagged union here, while
/// Swift's synthesized coding writes `{"tool": {"_0": {...}}}`, so `decodeTimelineItem` and
/// `encodeTimelineItem` translate between the two.

import {
  type DecodeContext,
  type ISODate,
  type UUID,
  asInt,
  asString,
  compact,
  fieldsOf,
  isObject,
  liveDecodeContext,
  readBool,
  readCase,
  readCaseOrUnknown,
  readDate,
  readInt,
  readList,
  readNumber,
  readStrictList,
  readString,
  readUUID,
  readValue,
} from "./coding";
import { type ProviderKind, SWITCH_KINDS, type SwitchKind } from "./provider";
import { type ResearchSourceRecord, decodeResearchSourceRecord } from "./research";
import { lastCharacters, utf8Length } from "./text";

// MARK: - Messages

/// Which device a message came from. Without it a message sent from a paired phone is
/// indistinguishable from one typed at the Mac, and the person at the Mac has no way to see that
/// something was sent from a pocket.
export type MessageSource =
  | { readonly type: "mac" }
  | { readonly type: "remote"; readonly deviceName: string };

/// A source this build cannot read is shown as the Mac: attributing a message to a device that
/// may not exist is worse than attributing it to the machine it is on.
export function decodeMessageSource(json: unknown): MessageSource {
  const fields = fieldsOf(json);
  if (readString(fields, "type") === "remote") {
    return { type: "remote", deviceName: readString(fields, "deviceName") ?? "" };
  }
  return { type: "mac" };
}

/// A file a message carries. GoSpark copies it into its library so the message survives the
/// original moving.
export interface Attachment {
  readonly id: UUID;
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
}

/// An attachment from JSON. All four fields are what it is, so one missing any of them is
/// dropped; the message it rode on keeps its other attachments.
export function decodeAttachment(json: unknown): Attachment | undefined {
  if (!isObject(json)) return undefined;
  const id = readUUID(json, "id");
  const name = readString(json, "name");
  const path = readString(json, "path");
  const mimeType = readString(json, "mimeType");
  if (id === undefined || name === undefined || path === undefined || mimeType === undefined) return undefined;
  return { id, name, path, mimeType };
}

export interface UserMessage {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  /// Set when the message is a report from sub-agents rather than the person's own words: the
  /// roster places of the heads reporting back, or empty for a note from the lead itself.
  /// GoSpark writes it as `buddyHeads` and still reads the older `hydraHeads`.
  readonly buddyHeads?: readonly number[];
  /// The note went into a turn that was already running, rather than starting one of its own.
  /// The row says so, so a turn holding two user messages does not read as if the agent answered
  /// two separate prompts.
  readonly wasSteered: boolean;
  /// GoSpark's Design Mode capture, carried unread so a thread read and written back keeps it.
  readonly design?: unknown;
  /// Which device this was sent from.
  readonly source: MessageSource;
}

export function decodeUserMessage(json: unknown): UserMessage | undefined {
  if (!isObject(json)) return undefined;
  const design = readValue(json, "design");
  return compact({
    text: readString(json, "text") ?? "",
    attachments: readList(json, "attachments", decodeAttachment) ?? [],
    buddyHeads: readStrictList(json, "buddyHeads", asInt) ?? readStrictList(json, "hydraHeads", asInt),
    wasSteered: readBool(json, "wasSteered") ?? false,
    design: isObject(design) ? design : undefined,
    source: decodeMessageSource(readValue(json, "source")),
  });
}

/// A message as the person typed it at this machine, with nothing attached.
export function userMessage(text: string): UserMessage {
  return { text, attachments: [], wasSteered: false, source: { type: "mac" } };
}

export interface AssistantMessage {
  readonly text: string;
  readonly isStreaming: boolean;
  /// Whether the chat acted on delegation blocks when this reply's turn ended. Recorded only on
  /// a reply that holds one; absent for a reply saved before this was recorded.
  readonly actedOnDelegationBlocks?: boolean;
  /// The sources a research provider returned with this answer, in its order, landed once.
  /// Absent for every other reply; empty for a research answer that came back with none.
  readonly sources?: readonly ResearchSourceRecord[];
}

export function decodeAssistantMessage(json: unknown): AssistantMessage | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    text: readString(json, "text") ?? "",
    isStreaming: readBool(json, "isStreaming") ?? false,
    actedOnDelegationBlocks: readBool(json, "actedOnDelegationBlocks"),
    // One record that will not read costs that record, not the answer's other sources.
    sources: readList(json, "sources", decodeResearchSourceRecord),
  });
}

export interface ReasoningBlock {
  readonly text: string;
  readonly isStreaming: boolean;
}

export function decodeReasoningBlock(json: unknown): ReasoningBlock | undefined {
  if (!isObject(json)) return undefined;
  return { text: readString(json, "text") ?? "", isStreaming: readBool(json, "isStreaming") ?? false };
}

// MARK: - Tool calls

export const TOOL_CALL_KINDS = ["command", "read", "edit", "search", "web", "mcp", "agent", "other"] as const;
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number] | "unknown";

export const TOOL_CALL_STATUSES = ["running", "completed", "failed", "declined"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number] | "unknown";

/// The most a call's output keeps, in UTF-8 bytes. Past it only the tail is kept.
export const TOOL_OUTPUT_LIMIT = 60_000;

/// The mark that stands in for the output that was dropped, written by code point so no tool
/// can swap it for three full stops.
const ELLIPSIS = String.fromCodePoint(0x2026);

export interface FileEdit {
  readonly path: string;
  readonly diff?: string;
  readonly additions: number;
  readonly deletions: number;
}

export function decodeFileEdit(json: unknown): FileEdit | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    path: readString(json, "path") ?? "",
    diff: readString(json, "diff"),
    additions: readInt(json, "additions") ?? 0,
    deletions: readInt(json, "deletions") ?? 0,
  });
}

export interface ToolCall {
  readonly kind: ToolCallKind;
  readonly title: string;
  readonly detail?: string;
  readonly output: string;
  readonly status: ToolCallStatus;
  readonly exitCode?: number;
  readonly edits: readonly FileEdit[];
  readonly startedAt: ISODate;
  readonly finishedAt?: ISODate;
  /// The client ended the call itself, because a Stop or a quit cut it off before the provider
  /// said how it went. A command can have done all its work by then, so calling it failed would
  /// be a guess. The status stays `failed`: older builds and paired phones have no word for an
  /// unknown outcome and read the call as they always did. This is a flag beside the status
  /// rather than a new status because a status they cannot decode would cost them the whole
  /// history. A call that was never cut off is saved without the key.
  readonly cutOff?: boolean;
}

/// A tool call from JSON. Its kind and status are kept as `"unknown"` when this build cannot
/// name them, where GoSpark's synthesized decoder would lose the row; a call with no status at
/// all is running, which is what a new call starts as.
export function decodeToolCall(json: unknown, context: DecodeContext = liveDecodeContext): ToolCall | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    kind: readCaseOrUnknown(json, "kind", TOOL_CALL_KINDS),
    title: readString(json, "title") ?? "",
    detail: readString(json, "detail"),
    output: readString(json, "output") ?? "",
    status: readCaseOrUnknown(json, "status", TOOL_CALL_STATUSES, "running"),
    exitCode: readInt(json, "exitCode"),
    edits: readList(json, "edits", decodeFileEdit) ?? [],
    startedAt: readDate(json, "startedAt") ?? context.now(),
    finishedAt: readDate(json, "finishedAt"),
    cutOff: readBool(json, "cutOff"),
  });
}

/// A call as it starts: running, with no output and no edits yet.
export function toolCall(start: {
  readonly kind: ToolCallKind;
  readonly title: string;
  readonly startedAt: ISODate;
  readonly detail?: string;
}): ToolCall {
  return { ...start, output: "", status: "running", edits: [] };
}

/// The call was cut off and nothing since has said how it went, so whether it did its work is
/// unknown. A row says so instead of showing a failure.
export function isOutcomeUnknown(call: ToolCall): boolean {
  return call.status === "failed" && call.cutOff === true;
}

function trimmedOutput(output: string): string {
  // Every UTF-16 unit is at most three UTF-8 bytes, so a short output needs no count.
  if (output.length * 3 <= TOOL_OUTPUT_LIMIT || utf8Length(output) <= TOOL_OUTPUT_LIMIT) return output;
  return ELLIPSIS + lastCharacters(output, TOOL_OUTPUT_LIMIT / 2);
}

/// Adds streamed output. Runaway output is capped and stays capped: past the limit only the
/// tail is kept, behind an ellipsis.
export function appendToolOutput(call: ToolCall, text: string): ToolCall {
  return { ...call, output: trimmedOutput(call.output + text) };
}

export function setToolOutput(call: ToolCall, text: string): ToolCall {
  return { ...call, output: trimmedOutput(text) };
}

/// Ends the call as the provider reported. A word from the provider arriving after a cut off is
/// the real outcome, so it clears the cut-off mark. The first ending keeps its time.
export function finishToolCall(call: ToolCall, status: ToolCallStatus, at: ISODate): ToolCall {
  const { cutOff: _cleared, ...rest } = call;
  return { ...rest, status, finishedAt: call.finishedAt ?? at };
}

/// Ends a call that was still running when a Stop or a quit cut it off.
export function cutOffToolCall(call: ToolCall, at: ISODate): ToolCall {
  return { ...finishToolCall(call, "failed", at), cutOff: true };
}

/// Ends a call its turn left running, by how the turn ended: a completed turn completed it, a
/// stopped one cut it off, and a failed one took it down with it. A turn that ended in a way
/// this build cannot name says nothing about the call, so the call is cut off as well: its
/// outcome is unknown, which is exactly what the mark means.
export function finishToolCallEndingTurn(call: ToolCall, turnStatus: TurnStatus, at: ISODate): ToolCall {
  switch (turnStatus) {
    case "completed":
      return finishToolCall(call, "completed", at);
    case "interrupted":
    case "unknown":
      return cutOffToolCall(call, at);
    case "failed":
    case "running":
      return finishToolCall(call, "failed", at);
  }
}

// MARK: - Plans, todos, notices

export const PLAN_STATES = ["drafting", "proposed", "accepted", "dismissed"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export interface ProposedPlan {
  readonly markdown: string;
  readonly state: PlanState;
  /// Which version of the plan this is, from 1. A completion that changes the text of a plan
  /// that has already landed makes it the next revision and proposes it again (`completedPlan`).
  /// Every way of accepting a plan names the revision it showed, so a person only ever accepts
  /// the text they read. A plan saved before revisions decodes as 1.
  readonly revision: number;
}

/// A plan from JSON. A state this build cannot read, or none at all, decodes as dismissed: the
/// row stays, but a build that cannot tell what became of a plan never offers to implement it.
export function decodeProposedPlan(json: unknown): ProposedPlan | undefined {
  if (!isObject(json)) return undefined;
  return {
    markdown: readString(json, "markdown") ?? "",
    state: readCase(json, "state", PLAN_STATES) ?? "dismissed",
    revision: readInt(json, "revision") ?? 1,
  };
}

/// The plan once a completion of it arrives with `markdown`, its text already cleaned
/// (`PlanRevisionRule.completed`).
///
/// After a plan's first completion, one with different, non-empty text is the next revision and
/// is proposed again, even when the last revision was accepted or dismissed: what changed needs
/// its own approval. The same text again moves nothing, so a dismissed plan sent again stays
/// dismissed and cannot be implemented. The first completion of a plan that streamed in is that
/// plan arriving, not a revision of it, even when a row appended mid-stream had already
/// proposed it: it takes the final text at the same revision and keeps whatever the person did
/// with it meanwhile. A plan still drafting is proposed either way.
export function completedPlan(plan: ProposedPlan, markdown: string, firstStreamedCompletion: boolean): ProposedPlan {
  const changed = markdown.length > 0 && markdown !== plan.markdown;
  const text = changed ? markdown : plan.markdown;
  if (changed && !firstStreamedCompletion) return { markdown: text, state: "proposed", revision: plan.revision + 1 };
  return { markdown: text, state: plan.state === "drafting" ? "proposed" : plan.state, revision: plan.revision };
}

export const TODO_STATUSES = ["pending", "active", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number] | "unknown";

export interface TodoStep {
  readonly text: string;
  readonly status: TodoStatus;
}

export function decodeTodoStep(json: unknown): TodoStep | undefined {
  if (!isObject(json)) return undefined;
  return { text: readString(json, "text") ?? "", status: readCaseOrUnknown(json, "status", TODO_STATUSES) };
}

export const NOTICE_LEVELS = ["info", "warning", "error"] as const;
export type NoticeLevel = (typeof NOTICE_LEVELS)[number] | "unknown";

export interface Notice {
  readonly level: NoticeLevel;
  readonly message: string;
}

export function decodeNotice(json: unknown): Notice | undefined {
  if (!isObject(json)) return undefined;
  return { level: readCaseOrUnknown(json, "level", NOTICE_LEVELS), message: readString(json, "message") ?? "" };
}

/// A durable mark that the chat switched model, effort or provider. Structured so a badge can
/// read the values back rather than parse a sentence.
export interface ModelSwitch {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly modelName: string;
  readonly effort?: string;
  readonly kind: SwitchKind;
  /// GoSpark writes it as `buddyDisabled` and still reads the older `hydraDisabled`.
  readonly buddyDisabled: boolean;
}

/// A model switch from JSON. The provider is what the mark is about, so one without it cannot
/// be read at all.
export function decodeModelSwitch(json: unknown): ModelSwitch | undefined {
  if (!isObject(json)) return undefined;
  const provider = readString(json, "provider");
  if (provider === undefined) return undefined;
  return compact({
    provider,
    model: readString(json, "model") ?? "",
    modelName: readString(json, "modelName") ?? "",
    effort: readString(json, "effort"),
    kind: readCase(json, "kind", SWITCH_KINDS) ?? "none",
    buddyDisabled: readBool(json, "buddyDisabled") ?? readBool(json, "hydraDisabled") ?? false,
  });
}

// MARK: - Turns

export const TURN_STATUSES = ["running", "completed", "interrupted", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number] | "unknown";

/// The line that closes a turn. The counts start at zero: the turn reads as finished the moment
/// the provider is done, and whatever measures the change fills them in afterwards.
export interface TurnSummary {
  readonly turnID: UUID;
  readonly status: TurnStatus;
  /// Seconds from the turn's start to its end.
  readonly duration: number;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

/// A turn summary from JSON. It names the turn it closes, so one without a turn cannot be read.
export function decodeTurnSummary(json: unknown): TurnSummary | undefined {
  if (!isObject(json)) return undefined;
  const turnID = readUUID(json, "turnID");
  if (turnID === undefined) return undefined;
  return {
    turnID,
    status: readCaseOrUnknown(json, "status", TURN_STATUSES),
    duration: readNumber(json, "duration") ?? 0,
    filesChanged: readInt(json, "filesChanged") ?? 0,
    additions: readInt(json, "additions") ?? 0,
    deletions: readInt(json, "deletions") ?? 0,
  };
}

/// One turn of a thread: who ran it, when, and how it ended.
export interface TurnRecord {
  readonly id: UUID;
  readonly index: number;
  readonly providerTurnID?: string;
  readonly startedAt: ISODate;
  readonly completedAt?: ISODate;
  readonly status: TurnStatus;
  /// GoSpark's git checkpoints before and after the turn, which its diffs and revert are built on.
  readonly baseCheckpoint?: string;
  readonly endCheckpoint?: string;
  readonly userItemID?: string;
  /// The provider's own diff, used when the workspace is not a git repository.
  readonly providerDiff?: string;
  /// The provider's last message id in this turn, used to rewind a conversation.
  readonly providerAnchor?: string;
  /// Repository-relative paths this turn's agent edited.
  readonly touchedPaths?: readonly string[];
  /// Whether this turn's paths have already gone out in a GoSpark Buddy merge.
  readonly buddyMerged: boolean;
  /// The provider, model and effort that produced this turn. Absent on turns recorded before
  /// attribution existed.
  readonly provider?: ProviderKind;
  readonly model?: string;
  readonly effort?: string;
  /// The model the provider actually served this turn, when the provider said so. CLIs silently
  /// downgrade under usage pressure; without this a badge attributes the work to the model that
  /// was asked for.
  readonly servedModel?: string;
  /// GoSpark's before and after screenshots, carried unread.
  readonly visualBefore?: unknown;
  readonly visualAfter?: unknown;
}

export function decodeTurnRecord(json: unknown, context: DecodeContext = liveDecodeContext): TurnRecord | undefined {
  if (!isObject(json)) return undefined;
  const visualBefore = readValue(json, "visualBefore");
  const visualAfter = readValue(json, "visualAfter");
  return compact({
    id: readUUID(json, "id") ?? context.newID(),
    index: readInt(json, "index") ?? 0,
    providerTurnID: readString(json, "providerTurnID"),
    startedAt: readDate(json, "startedAt") ?? context.now(),
    completedAt: readDate(json, "completedAt"),
    status: readCase(json, "status", TURN_STATUSES) ?? "running",
    baseCheckpoint: readString(json, "baseCheckpoint"),
    endCheckpoint: readString(json, "endCheckpoint"),
    userItemID: readString(json, "userItemID"),
    providerDiff: readString(json, "providerDiff"),
    providerAnchor: readString(json, "providerAnchor"),
    touchedPaths: readStrictList(json, "touchedPaths", asString),
    buddyMerged: readBool(json, "buddyMerged") ?? false,
    provider: readString(json, "provider"),
    model: readString(json, "model"),
    effort: readString(json, "effort"),
    servedModel: readString(json, "servedModel"),
    visualBefore: isObject(visualBefore) ? visualBefore : undefined,
    visualAfter: isObject(visualAfter) ? visualAfter : undefined,
  });
}

/// How full the context is. Distinct from spend: occupancy falls after compaction and misses
/// the cached context each call re-reads, so it cannot stand for what a turn cost.
export interface ContextUsage {
  readonly usedTokens: number;
  readonly windowTokens?: number;
  /// The split behind the total, where the provider reports it. Four counters because they
  /// bill at different rates; `usedTokens` stays the folded total.
  readonly freshInputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
}

/// A usage reading from JSON. The total is the reading, so one without it is no reading.
export function decodeContextUsage(json: unknown): ContextUsage | undefined {
  if (!isObject(json)) return undefined;
  const usedTokens = readInt(json, "usedTokens");
  if (usedTokens === undefined) return undefined;
  return compact({
    usedTokens,
    windowTokens: readInt(json, "windowTokens"),
    freshInputTokens: readInt(json, "freshInputTokens"),
    cacheReadTokens: readInt(json, "cacheReadTokens"),
    cacheWriteTokens: readInt(json, "cacheWriteTokens"),
    outputTokens: readInt(json, "outputTokens"),
  });
}

/// Whether any provider told us the split. Without one the meter shows a total it cannot
/// explain, which is the honest state for an adapter with a single number.
export function usageHasSplit(usage: ContextUsage): boolean {
  return (
    usage.freshInputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.outputTokens !== undefined
  );
}

/// How full the window is, from 0 to 1, or `undefined` when the window is not known.
export function usageFraction(usage: ContextUsage): number | undefined {
  if (usage.windowTokens === undefined || usage.windowTokens <= 0) return undefined;
  return Math.min(1, usage.usedTokens / usage.windowTokens);
}

// MARK: - Timeline items

/// What a row holds. `unknown` is a kind a newer writer has and this build does not: the row
/// keeps its place and its JSON, so it can be written back unchanged, and a screen can skip it
/// or say that an update is needed. GoSpark's synthesized decoder throws there and loses the
/// row.
export type TimelineContent =
  | { readonly type: "user"; readonly message: UserMessage }
  | { readonly type: "assistant"; readonly message: AssistantMessage }
  | { readonly type: "reasoning"; readonly block: ReasoningBlock }
  | { readonly type: "tool"; readonly call: ToolCall }
  | { readonly type: "plan"; readonly plan: ProposedPlan }
  | { readonly type: "todos"; readonly steps: readonly TodoStep[] }
  | { readonly type: "notice"; readonly notice: Notice }
  | { readonly type: "turnEnd"; readonly summary: TurnSummary }
  | { readonly type: "modelSwitch"; readonly info: ModelSwitch }
  | { readonly type: "unknown"; readonly rawType: string; readonly raw: unknown };

export interface TimelineItem {
  readonly id: string;
  readonly turnID?: UUID;
  readonly date: ISODate;
  readonly content: TimelineContent;
}

/// Swift's synthesized coding puts an enum case's unlabelled value under this key.
const PAYLOAD_KEY = "_0";

function decodeContent(json: unknown, context: DecodeContext): TimelineContent {
  const cases = isObject(json) ? Object.keys(json) : [];
  const rawType = cases[0] ?? "";
  const unknown: TimelineContent = { type: "unknown", rawType, raw: json };
  // Swift writes exactly one case, so anything else is not a content this build can name.
  if (!isObject(json) || cases.length !== 1) return unknown;
  const payload = readValue(fieldsOf(readValue(json, rawType)), PAYLOAD_KEY);
  switch (rawType) {
    case "user": {
      const message = decodeUserMessage(payload);
      return message === undefined ? unknown : { type: "user", message };
    }
    case "assistant": {
      const message = decodeAssistantMessage(payload);
      return message === undefined ? unknown : { type: "assistant", message };
    }
    case "reasoning": {
      const block = decodeReasoningBlock(payload);
      return block === undefined ? unknown : { type: "reasoning", block };
    }
    case "tool": {
      const call = decodeToolCall(payload, context);
      return call === undefined ? unknown : { type: "tool", call };
    }
    case "plan": {
      const plan = decodeProposedPlan(payload);
      return plan === undefined ? unknown : { type: "plan", plan };
    }
    case "todos": {
      if (!Array.isArray(payload)) return unknown;
      const steps: TodoStep[] = [];
      for (const entry of payload as unknown[]) {
        const step = decodeTodoStep(entry);
        if (step !== undefined) steps.push(step);
      }
      return { type: "todos", steps };
    }
    case "notice": {
      const notice = decodeNotice(payload);
      return notice === undefined ? unknown : { type: "notice", notice };
    }
    case "turnEnd": {
      const summary = decodeTurnSummary(payload);
      return summary === undefined ? unknown : { type: "turnEnd", summary };
    }
    case "modelSwitch": {
      const info = decodeModelSwitch(payload);
      return info === undefined ? unknown : { type: "modelSwitch", info };
    }
    default:
      return unknown;
  }
}

/// A timeline row from GoSpark's JSON. The id is the row's identity, so a row without one is
/// dropped, as one unreadable element of a list always is. A row whose content this build
/// cannot read is kept, as `unknown`.
export function decodeTimelineItem(json: unknown, context: DecodeContext = liveDecodeContext): TimelineItem | undefined {
  if (!isObject(json)) return undefined;
  const id = readString(json, "id");
  if (id === undefined) return undefined;
  return compact({
    id,
    turnID: readUUID(json, "turnID"),
    date: readDate(json, "date") ?? context.now(),
    content: decodeContent(readValue(json, "content"), context),
  });
}

function encodeContent(content: TimelineContent): unknown {
  switch (content.type) {
    case "user":
      return { user: { [PAYLOAD_KEY]: content.message } };
    case "assistant":
      return { assistant: { [PAYLOAD_KEY]: content.message } };
    case "reasoning":
      return { reasoning: { [PAYLOAD_KEY]: content.block } };
    case "tool":
      return { tool: { [PAYLOAD_KEY]: content.call } };
    case "plan":
      return { plan: { [PAYLOAD_KEY]: content.plan } };
    case "todos":
      return { todos: { [PAYLOAD_KEY]: content.steps } };
    case "notice":
      return { notice: { [PAYLOAD_KEY]: content.notice } };
    case "turnEnd":
      return { turnEnd: { [PAYLOAD_KEY]: content.summary } };
    case "modelSwitch":
      return { modelSwitch: { [PAYLOAD_KEY]: content.info } };
    case "unknown":
      // Written back exactly as it was read, so a newer writer's row survives this build.
      return content.raw;
  }
}

/// The row as GoSpark writes it, ready for `JSON.stringify`.
export function encodeTimelineItem(item: TimelineItem): unknown {
  return compact({ id: item.id, turnID: item.turnID, date: item.date, content: encodeContent(item.content) });
}

/// A thinking block with nothing to read, as a redacted stream leaves behind.
export function isEmptyReasoning(item: TimelineItem): boolean {
  return item.content.type === "reasoning" && item.content.block.text.trim().length === 0;
}
