/// The one event contract every agent reports through. Ported from `ProviderEvent` in GoSpark's
/// `GoGoCode/Providers/ProviderSession.swift`, which normalizes every agent it drives to one
/// event enum.
///
/// The rule the contract exists for: an adapter maps its provider's wire format into these
/// events and nothing past the adapter ever sees that format. When an agent gains a capability,
/// a case is added here and every adapter maps into it. Commands go in through the session's
/// methods, and facts come out as events.
///
/// GoSpark's enum lives in one process and is never encoded, so its JSON form is chosen here: one
/// object with a `type` naming the case, and the case's values beside it under their Swift
/// labels (a value Swift leaves unlabelled takes the name GoSpark's runtime binds it to). This
/// is the shape GoSpark hand-writes for `MessageSource`. An event value is therefore already its
/// own JSON, and `decodeProviderEvent` is the way back in.

import {
  type DecodeContext,
  type ISODate,
  compact,
  isObject,
  liveDecodeContext,
  readBool,
  readCase,
  readCaseOrUnknown,
  readDate,
  readInt,
  readList,
  readString,
  readValue,
} from "./coding";
import {
  INTERACTION_MODES,
  type InteractionMode,
  type ModelOption,
  type SessionFeatures,
  type SlashCommand,
  decodeModelOption,
  decodeSessionFeatures,
  decodeSlashCommand,
} from "./provider";
import {
  type ApprovalRequest,
  type QuestionRequest,
  decodeApprovalRequest,
  decodeQuestionRequest,
} from "./requests";
import { type ResearchSourceRecord, decodeResearchSourceRecord } from "./research";
import {
  type ContextUsage,
  type FileEdit,
  type Notice,
  TOOL_CALL_KINDS,
  TOOL_CALL_STATUSES,
  TURN_STATUSES,
  type TodoStep,
  type ToolCall,
  type ToolCallKind,
  type ToolCallStatus,
  type TurnStatus,
  decodeContextUsage,
  decodeFileEdit,
  decodeNotice,
  decodeTodoStep,
  decodeToolCall,
} from "./timeline";

/// A sub-agent (GoSpark calls it a head) a provider started inside the lead's session.
export interface AgentSpawn {
  /// The provider's id for the sub-agent, which its later events carry.
  readonly id: string;
  /// Claude's task id, which is what stops the sub-agent. Absent where the id above does.
  readonly taskID?: string;
  /// The tool call in the lead's transcript that spawned the sub-agent.
  readonly toolUseID?: string;
  readonly description: string;
  /// The sub-agent's brief, when the provider says.
  readonly prompt?: string;
  readonly model?: string;
  /// Whether the spawning tool call returns before the sub-agent is done. A foreground one is
  /// finished by its tool result; a background one only by the provider saying so.
  readonly isBackground: boolean;
}

/// A sub-agent's spawn from JSON. With no word on it, a sub-agent is a background one, as
/// GoSpark's own default has it: nothing then ends it but the provider.
export function decodeAgentSpawn(json: unknown): AgentSpawn | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    id: readString(json, "id") ?? "",
    taskID: readString(json, "taskID"),
    toolUseID: readString(json, "toolUseID"),
    description: readString(json, "description") ?? "",
    prompt: readString(json, "prompt"),
    model: readString(json, "model"),
    isBackground: readBool(json, "isBackground") ?? true,
  });
}

/// What changed about a tool call. Every field is optional: only what is present is applied.
export interface ToolUpdate {
  readonly title?: string;
  readonly detail?: string;
  readonly output?: string;
  readonly status?: ToolCallStatus;
  readonly exitCode?: number;
  readonly edits?: readonly FileEdit[];
  readonly kind?: ToolCallKind;
}

export function decodeToolUpdate(json: unknown): ToolUpdate | undefined {
  if (!isObject(json)) return undefined;
  // A status or a kind that is present but not understood is a change this build cannot name,
  // which is different from no change at all.
  const status = readValue(json, "status") == null ? undefined : readCaseOrUnknown(json, "status", TOOL_CALL_STATUSES);
  const kind = readValue(json, "kind") == null ? undefined : readCaseOrUnknown(json, "kind", TOOL_CALL_KINDS);
  return compact({
    title: readString(json, "title"),
    detail: readString(json, "detail"),
    output: readString(json, "output"),
    status,
    exitCode: readInt(json, "exitCode"),
    edits: readList(json, "edits", decodeFileEdit),
    kind,
  });
}

/// Normalized events every agent adapter emits into a thread.
export type ProviderEvent =
  /// The provider launched and named its session, which a later launch resumes by.
  | { readonly type: "sessionReady"; readonly sessionID: string }
  | { readonly type: "turnStarted"; readonly providerTurnID?: string }
  | { readonly type: "messageDelta"; readonly id: string; readonly text: string }
  | { readonly type: "messageCompleted"; readonly id: string; readonly text: string }
  | { readonly type: "reasoningDelta"; readonly id: string; readonly text: string }
  | { readonly type: "reasoningCompleted"; readonly id: string; readonly text: string }
  | { readonly type: "toolStarted"; readonly id: string; readonly call: ToolCall }
  | { readonly type: "toolOutput"; readonly id: string; readonly text: string }
  | { readonly type: "toolUpdated"; readonly id: string; readonly update: ToolUpdate }
  | { readonly type: "planDelta"; readonly id: string; readonly text: string }
  | { readonly type: "planCompleted"; readonly id: string; readonly markdown: string }
  /// The agent's whole todo list as it stands now, every time.
  | { readonly type: "todos"; readonly steps: readonly TodoStep[] }
  | { readonly type: "approval"; readonly request: ApprovalRequest }
  | { readonly type: "question"; readonly request: QuestionRequest }
  /// An approval or question is no longer waiting, by the provider's own word.
  | { readonly type: "requestResolved"; readonly id: string }
  /// How full the context is.
  | { readonly type: "usage"; readonly usage: ContextUsage }
  /// Tokens a model call or a turn actually spent, with the model when the adapter names it.
  /// Distinct from `usage`: occupancy falls after compaction and misses the cached context each
  /// call re-reads, so it cannot stand for what a sub-agent cost.
  | { readonly type: "spend"; readonly tokens: number; readonly model?: string }
  /// The sources a research answer was written from, exactly as the provider returned them, for
  /// the assistant message `messageID`. Sent once, after the message has completed and before
  /// the turn ends. Nothing parses sources out of an answer's text instead.
  | { readonly type: "sources"; readonly messageID: string; readonly sources: readonly ResearchSourceRecord[] }
  /// The provider's own diff of the turn, for a workspace with no version control to ask.
  | { readonly type: "diff"; readonly diff: string }
  | { readonly type: "notice"; readonly notice: Notice }
  /// The account's usage limit is spent; the turn stops until it resets, at the time given when
  /// known.
  | { readonly type: "usageLimit"; readonly resetsAt?: ISODate }
  | { readonly type: "modeChanged"; readonly mode: InteractionMode }
  /// The provider's catalog, and with `current` its word on which model is actually serving.
  | { readonly type: "models"; readonly models: readonly ModelOption[]; readonly current?: string }
  | { readonly type: "commands"; readonly commands: readonly SlashCommand[] }
  /// The provider's word on its session-scoped features. Sent whenever the answer changes, so a
  /// control shows what the session does rather than what the chat asked for.
  | { readonly type: "sessionFeatures"; readonly features: SessionFeatures }
  /// A title the provider suggests for the thread. Only ever a fallback.
  | { readonly type: "title"; readonly title: string }
  /// The provider's id for its last message, which a rewind is anchored to.
  | { readonly type: "assistantMessageID"; readonly messageID: string }
  | { readonly type: "turnCompleted"; readonly status: TurnStatus; readonly error?: string }
  /// The provider's process or connection is gone.
  | { readonly type: "exited"; readonly error?: string }
  /// A sub-agent started inside the session, or an existing one was described further.
  | { readonly type: "agentStarted"; readonly spawn: AgentSpawn }
  /// An event from inside a sub-agent's own transcript.
  | { readonly type: "agentEvent"; readonly agentID: string; readonly event: ProviderEvent }
  /// The provider's word on a running sub-agent: a progress note, its last tool, its spend.
  | {
      readonly type: "agentProgress";
      readonly agentID: string;
      readonly summary?: string;
      readonly lastTool?: string;
      readonly tokens?: number;
      readonly toolCalls?: number;
    }
  /// A sub-agent finished, with the provider's summary of its result when it has one.
  | { readonly type: "agentFinished"; readonly agentID: string; readonly status: TurnStatus; readonly summary?: string }
  /// An event this build cannot read: a kind a newer agent sends, or a known kind without the
  /// value it is about. It is kept, with what arrived, rather than dropped or thrown on, so an
  /// older client goes on working and can still say that something reached it.
  | { readonly type: "unknown"; readonly rawType: string; readonly raw: unknown };

/// Every kind this build understands, in the order `ProviderEvent` declares them.
export const PROVIDER_EVENT_TYPES = [
  "sessionReady",
  "turnStarted",
  "messageDelta",
  "messageCompleted",
  "reasoningDelta",
  "reasoningCompleted",
  "toolStarted",
  "toolOutput",
  "toolUpdated",
  "planDelta",
  "planCompleted",
  "todos",
  "approval",
  "question",
  "requestResolved",
  "usage",
  "spend",
  "sources",
  "diff",
  "notice",
  "usageLimit",
  "modeChanged",
  "models",
  "commands",
  "sessionFeatures",
  "title",
  "assistantMessageID",
  "turnCompleted",
  "exited",
  "agentStarted",
  "agentEvent",
  "agentProgress",
  "agentFinished",
] as const satisfies readonly Exclude<ProviderEvent["type"], "unknown">[];

/// The package's own name for the union, for callers who think of it by what it is for.
export type AgentEvent = ProviderEvent;

/// How deep sub-agents inside sub-agents are read. Each level is one call deeper, so input
/// nested without end would otherwise overflow the stack, which is a throw by another name.
const MAX_AGENT_DEPTH = 8;

/// An event from parsed JSON. It never throws and never returns nothing.
///
/// A field with a default takes it: a missing text is empty, a missing optional is absent, a
/// status this build cannot name is `"unknown"`. A kind this build does not know, and a known
/// kind missing the one value it exists to carry (a tool's call, a request, a usage reading, a
/// list), decode as `unknown`. A blank stand-in would be worse than nothing there: an approval
/// with no options, or an empty todo list replacing a real one.
export function decodeProviderEvent(json: unknown, context: DecodeContext = liveDecodeContext): ProviderEvent {
  return decodeEvent(json, context, 0);
}

function decodeEvent(json: unknown, context: DecodeContext, depth: number): ProviderEvent {
  const rawType = isObject(json) ? (readString(json, "type") ?? "") : "";
  const unknown: ProviderEvent = { type: "unknown", rawType, raw: json };
  if (!isObject(json)) return unknown;
  switch (rawType) {
    case "sessionReady":
      return { type: rawType, sessionID: readString(json, "sessionID") ?? "" };
    case "turnStarted":
      return compact({ type: rawType, providerTurnID: readString(json, "providerTurnID") });
    case "messageDelta":
    case "messageCompleted":
    case "reasoningDelta":
    case "reasoningCompleted":
    case "toolOutput":
    case "planDelta":
      return { type: rawType, id: readString(json, "id") ?? "", text: readString(json, "text") ?? "" };
    case "planCompleted":
      return { type: rawType, id: readString(json, "id") ?? "", markdown: readString(json, "markdown") ?? "" };
    case "toolStarted": {
      const call = decodeToolCall(readValue(json, "call"), context);
      return call === undefined ? unknown : { type: rawType, id: readString(json, "id") ?? "", call };
    }
    case "toolUpdated": {
      const update = decodeToolUpdate(readValue(json, "update"));
      return update === undefined ? unknown : { type: rawType, id: readString(json, "id") ?? "", update };
    }
    case "todos": {
      const steps = readList(json, "steps", decodeTodoStep);
      return steps === undefined ? unknown : { type: rawType, steps };
    }
    case "approval": {
      const request = decodeApprovalRequest(readValue(json, "request"));
      return request === undefined ? unknown : { type: rawType, request };
    }
    case "question": {
      const request = decodeQuestionRequest(readValue(json, "request"));
      return request === undefined ? unknown : { type: rawType, request };
    }
    case "requestResolved":
      return { type: rawType, id: readString(json, "id") ?? "" };
    case "usage": {
      const usage = decodeContextUsage(readValue(json, "usage"));
      return usage === undefined ? unknown : { type: rawType, usage };
    }
    case "spend":
      return compact({ type: rawType, tokens: readInt(json, "tokens") ?? 0, model: readString(json, "model") });
    case "sources": {
      const sources = readList(json, "sources", decodeResearchSourceRecord);
      return sources === undefined
        ? unknown
        : { type: rawType, messageID: readString(json, "messageID") ?? "", sources };
    }
    case "diff": {
      const diff = readString(json, "diff");
      return diff === undefined ? unknown : { type: rawType, diff };
    }
    case "notice": {
      const notice = decodeNotice(readValue(json, "notice"));
      return notice === undefined ? unknown : { type: rawType, notice };
    }
    case "usageLimit":
      return compact({ type: rawType, resetsAt: readDate(json, "resetsAt") });
    case "modeChanged":
      return { type: rawType, mode: readCase(json, "mode", INTERACTION_MODES) ?? "unknown" };
    case "models": {
      const models = readList(json, "models", decodeModelOption);
      return models === undefined ? unknown : compact({ type: rawType, models, current: readString(json, "current") });
    }
    case "commands": {
      const commands = readList(json, "commands", decodeSlashCommand);
      return commands === undefined ? unknown : { type: rawType, commands };
    }
    case "sessionFeatures": {
      const features = decodeSessionFeatures(readValue(json, "features"));
      return features === undefined ? unknown : { type: rawType, features };
    }
    case "title": {
      const title = readString(json, "title");
      return title === undefined ? unknown : { type: rawType, title };
    }
    case "assistantMessageID": {
      const messageID = readString(json, "messageID");
      return messageID === undefined ? unknown : { type: rawType, messageID };
    }
    case "turnCompleted":
      // A turn that ended must end here too, so an ending this build cannot name is still one.
      return compact({
        type: rawType,
        status: readCaseOrUnknown(json, "status", TURN_STATUSES),
        error: readString(json, "error"),
      });
    case "exited":
      return compact({ type: rawType, error: readString(json, "error") });
    case "agentStarted": {
      const spawn = decodeAgentSpawn(readValue(json, "spawn"));
      return spawn === undefined ? unknown : { type: rawType, spawn };
    }
    case "agentEvent": {
      const inner = readValue(json, "event");
      if (!isObject(inner) || depth >= MAX_AGENT_DEPTH) return unknown;
      return { type: rawType, agentID: readString(json, "agentID") ?? "", event: decodeEvent(inner, context, depth + 1) };
    }
    case "agentProgress":
      return compact({
        type: rawType,
        agentID: readString(json, "agentID") ?? "",
        summary: readString(json, "summary"),
        lastTool: readString(json, "lastTool"),
        tokens: readInt(json, "tokens"),
        toolCalls: readInt(json, "toolCalls"),
      });
    case "agentFinished":
      return compact({
        type: rawType,
        agentID: readString(json, "agentID") ?? "",
        status: readCaseOrUnknown(json, "status", TURN_STATUSES),
        summary: readString(json, "summary"),
      });
    default:
      return unknown;
  }
}
