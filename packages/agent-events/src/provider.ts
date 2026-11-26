/// The provider-side vocabulary the events and the timeline name: which agent ran, the mode it
/// is in, and the models and commands it offers. Ported from GoSpark's `Shared/Provider.swift`
/// and `Shared/RuntimePhase.swift`; only what an event or a timeline row carries is here.

import {
  type Fields,
  asString,
  compact,
  isObject,
  readBool,
  readInt,
  readStrictList,
  readString,
} from "./coding";

/// Which agent produced something, by GoSpark's `ProviderKind` raw value where GoSpark has one
/// (`claude`, `codex`, `cursor`, `opencode`, `deepseek`, `apple` and so on).
///
/// It is open text, not a closed list. GoSpark's list names the coding CLIs and API providers it
/// drives; Manut AI's agents also include cloud workers and plain chat models, and a closed list
/// would read every one of those as unknown. GoSpark itself keeps the provider as text where a
/// record must survive a build that does not know it (`ResearchSourceRecord.provider`).
export type ProviderKind = string;

/// Whether the agent is building or only planning. A mode a newer agent reports that this build
/// cannot name is kept as `"unknown"`, so the screen can say so instead of showing the last
/// mode it understood.
export const INTERACTION_MODES = ["build", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number] | "unknown";

/// Whether a thread is between turns, opening one, or in one. GoSpark sends it to a paired
/// phone, which decides from it whether Return sends, steers or queues, so the raw values are
/// part of a wire format.
export const RUNTIME_PHASES = ["idle", "starting", "running"] as const;
export type RuntimePhase = (typeof RUNTIME_PHASES)[number];

/// What changing the model, effort or provider cost the open session. `none`: nothing changed.
/// `live`: the next turn carries the new id and the process stays up. `relaunch`: the session
/// restarts and resumes on the same provider. `handoff`: the provider itself changed, so the
/// conversation was handed over as text.
export const SWITCH_KINDS = ["none", "live", "relaunch", "handoff"] as const;
export type SwitchKind = (typeof SWITCH_KINDS)[number];

/// The reasoning ladder, cheapest rung first (`EffortOrder`). Providers name their levels from
/// one vocabulary but do not all list them in the same direction, and a slider reads the list
/// by position, so a descending list would park the cheapest level at the maximum end.
///
/// `xhigh` and `extra-high` are one rung under two spellings and share a rank. `off` and `none`
/// both mean no reasoning at all, the cheapest rung there is.
const EFFORT_RANKS: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  "extra-high": 5,
  max: 6,
};

/// A name this build does not know sorts above every name it does, keeping its place among the
/// other strangers. A provider that adds a rung above `max` therefore lands where it belongs,
/// and one whose levels are named modes rather than a ladder is handed back untouched.
const UNKNOWN_EFFORT_RANK = 7;

function effortRank(effort: string): number {
  const key = effort.toLowerCase();
  return Object.hasOwn(EFFORT_RANKS, key) ? (EFFORT_RANKS[key] ?? UNKNOWN_EFFORT_RANK) : UNKNOWN_EFFORT_RANK;
}

/// The efforts cheapest first. Nothing is ever dropped: a slider writes back by index, so a
/// level missing from the track is a level the person cannot choose. Ties keep the order the
/// provider sent.
export function sortEfforts(efforts: readonly string[]): string[] {
  return efforts
    .map((effort, offset) => ({ effort, offset, rank: effortRank(effort) }))
    .sort((left, right) => (left.rank === right.rank ? left.offset - right.offset : left.rank - right.rank))
    .map((entry) => entry.effort);
}

/// One model a provider offers.
export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  /// Always cheapest first, whatever order the provider listed them in. See `sortEfforts`.
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly isDefault: boolean;
  /// The service tier that makes this model fast, when its provider offers one.
  readonly fastTier?: string;
  /// The model's context window in tokens, where its provider's catalog says.
  readonly contextWindow?: number;
  /// Whether the model takes tools, where its provider's catalog says. Absent means unknown.
  readonly supportsTools?: boolean;
}

/// A model option from JSON. Its id and name are its identity, so an option without either is
/// dropped rather than shown as a blank row nobody could pick. Efforts are sorted on the way in,
/// so a catalog cached before the order existed decodes into it.
export function decodeModelOption(json: unknown): ModelOption | undefined {
  if (!isObject(json)) return undefined;
  const id = readString(json, "id");
  const name = readString(json, "name");
  if (id === undefined || name === undefined) return undefined;
  return compact({
    id,
    name,
    detail: readString(json, "detail"),
    efforts: sortEfforts(readStrictList(json, "efforts", asString) ?? []),
    defaultEffort: readString(json, "defaultEffort"),
    isDefault: readBool(json, "isDefault") ?? false,
    fastTier: readString(json, "fastTier"),
    contextWindow: readInt(json, "contextWindow"),
    supportsTools: readBool(json, "supportsTools"),
  });
}

/// A command the provider offers behind a slash. GoSpark never encodes this type; the keys are
/// its property names.
export interface SlashCommand {
  readonly name: string;
  readonly detail: string;
  readonly isBuiltIn: boolean;
}

/// A slash command from JSON. The name is its identity, so one without a name is dropped.
export function decodeSlashCommand(json: unknown): SlashCommand | undefined {
  if (!isObject(json)) return undefined;
  const name = readString(json, "name");
  if (name === undefined || name.length === 0) return undefined;
  return { name, detail: readString(json, "detail") ?? "", isBuiltIn: readBool(json, "isBuiltIn") ?? false };
}

/// The running session's own word on what it can do and what it is doing, as opposed to what
/// the chat asked for. Today only Claude Code reports one, for its Ultracode mode: a chat can
/// ask for Ultracode and still not have it, because the model does not support it or dynamic
/// workflows are off, so a switch shows this answer rather than the stored request.
///
/// It describes one live process and is gone when that process ends. GoSpark never encodes it;
/// the keys are its property names.
export interface SessionFeatures {
  /// Whether the CLI answered a settings read at all. False means it is too old to report or
  /// switch Ultracode, which the composer explains instead of guessing.
  readonly readsSettings: boolean;
  /// Whether Ultracode can run in this session: workflows are on and the model supports it.
  readonly ultracodeAvailable: boolean;
  /// Whether Ultracode has been asked for, whether or not it can run.
  readonly ultracodeRequested: boolean;
  /// Whether Ultracode is actually on: requested and available.
  readonly ultracodeActive: boolean;
  /// Whether the session's tool list carries the Workflow tool. Absent before the session has
  /// listed its tools.
  readonly workflowsEnabled?: boolean;
  /// Whether typing the ultracode keyword opts a turn into a workflow. Claude Code's own
  /// setting, on unless the person turned it off.
  readonly keywordTriggerEnabled: boolean;
  /// The effort level the session says it is running at. Absent where it reports none.
  readonly appliedEffort?: string;
}

/// Session features from JSON. A field that cannot be read takes the value of a session that
/// cannot report (`SessionFeatures.unsupported`): nothing about Ultracode is known, so none of
/// it is offered, and the keyword trigger keeps Claude Code's default of on.
export function decodeSessionFeatures(json: unknown): SessionFeatures | undefined {
  if (!isObject(json)) return undefined;
  const fields: Fields = json;
  return compact({
    readsSettings: readBool(fields, "readsSettings") ?? false,
    ultracodeAvailable: readBool(fields, "ultracodeAvailable") ?? false,
    ultracodeRequested: readBool(fields, "ultracodeRequested") ?? false,
    ultracodeActive: readBool(fields, "ultracodeActive") ?? false,
    workflowsEnabled: readBool(fields, "workflowsEnabled"),
    keywordTriggerEnabled: readBool(fields, "keywordTriggerEnabled") ?? true,
    appliedEffort: readString(fields, "appliedEffort"),
  });
}
