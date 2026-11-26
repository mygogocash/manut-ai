import { decodeRecord, encodeRecord, encodeStanding } from "@manut/approval-core";
import type { WebAnswer, WebShop } from "../src/api";

// Fixtures for the owner's web app's tests: approval-core's wire records as `GET /v1/approvals` lists them, and the shops
// `POST /v1/web/shops` names. Lifted with the desktop's (apps/desktop/src/runtime/http/testkit.ts) so both apps' readings
// are tested on the same records.

export const T0 = Date.UTC(2026, 10, 24, 3, 0, 0);
export const iso = (ms: number) => new Date(ms).toISOString();

export const OPTIONS = [
  { id: "approve", label: "Approve", effect: "approve" },
  { id: "decline", label: "Decline", effect: "decline" },
];

/// What a LINE reply's request names (`replyRequest` in task-object.ts, `ReplyDetail` in docs/pilot-api.md).
export function replyDetail(id = "action-1", text = "Your order ships tomorrow morning.") {
  return { actionId: id, operationType: "line.message.push", targetResourceId: "bot-user-1", recipient: "U-customer", text, payloadHash: "hash" };
}

export interface ApprovalOver {
  id?: string;
  taskId?: string;
  kind?: string;
  revision?: number;
  status?: string;
  options?: unknown[];
  detail?: unknown;
  createdAt?: number;
  expiresAt?: number;
  attemptId?: string;
  decision?: Record<string, unknown>;
  standing?: Record<string, unknown>;
  passedOn?: Record<string, unknown>;
}

/// One entry of `GET /v1/approvals`, encoded the way the API encodes it. By default a LINE reply waiting for the owner.
export function approvalJson(over: ApprovalOver = {}) {
  const id = over.id ?? "action-1";
  const request = {
    id,
    kind: over.kind ?? "reply",
    options: over.options ?? OPTIONS,
    revision: over.revision ?? 1,
    createdAt: over.createdAt ?? T0 + 90_000,
    expiresAt: over.expiresAt ?? T0 + 24 * 3600_000,
    ...(over.attemptId ? { attemptId: over.attemptId } : {}),
    detail: over.detail ?? replyDetail(id),
  };
  return {
    taskId: over.taskId ?? "task-1",
    record: encodeRecord(decodeRecord({ status: over.status ?? "pending", request, ...(over.decision ? { decision: over.decision } : {}) })),
    standing: over.standing ?? encodeStanding({ state: "open", reason: "waiting" }),
    ...(over.passedOn ? { passedOn: over.passedOn } : {}),
  };
}

export function listing(state: "open" | "recent", ...approvals: unknown[]): WebAnswer {
  return { status: 200, body: { state, approvals } };
}

export const OWNED: WebShop = { id: "pilot:baan-mali", name: "Baan Mali", ownerName: "Fon", role: "owner", you: "owner-fon", ready: true };
export const HELPED: WebShop = { id: "pilot:khao-soi", name: "Khao Soi Nimman", ownerName: "Lek", role: "helper", you: "helper-noi",
  ready: true };

/// A decision the API settled, as approval-core's wire JSON carries it.
export function decided(over: Record<string, unknown> = {}) {
  return { requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "helper-mint", role: "helper", decidedAt: T0 + 300_000, ...over };
}
