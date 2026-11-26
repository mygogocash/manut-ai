/// A pure reducer that folds an agent's events into a thread's timeline. The rules are the ones
/// GoSpark's `ThreadRuntime.handle(_:)` applies as events arrive, with the parts that need a
/// process, a clock or a repository taken out: nothing here reads the time, makes an id, touches
/// a file or talks to a provider. The same state and the same inputs always give the same state,
/// so a timeline can be rebuilt from a log of what was received.
///
/// The state is plain data. It can be stored, sent and compared as JSON, and a caller may make
/// its own changes to it with an ordinary spread.
///
/// Two things GoSpark's runtime does are deliberately not here. Whether a decision on a request
/// still stands is `@manut/approval-core`'s to say; this reducer only stamps a request with
/// where it was asked, as the runtime does when one arrives. And what a turn changed on disk is
/// measured by whoever has the files: a turn's summary lands with zero counts, as it does in
/// GoSpark before the turn's close fills them in.

import { type ISODate, type UUID, compact } from "./coding";
import type { AgentSpawn, ProviderEvent, ToolUpdate } from "./events";
import type {
  InteractionMode,
  ModelOption,
  ProviderKind,
  RuntimePhase,
  SessionFeatures,
  SlashCommand,
} from "./provider";
import type { ApprovalRequest, ApprovalRole, QuestionRequest } from "./requests";
import type { ResearchSourceRecord } from "./research";
import { isBlank, trimmedOrUndefined, withoutEmDashes } from "./text";
import {
  type ContextUsage,
  type NoticeLevel,
  type TimelineContent,
  type TimelineItem,
  type TodoStep,
  type ToolCall,
  type TurnRecord,
  type TurnStatus,
  type UserMessage,
  appendToolOutput,
  completedPlan,
  cutOffToolCall,
  finishToolCall,
  finishToolCallEndingTurn,
  isEmptyReasoning,
  setToolOutput,
  userMessage,
} from "./timeline";

// MARK: - State

/// What one event is folded with. Both values come from the caller, which is what keeps the
/// reducer pure, and both belong in the log beside the event if the timeline is ever replayed.
export interface ReduceContext {
  /// When the event arrived.
  readonly at: ISODate;
  /// A fresh UUID, used only if this event opens a turn: the provider began one by itself, or a
  /// sub-agent started. An event opens at most one turn in any one timeline, so one id is enough.
  readonly freshID: UUID;
}

export interface ReducerOptions {
  /// Applied to everything a model writes for the thread: replies as they stream and as they
  /// land, thinking, plans and suggested titles. Tool output is process text and is never
  /// passed through. The default is GoSpark's rule, `withoutEmDashes`; pass `(text) => text` to
  /// keep model prose exactly as it arrived.
  readonly cleanProse?: (text: string) => string;
  /// The error line for a provider that went away mid-turn without saying why. GoSpark names
  /// the provider here; the default is its wording for one it cannot name.
  readonly unexpectedExitMessage?: string;
  /// The title of a tool row first heard of through an update that names none.
  readonly untitledToolTitle?: string;
}

const DEFAULT_EXIT_MESSAGE = "The agent stopped unexpectedly.";
const DEFAULT_TOOL_TITLE = "Tool";

/// What adapters call a sub-agent the provider has not described yet. A later description
/// replaces it; the placeholder never replaces a real one.
const PLACEHOLDER_DESCRIPTION = "Subagent";

/// Tokens spent, per model and in one total. `model` is absent when the adapter did not name
/// one, which groups that spend as the provider's default model rather than guessing which ran.
export interface SpendRow {
  readonly model?: string;
  readonly tokens: number;
}

export interface SpendTally {
  readonly total: number;
  readonly rows: readonly SpendRow[];
}

/// How a request stopped waiting. `decided`: the person chose (`requestDecided`). `provider`:
/// the agent said it is no longer pending. `replaced`: the agent asked again under the same id,
/// so the earlier asking is not what a decision would answer. `turnEnded` and `sessionEnded`:
/// what asked is gone.
export type SettledBy = "decided" | "provider" | "replaced" | "turnEnded" | "sessionEnded";

/// A request that no longer waits, kept so a screen can still show what was asked and why its
/// buttons went away. GoSpark's runtime only forgets such a request; this record is this
/// package's addition, and whoever keeps the approval store withdraws from it.
export type SettledRequest =
  | { readonly kind: "approval"; readonly request: ApprovalRequest; readonly by: SettledBy; readonly at: ISODate }
  | { readonly kind: "question"; readonly request: QuestionRequest; readonly by: SettledBy; readonly at: ISODate };

/// A sub-agent the provider runs inside the lead's session, with a timeline of its own that
/// replays what the session reports about it. GoSpark keeps each as a thread (a native Buddy
/// head); here it lives on its lead's state.
export interface AgentHead {
  /// The provider's id for the sub-agent.
  readonly id: string;
  readonly taskID?: string;
  /// The tool row in the lead's timeline that sent it out.
  readonly toolUseID?: string;
  readonly description: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly isBackground: boolean;
  /// `running` until it finishes, then how it ended.
  readonly status: TurnStatus;
  /// The provider's summary of its result, when it gave one.
  readonly summary?: string;
  /// The latest thing it is doing: a progress note, or the tool it last started.
  readonly activity?: string;
  /// What it has spent: the sum of its spend reports, or the provider's own running total when
  /// that says more.
  readonly tokens: number;
  readonly toolCalls: number;
  readonly startedAt: ISODate;
  readonly finishedAt?: ISODate;
  /// The session it ran in has ended. A provider numbers its sub-agents from the start again in
  /// its next session, so this one is no longer what that id means.
  readonly sessionEnded: boolean;
  readonly timeline: TimelineState;
}

export interface TimelineState {
  readonly items: readonly TimelineItem[];
  readonly turns: readonly TurnRecord[];
  readonly phase: RuntimePhase;
  /// The turn running now. Absent between turns.
  readonly currentTurnID?: UUID;
  /// The task attempt the current turn runs in, when the thread is a task (`openTurn`).
  readonly currentAttemptID?: UUID;
  /// Requests waiting for the person, oldest first.
  readonly approvals: readonly ApprovalRequest[];
  readonly questions: readonly QuestionRequest[];
  readonly settled: readonly SettledRequest[];
  /// How full the context is, by the latest reading.
  readonly usage?: ContextUsage;
  readonly spend: SpendTally;
  /// The account's usage limit is spent, and when it resets where the provider said. Cleared
  /// when the next turn opens.
  readonly usageLimit?: { readonly resetsAt?: ISODate; readonly at: ISODate };
  /// The provider's own id for its session, which a later launch resumes by.
  readonly sessionID?: string;
  /// A title the provider suggested during the first turn. Only ever a fallback: whether it is
  /// used is the caller's choice.
  readonly title?: string;
  /// The mode the agent last said it is in.
  readonly interactionMode?: InteractionMode;
  readonly models: readonly ModelOption[];
  readonly commands: readonly SlashCommand[];
  /// The running session's word on its own features. Gone when the session ends.
  readonly sessionFeatures?: SessionFeatures;
  readonly agents: readonly AgentHead[];
  /// Plans that began as a stream and have not completed yet. A plan's first completion after
  /// streaming is that plan arriving, not a revision of it (`completedPlan`).
  readonly streamingPlanIDs: readonly string[];
  /// How many row ids this timeline has made up, so the next one is new.
  readonly minted: number;
}

export function emptyTimeline(): TimelineState {
  return {
    items: [],
    turns: [],
    phase: "idle",
    approvals: [],
    questions: [],
    settled: [],
    spend: { total: 0, rows: [] },
    models: [],
    commands: [],
    agents: [],
    streamingPlanIDs: [],
    minted: 0,
  };
}

// MARK: - Spend

function saturatingSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

/// Adds one report. Zero and negative counts are dropped, because a row of zero would name a
/// model that spent nothing. A blank model name is the default model. The sums stop at the
/// largest safe count rather than lose precision on a corrupt report.
export function addSpend(tally: SpendTally, tokens: number, model: string | undefined): SpendTally {
  if (!(tokens > 0)) return tally;
  const name = trimmedOrUndefined(model);
  const index = tally.rows.findIndex((row) => row.model === name);
  const rows = tally.rows.slice();
  const existing = index < 0 ? undefined : rows[index];
  if (existing === undefined) {
    rows.push(compact({ model: name, tokens: saturatingSum(0, tokens) }));
  } else {
    rows[index] = { ...existing, tokens: saturatingSum(existing.tokens, tokens) };
  }
  return { total: saturatingSum(tally.total, tokens), rows };
}

// MARK: - Rows

function findItem(state: TimelineState, id: string): number {
  // From the end, because an event nearly always concerns a recent row.
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    if (state.items[index]?.id === id) return index;
  }
  return -1;
}

function withContent(state: TimelineState, index: number, content: TimelineContent): TimelineState {
  const item = state.items[index];
  if (item === undefined) return state;
  const items = state.items.slice();
  items[index] = { ...item, content };
  return { ...state, items };
}

/// A row stops reading as still arriving: a reply or a thought is no longer streaming, and a
/// plan that was drafting is proposed.
function endStreaming(item: TimelineItem): TimelineItem {
  const content = item.content;
  if (content.type === "assistant" && content.message.isStreaming) {
    return { ...item, content: { type: "assistant", message: { ...content.message, isStreaming: false } } };
  }
  if (content.type === "reasoning" && content.block.isStreaming) {
    return { ...item, content: { type: "reasoning", block: { ...content.block, isStreaming: false } } };
  }
  if (content.type === "plan" && content.plan.state === "drafting") {
    return { ...item, content: { type: "plan", plan: { ...content.plan, state: "proposed" } } };
  }
  return item;
}

/// Adds a row at the end. Ids are unique across a timeline, and this is the only place that
/// could break that: a provider that reuses a live id for something else is a provider bug, and
/// its second row is dropped rather than left to orphan the first.
///
/// A tool is a step inside a reply that is still streaming, not a new message, so it settles
/// nothing. Any other row settles whatever was streaming just above it.
function append(state: TimelineState, item: TimelineItem): TimelineState {
  if (findItem(state, item.id) >= 0) return state;
  const items = state.items.slice();
  if (item.content.type !== "tool") {
    for (let index = Math.max(0, items.length - 6); index < items.length; index += 1) {
      const above = items[index];
      if (above !== undefined) items[index] = endStreaming(above);
    }
  }
  items.push(item);
  return { ...state, items };
}

function remove(state: TimelineState, id: string): TimelineState {
  return { ...state, items: state.items.filter((item) => item.id !== id) };
}

function row(id: string, turnID: UUID | undefined, at: ISODate, content: TimelineContent): TimelineItem {
  return compact({ id, turnID, date: at, content });
}

/// An id for a row the provider gave none: a notice, a todo list, a turn's closing line. It is
/// made from a count the state keeps, so the same events always make the same ids.
function mintID(state: TimelineState, prefix: string): { readonly id: string; readonly state: TimelineState } {
  let count = state.minted;
  while (findItem(state, `${prefix}-${count}`) >= 0) count += 1;
  return { id: `${prefix}-${count}`, state: { ...state, minted: count + 1 } };
}

function patchTurn(state: TimelineState, id: UUID | undefined, patch: Partial<TurnRecord>): TimelineState {
  if (id === undefined) return state;
  const index = state.turns.findIndex((turn) => turn.id === id);
  const turn = state.turns[index];
  if (turn === undefined) return state;
  const turns = state.turns.slice();
  turns[index] = { ...turn, ...patch };
  return { ...state, turns };
}

/// A dying provider reports itself twice: the failing turn carries its last words, and the exit
/// then carries them again. Only an immediate repeat is dropped; a notice that recurs later in
/// the turn still shows.
function appendNotice(state: TimelineState, level: NoticeLevel, message: string, at: ISODate): TimelineState {
  const last = state.items[state.items.length - 1]?.content;
  if (last?.type === "notice" && last.notice.level === level && last.notice.message === message) return state;
  const minted = mintID(state, "notice");
  return append(minted.state, row(minted.id, state.currentTurnID, at, { type: "notice", notice: { level, message } }));
}

// MARK: - Streamed text

type StreamingBody = "message" | "reasoning" | "toolOutput" | "plan";

/// Text arriving into a row. The first piece of a reply or a plan makes its row; a thought makes
/// one only once there is something to read, because a redacted thinking block sends nothing but
/// empty pieces and would leave a blank row behind. Output for a tool nobody announced has no
/// row to land in and is dropped. A piece addressed to a row of another kind, which is a
/// provider reusing an id, is ignored.
function streamed(
  state: TimelineState,
  id: string,
  body: StreamingBody,
  text: string,
  at: ISODate,
  clean: (text: string) => string,
): TimelineState {
  // A row with no id could never be addressed again, and every other malformed event would
  // land on it.
  if (id === "") return state;
  let next = state;
  let index = findItem(next, id);
  if (index < 0) {
    if (body === "toolOutput" || (body === "reasoning" && text === "")) return state;
    if (body === "message") {
      next = append(next, row(id, next.currentTurnID, at, { type: "assistant", message: { text: "", isStreaming: true } }));
    } else if (body === "reasoning") {
      next = append(next, row(id, next.currentTurnID, at, { type: "reasoning", block: { text: "", isStreaming: true } }));
    } else {
      const plan = { markdown: "", state: "drafting", revision: 1 } as const;
      next = append(next, row(id, next.currentTurnID, at, { type: "plan", plan }));
      next = { ...next, streamingPlanIDs: [...next.streamingPlanIDs, id] };
    }
    index = next.items.length - 1;
  }
  if (text === "") return next;
  const content = next.items[index]?.content;
  if (content === undefined) return next;
  if (body === "message" && content.type === "assistant") {
    const message = { ...content.message, text: content.message.text + clean(text) };
    return withContent(next, index, { type: "assistant", message });
  }
  if (body === "reasoning" && content.type === "reasoning") {
    const block = { ...content.block, text: content.block.text + clean(text) };
    return withContent(next, index, { type: "reasoning", block });
  }
  if (body === "plan" && content.type === "plan") {
    const plan = { ...content.plan, markdown: content.plan.markdown + clean(text) };
    return withContent(next, index, { type: "plan", plan });
  }
  if (body === "toolOutput" && content.type === "tool") {
    // Tool output is process text, not the model's own writing, and passes through untouched.
    return withContent(next, index, { type: "tool", call: appendToolOutput(content.call, text) });
  }
  return next;
}

/// A reply landed. Its final text replaces what streamed, unless it is empty, which means "keep
/// what streamed". A reply with nothing to read is removed rather than left as a blank row.
function completeMessage(state: TimelineState, id: string, text: string, at: ISODate): TimelineState {
  if (id === "") return state;
  const index = findItem(state, id);
  if (index < 0) {
    if (text === "") return state;
    return append(state, row(id, state.currentTurnID, at, { type: "assistant", message: { text, isStreaming: false } }));
  }
  const content = state.items[index]?.content;
  if (content?.type !== "assistant") return state;
  const message = { ...content.message, text: text === "" ? content.message.text : text, isStreaming: false };
  return isBlank(message.text) ? remove(state, id) : withContent(state, index, { type: "assistant", message });
}

function completeReasoning(state: TimelineState, id: string, text: string, at: ISODate): TimelineState {
  if (id === "") return state;
  const index = findItem(state, id);
  if (index < 0) {
    if (text === "") return state;
    return append(state, row(id, state.currentTurnID, at, { type: "reasoning", block: { text, isStreaming: false } }));
  }
  const content = state.items[index]?.content;
  if (content?.type !== "reasoning") return state;
  const block = { text: text === "" ? content.block.text : text, isStreaming: false };
  return isBlank(block.text) ? remove(state, id) : withContent(state, index, { type: "reasoning", block });
}

function completePlan(state: TimelineState, id: string, markdown: string, at: ISODate): TimelineState {
  if (id === "") return state;
  const firstStreamed = state.streamingPlanIDs.includes(id);
  const next = firstStreamed
    ? { ...state, streamingPlanIDs: state.streamingPlanIDs.filter((streaming) => streaming !== id) }
    : state;
  const index = findItem(next, id);
  if (index < 0) {
    if (markdown === "") return next;
    const plan = { markdown, state: "proposed", revision: 1 } as const;
    return append(next, row(id, next.currentTurnID, at, { type: "plan", plan }));
  }
  const content = next.items[index]?.content;
  if (content?.type !== "plan") return next;
  return withContent(next, index, { type: "plan", plan: completedPlan(content.plan, markdown, firstStreamed) });
}

/// Lands a research answer's sources on its reply, once. The first set a reply is given is its
/// provenance and nothing later replaces it, so a reopened thread shows the sources the answer
/// was written from rather than a fresher set.
function attachSources(state: TimelineState, id: string, sources: readonly ResearchSourceRecord[]): TimelineState {
  const index = findItem(state, id);
  const content = state.items[index]?.content;
  if (content?.type !== "assistant" || content.message.sources !== undefined) return state;
  return withContent(state, index, { type: "assistant", message: { ...content.message, sources } });
}

// MARK: - Tool calls

/// A tool call started, or was announced again with more known about it. Providers do announce
/// a call twice, so the second word updates the row: its title, detail, kind and edits, and its
/// ending if it has one by now. Output and the exit code only ever arrive as updates.
function upsertTool(state: TimelineState, id: string, call: ToolCall, at: ISODate): TimelineState {
  if (id === "") return state;
  const index = findItem(state, id);
  if (index < 0) return append(state, row(id, state.currentTurnID, at, { type: "tool", call }));
  const content = state.items[index]?.content;
  if (content?.type !== "tool") return state;
  let existing: ToolCall = {
    ...content.call,
    title: call.title === "" ? content.call.title : call.title,
    kind: call.kind,
    edits: call.edits.length === 0 ? content.call.edits : call.edits,
  };
  if (call.detail !== undefined) existing = { ...existing, detail: call.detail };
  if (existing.status === "running" && call.status !== "running") existing = finishToolCall(existing, call.status, at);
  return withContent(state, index, { type: "tool", call: existing });
}

/// Applies what changed about a call. An update for a call nobody announced makes its row, so a
/// provider that reports only endings still shows its tools.
function applyToolUpdate(
  state: TimelineState,
  id: string,
  update: ToolUpdate,
  at: ISODate,
  options: ReducerOptions,
): TimelineState {
  if (id === "") return state;
  let next = state;
  if (findItem(next, id) < 0) {
    const call: ToolCall = {
      kind: update.kind ?? "other",
      title: update.title ?? options.untitledToolTitle ?? DEFAULT_TOOL_TITLE,
      output: "",
      status: "running",
      edits: [],
      startedAt: at,
    };
    next = append(next, row(id, next.currentTurnID, at, { type: "tool", call }));
  }
  const index = findItem(next, id);
  const content = next.items[index]?.content;
  if (content?.type !== "tool") return next;
  let call = content.call;
  if (update.title !== undefined && update.title !== "") call = { ...call, title: update.title };
  if (update.detail !== undefined) call = { ...call, detail: update.detail };
  if (update.kind !== undefined) call = { ...call, kind: update.kind };
  if (update.edits !== undefined && update.edits.length > 0) call = { ...call, edits: update.edits };
  if (update.output !== undefined) call = setToolOutput(call, update.output);
  if (update.exitCode !== undefined) call = { ...call, exitCode: update.exitCode };
  if (update.status !== undefined) {
    call = update.status === "running" ? { ...call, status: "running" } : finishToolCall(call, update.status, at);
  }
  return withContent(next, index, { type: "tool", call });
}

/// The agent's todo list is one row a turn: each new list replaces the turn's last one, and an
/// empty list makes no row of its own.
function upsertTodos(state: TimelineState, steps: readonly TodoStep[], at: ISODate): TimelineState {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item?.content.type === "todos" && item.turnID === state.currentTurnID) {
      return withContent(state, index, { type: "todos", steps });
    }
  }
  if (steps.length === 0) return state;
  const minted = mintID(state, "todos");
  return append(minted.state, row(minted.id, state.currentTurnID, at, { type: "todos", steps }));
}

// MARK: - Requests

/// Records on an arriving request the turn and attempt it was asked in. Whatever it carried is
/// replaced, a missing value included: where a request was asked is the runtime's to say, never
/// the provider's.
function stamped<T extends ApprovalRequest | QuestionRequest>(request: T, state: TimelineState): T {
  const { turnID: _carriedTurn, attemptID: _carriedAttempt, ...rest } = request;
  return {
    ...rest,
    ...(state.currentTurnID === undefined ? {} : { turnID: state.currentTurnID }),
    ...(state.currentAttemptID === undefined ? {} : { attemptID: state.currentAttemptID }),
  } as T;
}

/// Stamps a plan approval with the revision of the plan it names, as the request arrives. Any
/// other request, and one naming a plan the timeline does not hold, is left as it came.
function withPlanRevision(request: ApprovalRequest, state: TimelineState): ApprovalRequest {
  if (request.kind !== "plan" || request.toolItemID === undefined) return request;
  const content = state.items[findItem(state, request.toolItemID)]?.content;
  return content?.type === "plan" ? { ...request, planRevision: content.plan.revision } : request;
}

function settleAll(state: TimelineState, by: SettledBy, at: ISODate): TimelineState {
  if (state.approvals.length === 0 && state.questions.length === 0) return state;
  const settled: SettledRequest[] = [
    ...state.settled,
    ...state.approvals.map((request) => ({ kind: "approval", request, by, at }) as const),
    ...state.questions.map((request) => ({ kind: "question", request, by, at }) as const),
  ];
  return { ...state, approvals: [], questions: [], settled };
}

function settleByID(state: TimelineState, id: string, by: SettledBy, at: ISODate): TimelineState {
  const approvals = state.approvals.filter((request) => request.id === id);
  const questions = state.questions.filter((request) => request.id === id);
  if (approvals.length === 0 && questions.length === 0) return state;
  const settled: SettledRequest[] = [
    ...state.settled,
    ...approvals.map((request) => ({ kind: "approval", request, by, at }) as const),
    ...questions.map((request) => ({ kind: "question", request, by, at }) as const),
  ];
  return {
    ...state,
    approvals: state.approvals.filter((request) => request.id !== id),
    questions: state.questions.filter((request) => request.id !== id),
    settled,
  };
}

/// An approval arrived. One asked again under an id that is still waiting replaces the earlier
/// asking, which is recorded as replaced: a decision on what was shown before would answer a
/// request that is no longer the one asked.
function receiveApproval(state: TimelineState, request: ApprovalRequest, at: ISODate): TimelineState {
  const arriving = stamped(withPlanRevision(request, state), state);
  const replaced = state.approvals.filter((waiting) => waiting.id === request.id);
  return {
    ...state,
    approvals: [...state.approvals.filter((waiting) => waiting.id !== request.id), arriving],
    settled: [...state.settled, ...replaced.map((old) => ({ kind: "approval", request: old, by: "replaced", at }) as const)],
  };
}

function receiveQuestion(state: TimelineState, request: QuestionRequest, at: ISODate): TimelineState {
  const arriving = stamped(request, state);
  const replaced = state.questions.filter((waiting) => waiting.id === request.id);
  return {
    ...state,
    questions: [...state.questions.filter((waiting) => waiting.id !== request.id), arriving],
    settled: [...state.settled, ...replaced.map((old) => ({ kind: "question", request: old, by: "replaced", at }) as const)],
  };
}

// MARK: - Turns

/// What a caller says when it opens a turn.
export interface TurnOpening {
  /// The new turn's id, made by the caller. GoSpark types a turn's id as a UUID.
  readonly turnID: UUID;
  readonly at: ISODate;
  /// The message that starts the turn. Absent for a turn the provider begins by itself.
  readonly userMessage?: UserMessage;
  /// The id for the message's row. Absent, one is made.
  readonly userItemID?: string;
  /// The task attempt the turn runs in, when the thread is a task. Requests that arrive during
  /// the turn are stamped with it.
  readonly attemptID?: UUID;
  /// Who will run the turn, for the turn's badge.
  readonly provider?: ProviderKind;
  readonly model?: string;
  readonly effort?: string;
}

/// Opens a turn and makes it the current one: the record, and its opening message where it has
/// one. Opening a turn is the caller's act, not an event, which is why it is a function beside
/// the reducer.
///
/// The thread is then `starting`, because a turn with a message of ours has not reached the
/// provider until it is sent, and a late word about the turn before it must not end this one.
/// Call `markTurnSent` as the message goes out. A turn never marked sent ignores every ending
/// until its provider announces a start (`turnStarted`), which not every provider does.
export function openTurn(state: TimelineState, opening: TurnOpening): TimelineState {
  if (state.turns.some((turn) => turn.id === opening.turnID)) return state;
  let next = state;
  let userItemID = opening.userItemID;
  if (opening.userMessage !== undefined && userItemID === undefined) {
    const minted = mintID(next, "user");
    next = minted.state;
    userItemID = minted.id;
  }
  const record: TurnRecord = compact({
    id: opening.turnID,
    index: Math.max(-1, ...next.turns.map((turn) => turn.index)) + 1,
    startedAt: opening.at,
    status: "running" as const,
    userItemID: opening.userMessage === undefined ? undefined : userItemID,
    buddyMerged: false,
    provider: opening.provider,
    model: opening.model,
    effort: opening.effort,
  });
  const { currentAttemptID: _previousAttempt, usageLimit: _waited, ...rest } = next;
  next = compact({
    ...rest,
    turns: [...next.turns, record],
    currentTurnID: opening.turnID,
    currentAttemptID: opening.attemptID,
    phase: "starting" as const,
  });
  if (opening.userMessage !== undefined && userItemID !== undefined) {
    next = append(next, row(userItemID, opening.turnID, opening.at, { type: "user", message: opening.userMessage }));
  }
  return next;
}

/// The turn's message is on its way to the provider, so the thread is running. Until then a
/// completion or an exit is about something earlier and leaves the waiting turn alone.
export function markTurnSent(state: TimelineState): TimelineState {
  return state.phase === "starting" && state.currentTurnID !== undefined ? { ...state, phase: "running" } : state;
}

/// The provider says the turn is over, or a stop or a failure ended it. Everything the turn left
/// open is closed here: what was waiting for the person, rows still streaming, and calls still
/// running, which end by how the turn ended. The closing line goes in with no counts.
///
/// A finish that finds no turn in hand, the second of a completion and an exit, only settles
/// the phase, so the turn ends once.
function finishTurn(
  state: TimelineState,
  status: TurnStatus,
  context: ReduceContext,
  options: ReducerOptions,
): TimelineState {
  const turnID = state.currentTurnID;
  const turn = state.turns.find((candidate) => candidate.id === turnID);
  if (turnID === undefined || turn === undefined) {
    const { currentTurnID: _gone, currentAttemptID: _attempt, ...rest } = state;
    return { ...rest, phase: "idle" };
  }
  const at = context.at;
  const { currentTurnID: _ended, currentAttemptID: _attempt, ...rest } = state;
  let next: TimelineState = settleAll(rest, "turnEnded", at);
  next = {
    ...next,
    items: next.items.map((item) => {
      if (item.turnID !== turnID) return item;
      const settled = endStreaming(item);
      const content = settled.content;
      if (content.type !== "tool" || content.call.status !== "running") return settled;
      return { ...settled, content: { type: "tool", call: finishToolCallEndingTurn(content.call, status, at) } };
    }),
  };
  next = patchTurn(next, turnID, { status, completedAt: at });
  const seconds = Math.max(0, (Date.parse(at) - Date.parse(turn.startedAt)) / 1000);
  const summary = {
    turnID,
    status,
    duration: Number.isFinite(seconds) ? seconds : 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
  const minted = mintID(next, "turn-end");
  next = append(minted.state, row(minted.id, turnID, at, { type: "turnEnd", summary }));
  next = { ...next, phase: "idle" };
  // The lead's turn is over, so any foreground sub-agent still marked as working went with it:
  // a stopped turn stopped them, a finished one finished them. Background ones outlive the
  // turn and end on the provider's word.
  for (let index = 0; index < next.agents.length; index += 1) {
    const head = next.agents[index];
    if (head === undefined || head.sessionEnded || head.isBackground || head.status !== "running") continue;
    next = finishHead(next, index, status === "completed" ? "completed" : "interrupted", undefined, context, options);
  }
  return next;
}

// MARK: - Sub-agents

function findHead(state: TimelineState, agentID: string): number {
  for (let index = state.agents.length - 1; index >= 0; index -= 1) {
    const head = state.agents[index];
    if (head !== undefined && head.id === agentID && !head.sessionEnded) return index;
  }
  return -1;
}

function withHead(state: TimelineState, index: number, head: AgentHead): TimelineState {
  const agents = state.agents.slice();
  agents[index] = head;
  return { ...state, agents };
}

/// The brief a sub-agent was given, once the provider says what it was: a user message at the
/// top of a timeline that started without one. A timeline that already holds a brief keeps it,
/// so a sub-agent set to work a second time is not handed its first brief again above
/// everything it has done.
function withBrief(timeline: TimelineState, prompt: string, at: ISODate): TimelineState {
  const turn = timeline.turns[timeline.turns.length - 1];
  if (turn === undefined || turn.userItemID !== undefined) return timeline;
  const briefed = timeline.items.some((item) => item.content.type === "user" && item.content.message.buddyHeads === undefined);
  if (briefed) return timeline;
  const minted = mintID(timeline, "user");
  const brief = row(minted.id, turn.id, at, { type: "user", message: userMessage(prompt) });
  return patchTurn({ ...minted.state, items: [brief, ...minted.state.items] }, turn.id, { userItemID: minted.id });
}

/// A sub-agent the provider started inside this session, or more said about one already known:
/// a name for the tool call that spawned it, its brief.
function startHead(state: TimelineState, spawn: AgentSpawn, context: ReduceContext): TimelineState {
  if (spawn.id === "") return state;
  const known = findHead(state, spawn.id);
  const existing = state.agents[known];
  if (existing !== undefined) {
    const named = spawn.description !== "" && spawn.description !== PLACEHOLDER_DESCRIPTION;
    let head: AgentHead = { ...existing, description: named ? spawn.description : existing.description };
    if (head.toolUseID === undefined && spawn.toolUseID !== undefined) head = { ...head, toolUseID: spawn.toolUseID };
    if (spawn.prompt !== undefined) {
      head = { ...head, prompt: head.prompt ?? spawn.prompt, timeline: withBrief(head.timeline, spawn.prompt, context.at) };
    }
    return withHead(state, known, head);
  }
  // Its timeline starts on the brief when the provider has said what it is; otherwise it starts
  // at work, and the brief slots in above once it arrives.
  const opening = compact({
    turnID: context.freshID,
    at: context.at,
    userMessage: spawn.prompt === undefined ? undefined : userMessage(spawn.prompt),
  });
  const head: AgentHead = compact({
    id: spawn.id,
    taskID: spawn.taskID,
    toolUseID: spawn.toolUseID,
    description: spawn.description,
    prompt: spawn.prompt,
    model: spawn.model,
    isBackground: spawn.isBackground,
    status: "running" as const,
    tokens: 0,
    toolCalls: 0,
    startedAt: context.at,
    sessionEnded: false,
    timeline: markTurnSent(openTurn(emptyTimeline(), opening)),
  });
  return { ...state, agents: [...state.agents, head] };
}

/// A sub-agent finished: its status and summary land, its own timeline closes, and the tool row
/// that sent it out completes if the provider left it running. One that has already finished
/// keeps its first ending.
function finishHead(
  state: TimelineState,
  index: number,
  status: TurnStatus,
  summary: string | undefined,
  context: ReduceContext,
  options: ReducerOptions,
): TimelineState {
  const before = state.agents[index];
  // "Finished, and still running" says nothing, so it changes nothing.
  if (before === undefined || status === "running") return state;
  const wasRunning = before.status === "running";
  let head = before;
  if (wasRunning) {
    head = { ...head, status, finishedAt: context.at };
    if (summary !== undefined) head = { ...head, summary };
  }
  if (head.timeline.phase !== "idle") {
    head = { ...head, timeline: reduceTimeline(head.timeline, { type: "turnCompleted", status }, context, options) };
  }
  let next = withHead(state, index, head);
  if (!wasRunning || head.toolUseID === undefined) return next;
  const spawning = next.items[findItem(next, head.toolUseID)]?.content;
  if (spawning?.type !== "tool" || spawning.call.status !== "running") return next;
  const update: ToolUpdate = compact({ output: summary, status: status === "completed" ? ("completed" as const) : ("failed" as const) });
  next = applyToolUpdate(next, head.toolUseID, update, context.at, options);
  return next;
}

/// The session the sub-agents ran in has stopped: whichever were still running are done, and
/// none of them answers to its id any more.
function endHeads(state: TimelineState, context: ReduceContext, options: ReducerOptions): TimelineState {
  let next = state;
  for (let index = 0; index < next.agents.length; index += 1) {
    const head = next.agents[index];
    if (head === undefined || head.sessionEnded) continue;
    if (head.status === "running") next = finishHead(next, index, "interrupted", undefined, context, options);
    const ended = next.agents[index];
    if (ended !== undefined) next = withHead(next, index, { ...ended, sessionEnded: true });
  }
  return next;
}

/// An event from inside a sub-agent's transcript, replayed on the sub-agent's own timeline.
function agentEvent(
  state: TimelineState,
  agentID: string,
  event: ProviderEvent,
  context: ReduceContext,
  options: ReducerOptions,
): TimelineState {
  if (agentID === "") return state;
  let next = state;
  if (findHead(next, agentID) < 0) {
    // Heard from before it was announced: on Claude the sub-agent's id is the tool call that
    // spawned it, so the row already names its task.
    const spawning = next.items[findItem(next, agentID)]?.content;
    if (spawning?.type === "tool" && spawning.call.kind === "agent") {
      const spawn = { id: agentID, toolUseID: agentID, description: spawning.call.title, isBackground: false };
      next = startHead(next, spawn, context);
    }
  }
  const index = findHead(next, agentID);
  const head = next.agents[index];
  if (head === undefined) {
    // Spend no sub-agent here stands for was still this session's, so the lead keeps it rather
    // than losing it. Everything else about a sub-agent nobody announced has nowhere to go.
    return event.type === "spend" ? { ...next, spend: addSpend(next.spend, event.tokens, event.model) } : next;
  }
  switch (event.type) {
    case "spend": {
      // The sub-agent's, not the lead's. The provider's own running total may already say more.
      const timeline = { ...head.timeline, spend: addSpend(head.timeline.spend, event.tokens, event.model) };
      return withHead(next, index, { ...head, timeline, tokens: Math.max(head.tokens, timeline.spend.total) });
    }
    case "turnStarted": {
      // A sub-agent briefed again by its lead works another turn.
      if (head.timeline.phase !== "idle") return next;
      const { finishedAt: _reopened, ...rest } = head;
      const timeline = markTurnSent(openTurn(head.timeline, { turnID: context.freshID, at: context.at }));
      return withHead(next, index, { ...rest, status: "running", timeline });
    }
    case "turnCompleted":
      return finishHead(next, index, event.status, undefined, context, options);
    case "toolStarted": {
      // Counted once per call: providers announce a tool's start twice.
      const isNew = event.id !== "" && findItem(head.timeline, event.id) < 0;
      const timeline = reduceTimeline(head.timeline, event, context, options);
      const activity = event.call.title === "" ? head.activity : event.call.title;
      return withHead(next, index, compact({ ...head, timeline, activity, toolCalls: head.toolCalls + (isNew ? 1 : 0) }));
    }
    // What a sub-agent's session says about itself is the lead's session saying it again, and
    // its context reading says nothing of what it cost.
    case "usage":
    case "sessionReady":
    case "models":
    case "commands":
    case "sessionFeatures":
    case "title":
    case "assistantMessageID":
    case "unknown":
      return next;
    default:
      return withHead(next, index, { ...head, timeline: reduceTimeline(head.timeline, event, context, options) });
  }
}

// MARK: - The reducer

function sameFeatures(left: SessionFeatures | undefined, right: SessionFeatures): boolean {
  return (
    left !== undefined &&
    left.readsSettings === right.readsSettings &&
    left.ultracodeAvailable === right.ultracodeAvailable &&
    left.ultracodeRequested === right.ultracodeRequested &&
    left.ultracodeActive === right.ultracodeActive &&
    left.workflowsEnabled === right.workflowsEnabled &&
    left.keywordTriggerEnabled === right.keywordTriggerEnabled &&
    left.appliedEffort === right.appliedEffort
  );
}

/// Folds one event into the timeline and returns the new state. The state it was given is never
/// changed, and an event that says nothing new returns that same state.
export function reduceTimeline(
  state: TimelineState,
  event: ProviderEvent,
  context: ReduceContext,
  options: ReducerOptions = {},
): TimelineState {
  const clean = options.cleanProse ?? withoutEmDashes;
  const at = context.at;
  switch (event.type) {
    case "sessionReady":
      return event.sessionID === "" ? state : { ...state, sessionID: event.sessionID };
    case "turnStarted": {
      // The provider started a turn nobody opened: it is answering a note handed to the last
      // one, or working on its own schedule. It gets a record of its own, or its output lands on
      // no turn at all and the thread never hears that it ended.
      let next = state.currentTurnID === undefined ? openTurn(state, { turnID: context.freshID, at }) : state;
      next = { ...next, phase: "running" };
      return event.providerTurnID === undefined
        ? next
        : patchTurn(next, next.currentTurnID, { providerTurnID: event.providerTurnID });
    }
    case "messageDelta":
      return streamed(state, event.id, "message", event.text, at, clean);
    case "messageCompleted":
      return completeMessage(state, event.id, clean(event.text), at);
    case "reasoningDelta":
      return streamed(state, event.id, "reasoning", event.text, at, clean);
    case "reasoningCompleted":
      return completeReasoning(state, event.id, clean(event.text), at);
    case "toolStarted":
      return upsertTool(state, event.id, event.call, at);
    case "toolOutput":
      return streamed(state, event.id, "toolOutput", event.text, at, clean);
    case "toolUpdated": {
      let next = applyToolUpdate(state, event.id, event.update, at, options);
      const status = event.update.status;
      if (status === undefined || status === "running") return next;
      // The tool call that sent out a foreground sub-agent has returned: the sub-agent is done,
      // and the result is its report. A background one's call returns at once and says nothing
      // about it.
      for (let index = 0; index < next.agents.length; index += 1) {
        const head = next.agents[index];
        if (head === undefined || head.sessionEnded || head.toolUseID !== event.id) continue;
        if (head.isBackground || head.status !== "running") continue;
        const outcome = status === "completed" ? "completed" : status === "declined" ? "interrupted" : "failed";
        next = finishHead(next, index, outcome, event.update.output, context, options);
      }
      return next;
    }
    case "planDelta":
      return streamed(state, event.id, "plan", event.text, at, clean);
    case "planCompleted":
      return completePlan(state, event.id, clean(event.markdown), at);
    case "todos":
      return upsertTodos(state, event.steps, at);
    case "approval":
      return receiveApproval(state, event.request, at);
    case "question":
      return receiveQuestion(state, event.request, at);
    case "requestResolved":
      return settleByID(state, event.id, "provider", at);
    case "usage":
      return { ...state, usage: event.usage };
    case "spend":
      return event.tokens > 0 ? { ...state, spend: addSpend(state.spend, event.tokens, event.model) } : state;
    case "sources":
      return attachSources(state, event.messageID, event.sources);
    case "diff":
      return patchTurn(state, state.currentTurnID, { providerDiff: event.diff });
    case "notice":
      return appendNotice(state, event.notice.level, event.notice.message, at);
    case "usageLimit":
      return { ...state, usageLimit: compact({ resetsAt: event.resetsAt, at }) };
    case "modeChanged":
      return state.interactionMode === event.mode ? state : { ...state, interactionMode: event.mode };
    case "models": {
      // The provider's word on what is actually serving this turn. The turn keeps what was asked
      // for as well, so a badge can show the truth instead of the request.
      const next = { ...state, models: event.models };
      return event.current === undefined ? next : patchTurn(next, next.currentTurnID, { servedModel: event.current });
    }
    case "commands":
      return { ...state, commands: event.commands };
    case "sessionFeatures":
      return sameFeatures(state.sessionFeatures, event.features) ? state : { ...state, sessionFeatures: event.features };
    case "title":
      // A provider's title is offered only while the thread is on its first turn. After that
      // the thread has a name, and a later suggestion must not rename it.
      return state.turns.length <= 1 ? { ...state, title: clean(event.title) } : state;
    case "assistantMessageID":
      return patchTurn(state, state.currentTurnID, { providerAnchor: event.messageID });
    case "turnCompleted": {
      const error = trimmedOrUndefined(event.error);
      const next = error === undefined ? state : appendNotice(state, "error", error, at);
      // A turn still waiting to send cannot have ended on the provider's side. This is a late
      // completion of the turn before it (a Stop that raced that turn's own end), and ending the
      // waiting turn with it would drop the message it waits to send.
      if (next.currentTurnID !== undefined && next.phase === "starting") return next;
      return finishTurn(next, event.status, context, options);
    }
    case "exited": {
      const { sessionFeatures: _gone, ...rest } = state;
      let next: TimelineState = settleAll(rest, "sessionEnded", at);
      next = endHeads(next, context, options);
      // A turn still waiting to send has lost nothing: the session it would have used is gone,
      // and its start makes a fresh one. Only a turn the provider had fails.
      if (next.currentTurnID === undefined || next.phase === "starting") return next;
      const message = trimmedOrUndefined(event.error) ?? options.unexpectedExitMessage ?? DEFAULT_EXIT_MESSAGE;
      return finishTurn(appendNotice(next, "error", message, at), "failed", context, options);
    }
    case "agentStarted":
      return startHead(state, event.spawn, context);
    case "agentEvent":
      return agentEvent(state, event.agentID, event.event, context, options);
    case "agentProgress": {
      const index = findHead(state, event.agentID);
      const head = state.agents[index];
      if (head === undefined) return state;
      const note = event.summary !== undefined && event.summary !== "" ? event.summary : event.lastTool;
      return withHead(
        state,
        index,
        compact({
          ...head,
          activity: note ?? head.activity,
          // The provider's running total, never below what the sub-agent's spend reports add to.
          tokens: event.tokens === undefined ? head.tokens : Math.max(event.tokens, head.timeline.spend.total),
          // An absolute count, not an increment.
          toolCalls: event.toolCalls ?? head.toolCalls,
        }),
      );
    }
    case "agentFinished": {
      const index = findHead(state, event.agentID);
      return index < 0 ? state : finishHead(state, index, event.status, event.summary, context, options);
    }
    case "unknown":
      // A kind this build cannot read changes nothing it can show. It was kept as far as here so
      // the caller could see it arrive; folding it in would be a guess.
      return state;
  }
}

// MARK: - The person's side

/// The person decided a waiting request. It stops waiting, and a plan request settles the plan
/// it names: an approving choice accepts it and any other dismisses it.
///
/// This records a decision that has already been allowed. Whether it may be made at all (the
/// right person, the turn and attempt still running, the revision the person saw) is
/// `@manut/approval-core`'s rule, and telling the provider is the session's job.
export function requestDecided(state: TimelineState, id: string, at: ISODate, role?: ApprovalRole): TimelineState {
  const approval = state.approvals.find((request) => request.id === id);
  let next = settleByID(state, id, "decided", at);
  if (approval === undefined || role === undefined || approval.kind !== "plan" || approval.toolItemID === undefined) {
    return next;
  }
  const index = findItem(next, approval.toolItemID);
  const content = next.items[index]?.content;
  if (content?.type !== "plan") return next;
  const approves = role === "approve" || role === "approveAlways";
  next = withContent(next, index, { type: "plan", plan: { ...content.plan, state: approves ? "accepted" : "dismissed" } });
  return next;
}

// MARK: - Reading a saved thread back

/// The timeline a saved thread opens on, as GoSpark's runtime restores one. The process that
/// wrote it is gone, so nothing in it can still be arriving: thinking with nothing to read is
/// dropped, streaming rows are settled, a call still marked running is cut off (it may have
/// finished its work first, so its outcome is unknown, not failed) and a turn still marked
/// running was interrupted. Prose saved before it was cleaned on the way in is cleaned now.
export function restoreTimeline(
  saved: { readonly items: readonly TimelineItem[]; readonly turns: readonly TurnRecord[]; readonly usage?: ContextUsage },
  at: ISODate,
  options: ReducerOptions = {},
): TimelineState {
  const clean = options.cleanProse ?? withoutEmDashes;
  const items = saved.items
    .filter((item) => !isEmptyReasoning(item))
    .map((item): TimelineItem => {
      const settled = endStreaming(item);
      const content = settled.content;
      switch (content.type) {
        case "assistant":
          return { ...settled, content: { type: "assistant", message: { ...content.message, text: clean(content.message.text) } } };
        case "reasoning":
          return { ...settled, content: { type: "reasoning", block: { ...content.block, text: clean(content.block.text) } } };
        case "plan":
          return { ...settled, content: { type: "plan", plan: { ...content.plan, markdown: clean(content.plan.markdown) } } };
        case "tool":
          return content.call.status === "running"
            ? { ...settled, content: { type: "tool", call: cutOffToolCall(content.call, at) } }
            : settled;
        default:
          return settled;
      }
    });
  const turns = saved.turns.map((turn): TurnRecord => (turn.status === "running" ? { ...turn, status: "interrupted" } : turn));
  return compact({ ...emptyTimeline(), items, turns, usage: saved.usage, minted: items.length });
}
