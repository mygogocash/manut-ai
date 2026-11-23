import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  decodeDecision,
  decodeRecord,
  decodeRequest,
  decodeStanding,
  encodeDecision,
  encodeRecord,
  encodeRequest,
  encodeStanding,
  toKnownRequest,
  type ApprovalRequest,
  type SettledDecision,
  type WireRecord,
  type WireStanding,
} from "../src/index";

/// The wire format: what the decoders default, what they keep as unknown, that they never throw,
/// and that an encoded value reads back unchanged, even after a trip through JSON text.

const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const request: ApprovalRequest = {
  id: "r1",
  kind: "public_post",
  options: [
    { id: "yes", label: "Post it", effect: "approve" },
    { id: "no", label: "Not now", effect: "decline" },
  ],
  revision: 3,
  createdAt: 1000,
  turnId: "t1",
  attemptId: "a1",
  expiresAt: 5000,
  detail: { text: "สวัสดี", nested: [1, 2, { ok: true }] },
};

const decision: SettledDecision = {
  requestId: "r1",
  optionId: "yes",
  seenRevision: 3,
  decidedBy: "owner-1",
  role: "owner",
  decidedAt: 2000,
};

describe("request", () => {
  it("round trips every kind, with and without the optional fields", () => {
    for (const kind of APPROVAL_KINDS) {
      const full = decodeRequest(viaJson(encodeRequest({ ...request, kind })));
      expect(full).toEqual({ ...request, kind });
      const { turnId, attemptId, expiresAt, detail, ...bare } = request;
      void turnId; void attemptId; void expiresAt; void detail;
      const minimal = decodeRequest(viaJson(encodeRequest({ ...bare, kind })));
      expect(minimal).toEqual({ ...bare, kind });
      expect(decodeRequest(viaJson(encodeRequest(minimal)))).toEqual(minimal);
    }
  });

  it("takes documented defaults for missing fields", () => {
    expect(decodeRequest({})).toEqual({
      id: "",
      kind: { unknown: true, raw: "" },
      options: [],
      revision: 1,
      createdAt: 0,
    });
  });

  it("treats null stamps as absent and ignores unreadable numbers and text", () => {
    const decoded = decodeRequest({
      id: 7,
      kind: "message",
      turnId: null,
      attemptId: null,
      revision: 0,
      createdAt: "soon",
      expiresAt: Number.NaN,
      detail: null,
      options: "none",
    });
    expect(decoded).toEqual({ id: "", kind: "message", options: [], revision: 1, createdAt: 0 });
    expect(encodeRequest({ ...request, turnId: null, attemptId: null })).not.toHaveProperty("turnId");
  });

  it("keeps an unknown kind and an unknown effect, and writes them back as sent", () => {
    const sent = {
      id: "r2",
      kind: "teleport",
      options: [{ id: "x", label: "Go", effect: "approve_always" }],
      revision: 2,
      createdAt: 5,
    };
    const decoded = decodeRequest(sent);
    expect(decoded.kind).toEqual({ unknown: true, raw: "teleport" });
    expect(decoded.options[0]?.effect).toEqual({ unknown: true, raw: "approve_always" });
    expect(encodeRequest(decoded)).toEqual(sent);
    expect(decodeRequest(encodeRequest(decoded))).toEqual(decoded);
  });

  it("keeps an unreadable option so the option count survives", () => {
    const decoded = decodeRequest({ id: "r", kind: "reply", options: [null, 5, { id: "a", label: "A", effect: "approve" }] });
    expect(decoded.options).toHaveLength(3);
    expect(decoded.options[0]).toEqual({ id: "", label: "", effect: { unknown: true, raw: "" } });
  });

  it("hands the rules only a fully known request", () => {
    expect(toKnownRequest(decodeRequest(viaJson(encodeRequest(request))))).toEqual(request);
    expect(toKnownRequest(decodeRequest({ ...request, kind: "teleport" }))).toBeUndefined();
    expect(
      toKnownRequest(decodeRequest({ ...request, options: [{ id: "a", label: "A", effect: "maybe" }] })),
    ).toBeUndefined();
  });
});

describe("decision", () => {
  it("round trips for both roles", () => {
    for (const role of ["owner", "helper"] as const) {
      const d = { ...decision, role };
      expect(decodeDecision(viaJson(encodeDecision(d)))).toEqual(d);
    }
  });

  it("defaults to a seen revision no request has and never to the owner role", () => {
    expect(decodeDecision({})).toEqual({
      requestId: "",
      optionId: "",
      seenRevision: 0,
      decidedBy: "",
      role: { unknown: true, raw: "" },
      decidedAt: 0,
    });
    expect(decodeDecision({ role: "admin", seenRevision: 1.5 })).toMatchObject({
      role: { unknown: true, raw: "admin" },
      seenRevision: 0,
    });
  });

  it("round trips an unknown role", () => {
    const decoded = decodeDecision({ ...decision, role: "auditor" });
    expect(encodeDecision(decoded)).toMatchObject({ role: "auditor" });
    expect(decodeDecision(encodeDecision(decoded))).toEqual(decoded);
  });
});

describe("record", () => {
  const records: WireRecord[] = [
    { status: "pending", request: decodeRequest(encodeRequest(request)) },
    { status: "decided", request: decodeRequest(encodeRequest(request)), decision: decodeDecision(encodeDecision(decision)) },
    { status: "withdrawn", request: decodeRequest(encodeRequest(request)), withdrawnAt: 4000 },
  ];

  it("round trips each status", () => {
    for (const record of records) {
      expect(decodeRecord(viaJson(encodeRecord(record)))).toEqual(record);
    }
  });

  it("fills a decided record with no readable decision from the decision defaults", () => {
    const decoded = decodeRecord({ status: "decided", request: encodeRequest(request), decision: "x" });
    expect(decoded).toMatchObject({ status: "decided", decision: { requestId: "", seenRevision: 0 } });
  });

  it("defaults a withdrawn time to 0", () => {
    expect(decodeRecord({ status: "withdrawn", request: encodeRequest(request) })).toMatchObject({ withdrawnAt: 0 });
  });

  it("keeps an unknown or missing status instead of guessing pending", () => {
    const sent = { status: "archived", request: encodeRequest(request) };
    const decoded = decodeRecord(sent);
    expect(decoded.status).toEqual({ unknown: true, raw: "archived" });
    expect(encodeRecord(decoded)).toEqual(sent);
    expect(decodeRecord({ request: encodeRequest(request) }).status).toEqual({ unknown: true, raw: "" });
  });
});

describe("standing", () => {
  const standings: WireStanding[] = [
    { state: "open", reason: "waiting" },
    { state: "decided", reason: "decided", decision: decodeDecision(encodeDecision(decision)) },
    { state: "changed", reason: "revised", currentRevision: 4 },
    { state: "superseded", reason: "turn_ended" },
    { state: "superseded", reason: "attempt_ended" },
    { state: "superseded", reason: "withdrawn" },
    { state: "superseded", reason: "not_found" },
    { state: "expired", reason: "expired", expiredAt: 5000 },
  ];

  it("round trips each state and reason", () => {
    for (const standing of standings) {
      expect(decodeStanding(viaJson(encodeStanding(standing)))).toEqual(standing);
    }
  });

  it("keeps an unknown state and an unknown superseded reason", () => {
    const state = decodeStanding({ state: "paused" });
    expect(state).toEqual({ state: { unknown: true, raw: "paused" } });
    expect(encodeStanding(state)).toEqual({ state: "paused" });
    const reason = decodeStanding({ state: "superseded", reason: "moved" });
    expect(reason).toEqual({ state: "superseded", reason: { unknown: true, raw: "moved" } });
    expect(encodeStanding(reason)).toEqual({ state: "superseded", reason: "moved" });
  });

  it("defaults revisions and times", () => {
    expect(decodeStanding({ state: "changed" })).toMatchObject({ currentRevision: 1 });
    expect(decodeStanding({ state: "expired" })).toMatchObject({ expiredAt: 0 });
  });
});

describe("input that is not an object", () => {
  const junk: unknown[] = [undefined, null, 0, 42, "text", true, [], [1, 2], () => 1, Symbol("s")];

  it("never throws and always answers a value", () => {
    for (const input of junk) {
      expect(() => decodeRequest(input)).not.toThrow();
      expect(() => decodeDecision(input)).not.toThrow();
      expect(() => decodeRecord(input)).not.toThrow();
      expect(() => decodeStanding(input)).not.toThrow();
      expect(decodeRequest(input)).toMatchObject({ id: "", revision: 1, options: [] });
      expect(decodeRecord(input).status).toEqual({ unknown: true, raw: "" });
      expect(decodeStanding(input)).toEqual({ state: { unknown: true, raw: "" } });
    }
  });
});
