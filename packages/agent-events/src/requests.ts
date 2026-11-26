/// What an agent asks a person: permission before it acts, or an answer to a question. Ported
/// from GoSpark's `Shared/Requests.swift`. Both cross GoSpark's wire to a paired phone, which
/// renders them and sends an option id back, so the raw values below are protocol: renaming a
/// case changes what an older client understands.
///
/// These are the agent's own requests, one layer under `@manut/approval-core`. That package
/// decides who may settle a request and whether a decision still stands; this one only says
/// what was asked and where.

import {
  type UUID,
  compact,
  isObject,
  readBool,
  readCase,
  readInt,
  readList,
  readString,
  readUUID,
} from "./coding";

export const APPROVAL_KINDS = ["command", "fileChange", "tool", "permissions", "plan"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/// A kind this build has never heard of is still a request to do something, so it is shown with
/// the most general wording rather than dropped.
export const APPROVAL_KIND_FALLBACK: ApprovalKind = "tool";

export const APPROVAL_ROLES = ["approve", "approveAlways", "decline", "cancel"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

/// The one fallback in this file that is a security decision. An option whose role this build
/// cannot read is treated as declining, so a newer agent can never talk an older client into
/// approving something by naming a role it invented.
export const APPROVAL_ROLE_FALLBACK: ApprovalRole = "decline";

export interface ApprovalOption {
  readonly id: string;
  readonly title: string;
  readonly role: ApprovalRole;
}

/// An agent asking for permission before it acts.
export interface ApprovalRequest {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly options: readonly ApprovalOption[];
  /// The timeline row this request is about: the tool call it would allow, or the plan it
  /// would start on.
  readonly toolItemID?: string;
  /// For a plan request, the revision of the plan its `toolItemID` names, stamped as the
  /// request arrives. Approving it approves that revision only. Absent for every other kind,
  /// for a plan the timeline does not hold, and on a request from before revisions, which reads
  /// as revision 1.
  readonly planRevision?: number;
  /// The turn the request arrived in, stamped by the runtime as it arrives. A decision on it is
  /// refused once another turn is running, so a click on what an ended turn asked never decides
  /// anything in a later one, even when the agent reuses the request's id. Absent for a request
  /// that arrived between turns, and an absent stamp never blocks.
  readonly turnID?: UUID;
  /// The task attempt that was running when the request arrived. A decision on it is refused
  /// once another attempt is running. Absent outside a task, and an absent stamp never blocks.
  readonly attemptID?: UUID;
}

export function decodeApprovalOption(json: unknown): ApprovalOption | undefined {
  if (!isObject(json)) return undefined;
  return {
    id: readString(json, "id") ?? "",
    title: readString(json, "title") ?? "",
    role: readCase(json, "role", APPROVAL_ROLES) ?? APPROVAL_ROLE_FALLBACK,
  };
}

/// An approval request from JSON. `undefined` only when the value is not an object at all.
export function decodeApprovalRequest(json: unknown): ApprovalRequest | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    id: readString(json, "id") ?? "",
    kind: readCase(json, "kind", APPROVAL_KINDS) ?? APPROVAL_KIND_FALLBACK,
    title: readString(json, "title") ?? "",
    detail: readString(json, "detail"),
    reason: readString(json, "reason"),
    options: readList(json, "options", decodeApprovalOption) ?? [],
    toolItemID: readString(json, "toolItemID"),
    planRevision: readInt(json, "planRevision"),
    turnID: readUUID(json, "turnID"),
    attemptID: readUUID(json, "attemptID"),
  });
}

export interface QuestionChoice {
  readonly label: string;
  readonly detail?: string;
}

export interface Question {
  readonly id: string;
  readonly header: string;
  readonly prompt: string;
  readonly choices: readonly QuestionChoice[];
  readonly allowsMultiple: boolean;
  readonly allowsOther: boolean;
  readonly isSecret: boolean;
}

/// An agent asking the person to choose or type an answer.
export interface QuestionRequest {
  readonly id: string;
  readonly questions: readonly Question[];
  /// The turn the question arrived in, with the same rule as `ApprovalRequest.turnID`.
  readonly turnID?: UUID;
  /// The task attempt the question arrived in, with the same rule as `ApprovalRequest.attemptID`.
  readonly attemptID?: UUID;
}

export function decodeQuestionChoice(json: unknown): QuestionChoice | undefined {
  if (!isObject(json)) return undefined;
  return compact({ label: readString(json, "label") ?? "", detail: readString(json, "detail") });
}

export function decodeQuestion(json: unknown): Question | undefined {
  if (!isObject(json)) return undefined;
  return {
    id: readString(json, "id") ?? "",
    header: readString(json, "header") ?? "",
    prompt: readString(json, "prompt") ?? "",
    choices: readList(json, "choices", decodeQuestionChoice) ?? [],
    allowsMultiple: readBool(json, "allowsMultiple") ?? false,
    allowsOther: readBool(json, "allowsOther") ?? false,
    isSecret: readBool(json, "isSecret") ?? false,
  };
}

/// A question request from JSON. `undefined` only when the value is not an object at all.
export function decodeQuestionRequest(json: unknown): QuestionRequest | undefined {
  if (!isObject(json)) return undefined;
  return compact({
    id: readString(json, "id") ?? "",
    questions: readList(json, "questions", decodeQuestion) ?? [],
    turnID: readUUID(json, "turnID"),
    attemptID: readUUID(json, "attemptID"),
  });
}
