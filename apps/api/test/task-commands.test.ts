import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";

import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { TaskDocJSON, TaskEventJSON, TaskRecordJSON } from "../src/task-object";

let AUTH = { authorization: "" };
const FIXTURE_TENANT = "apple:command-fixture";
beforeEach(async () => { AUTH = await tenantSession(FIXTURE_TENANT); });

let counter = 2000;
const freshID = () => `cmd-task-${Date.now()}-${counter++}`;

function draft(id: string, overrides: Partial<TaskRecordJSON> = {}): TaskRecordJSON {
  return {
    id,
    title: "Pilot brief",
    objective: "Prepare the morning brief.",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function create(id: string, key: string, body?: TaskRecordJSON) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "idempotency-key": key },
    body: JSON.stringify(body ?? draft(id)),
  });
}

async function command(
  id: string,
  type: string,
  key: string,
  headers: Record<string, string> = {},
  raw?: string,
) {
  return SELF.fetch(`https://test/v1/tasks/${id}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "idempotency-key": key, ...headers },
    body: raw ?? JSON.stringify({ type }),
  });
}

async function put(id: string, body: TaskRecordJSON) {
  return SELF.fetch(`https://test/v1/tasks/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  });
}

async function eventKinds(id: string): Promise<string[]> {
  const response = await SELF.fetch(`https://test/v1/tasks/${id}/events?after=0`, { headers: AUTH });
  expect(response.status).toBe(200);
  const { events } = (await response.json()) as { events: TaskEventJSON[] };
  return events.map((entry) => `${entry.kind}:${entry.via ?? "-"}`);
}

describe("task commands", () => {
  it("queues a draft and records the command", async () => {
    const id = freshID();
    expect((await create(id, "cmd-1")).status).toBe(200);
    const response = await command(id, "queue", "cmd-2");
    expect(response.status).toBe(200);
    const doc = (await response.json()) as TaskDocJSON;
    expect(doc.state).toBe("queued");
    expect(doc.rev).toBe(2);
    expect(await eventKinds(id)).toEqual(["created:put", "state:command:queue"]);
  });

  it("rejects unknown commands without touching the task", async () => {
    const id = freshID();
    expect((await create(id, "cmd-3")).status).toBe(200);
    for (const type of ["complete", "launch", ""]) {
      const response = await command(id, type, `cmd-unknown-${type.length}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error?: string }).error).toBe("unknown_command");
    }
    // No command reaches running, verifying, or completed on its own.
    const doc = (await (
      await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: AUTH })
    ).json()) as TaskDocJSON;
    expect(doc.rev).toBe(1);
  });

  it("refuses commands outside their states", async () => {
    const id = freshID();
    expect((await create(id, "cmd-4")).status).toBe(200);
    const pause = await command(id, "pause", "cmd-5");
    expect(pause.status).toBe(409);
    expect(((await pause.json()) as { error?: string }).error).toBe("illegal_command");
  });

  it("repeats an already-satisfied command without new work", async () => {
    const id = freshID();
    expect((await create(id, "cmd-6")).status).toBe(200);
    expect((await command(id, "queue", "cmd-7")).status).toBe(200);
    const again = await command(id, "queue", "cmd-8");
    expect(again.status).toBe(200);
    expect(((await again.json()) as TaskDocJSON).rev).toBe(2);
    expect(await eventKinds(id)).toEqual(["created:put", "state:command:queue"]);
  });

  it("cancels once, then treats the task as terminal", async () => {
    const id = freshID();
    expect((await create(id, "cmd-9")).status).toBe(200);
    expect((await command(id, "queue", "cmd-10")).status).toBe(200);
    expect((await command(id, "cancel", "cmd-11")).status).toBe(200);
    const again = await command(id, "cancel", "cmd-12");
    expect(again.status).toBe(200);
    const retry = await command(id, "retry", "cmd-13");
    expect(retry.status).toBe(409);
  });

  it("retries failed work and replans paused work", async () => {
    const failed = freshID();
    expect((await create(failed, "cmd-14")).status).toBe(200);
    expect((await command(failed, "queue", "cmd-15")).status).toBe(200);
    expect((await put(failed, draft(failed, { state: "failed" }))).status).toBe(200);
    const retry = await command(failed, "retry", "cmd-16");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as TaskDocJSON).state).toBe("queued");

    const paused = freshID();
    expect((await create(paused, "cmd-17")).status).toBe(200);
    expect((await command(paused, "queue", "cmd-18")).status).toBe(200);
    expect((await put(paused, draft(paused, { state: "running" }))).status).toBe(200);
    expect((await put(paused, draft(paused, { state: "paused" }))).status).toBe(200);
    const replan = await command(paused, "replan", "cmd-19");
    expect(replan.status).toBe(200);
    expect(((await replan.json()) as TaskDocJSON).state).toBe("draft");
  });

  it("fences commands on expected revisions", async () => {
    const id = freshID();
    expect((await create(id, "cmd-20")).status).toBe(200);
    const stale = await command(id, "queue", "cmd-21", { "x-expected-rev": "99" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error?: string }).error).toBe("stale_revision");
    const fresh = await command(id, "queue", "cmd-22", { "x-expected-rev": "1" });
    expect(fresh.status).toBe(200);
  });

  it("replays identical commands and conflicts on reused keys", async () => {
    const id = freshID();
    expect((await create(id, "cmd-23")).status).toBe(200);
    const first = await command(id, "queue", "cmd-24");
    expect(first.status).toBe(200);
    const replay = await command(id, "queue", "cmd-24");
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as TaskDocJSON).rev).toBe(2);
    expect(await eventKinds(id)).toEqual(["created:put", "state:command:queue"]);
    // Same key, different payload: a client bug, not a replay.
    const clash = await command(id, "pause", "cmd-24");
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error?: string }).error).toBe("idempotency_conflict");
  });

  it("requires an idempotency key for commands", async () => {
    const id = freshID();
    expect((await create(id, "cmd-25")).status).toBe(200);
    const response = await SELF.fetch(`https://test/v1/tasks/${id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ type: "queue" }),
    });
    expect(response.status).toBe(400);
  });
});

// Synthetic Apple identities exercise the public Worker route and its verified
// tenant/company assertions, rather than bypassing auth with the operator key.
// This committed keypair is used only by TEST_JWKS_JSON in wrangler.test.json.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

type Session = { accessToken: string; csrf: string; tenant: string };

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derEncode(signature: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset++;
    const value = bytes.slice(offset);
    return value[0]! >= 128 ? new Uint8Array([0, ...value]) : value;
  };
  const half = signature.length / 2;
  const r = integer(signature.slice(0, half));
  const s = integer(signature.slice(half));
  return new Uint8Array([0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

function sessionCall(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
      "x-csrf": session.csrf,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function sessionFor(sub: string): Promise<Session> {
  const nonce = `nonce-${sub}`;
  const now = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("jwk", TEST_PRIVATE_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: "https://appleid.apple.com",
    aud: "test-client",
    sub,
    iat: now - 60,
    exp: now + 600,
    nonce: await sha256Hex(nonce),
  }));
  const signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  const response = await SELF.fetch("https://test/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "apple",
      identityToken: `${header}.${payload}.${base64Url(derEncode(new Uint8Array(signed)))}`,
      nonce,
      deviceId: `device-${sub}`,
    }),
  });
  expect(response.status).toBe(200);
  const session = await response.json() as Session;
  expect((await sessionCall(session, "PUT", "/v1/consent/cloud", { enabled: true })).status).toBe(200);
  return session;
}

async function taskInState(owner: Session, states: string[], companyId?: string): Promise<string> {
  const id = freshID();
  const scope = companyId ? { companyId } : {};
  expect((await sessionCall(owner, "POST", "/v1/tasks", draft(id, scope), { "idempotency-key": `${id}-create` })).status).toBe(200);
  for (const state of states) {
    expect((await sessionCall(owner, "PUT", `/v1/tasks/${id}`, draft(id, { ...scope, state }))).status).toBe(200);
  }
  return id;
}

async function taskSnapshot(owner: Session, id: string) {
  const response = await sessionCall(owner, "GET", `/v1/tasks/${id}`);
  expect(response.status).toBe(200);
  const events = await sessionCall(owner, "GET", `/v1/tasks/${id}/events?after=0`);
  expect(events.status).toBe(200);
  return { doc: await response.json() as TaskDocJSON, events: await events.json() };
}

const COMMAND_CASES = [
  { type: "queue", from: [], to: ["queued"] },
  { type: "pause", from: ["queued", "running"], to: ["queued", "running", "paused"] },
  { type: "cancel", from: [], to: ["cancelled"] },
  { type: "retry", from: ["queued", "failed"], to: ["queued"] },
  { type: "replan", from: ["queued", "running", "paused"], to: [] },
];

describe("task command tenant isolation", () => {
  it.each(COMMAND_CASES)("refuses a foreign $type command without changing the owner's task or events", async ({ type, from }) => {
    const owner = await sessionFor(`owner-${freshID()}`);
    const foreign = await sessionFor(`foreign-${freshID()}`);
    const id = await taskInState(owner, from);
    const before = await taskSnapshot(owner, id);
    const response = await sessionCall(foreign, "POST", `/v1/tasks/${id}/commands`, { type }, { "idempotency-key": `${id}-foreign` });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(await taskSnapshot(owner, id)).toEqual(before);
  });

  it.each(COMMAND_CASES)("refuses a foreign $type no-op without disclosing the task", async ({ type, to }) => {
    const owner = await sessionFor(`owner-${freshID()}`);
    const foreign = await sessionFor(`foreign-${freshID()}`);
    const id = await taskInState(owner, to);
    const before = await taskSnapshot(owner, id);
    const response = await sessionCall(foreign, "POST", `/v1/tasks/${id}/commands`, { type }, { "idempotency-key": `${id}-noop` });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(await taskSnapshot(owner, id)).toEqual(before);
  });

  it.each(COMMAND_CASES)("checks ownership before replaying a $type idempotency key", async ({ type, from }) => {
    const owner = await sessionFor(`owner-${freshID()}`);
    const foreign = await sessionFor(`foreign-${freshID()}`);
    const id = await taskInState(owner, from);
    const headers = { "idempotency-key": `${id}-owner` };
    const applied = await sessionCall(owner, "POST", `/v1/tasks/${id}/commands`, { type }, headers);
    expect(applied.status).toBe(200);
    const appliedDoc = await applied.json();
    const before = await taskSnapshot(owner, id);
    // Neither a cached success nor its conflicting-payload oracle belongs to
    // another tenant. Both answer exactly like a missing task.
    for (const replayType of [type, type === "pause" ? "queue" : "pause"]) {
      const response = await sessionCall(foreign, "POST", `/v1/tasks/${id}/commands`, { type: replayType }, headers);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(await taskSnapshot(owner, id)).toEqual(before);
    }
    const replay = await sessionCall(owner, "POST", `/v1/tasks/${id}/commands`, { type }, headers);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(appliedDoc);
    expect(await taskSnapshot(owner, id)).toEqual(before);
  });

  it.each(COMMAND_CASES)("requires an explicit company scope for a member's $type command", async ({ type, from }) => {
    const owner = await sessionFor(`owner-${freshID()}`);
    const member = await sessionFor(`member-${freshID()}`);
    const companyId = `company-${freshID()}`;
    expect((await adminFetch("https://test/v1/admin/entitlements", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ tenant: owner.tenant, canCreateCompany: true }),
    })).status).toBe(200);
    expect((await sessionCall(owner, "POST", "/v1/companies", { id: companyId, name: "Command isolation", timezone: "Asia/Bangkok" })).status).toBe(200);
    expect((await sessionCall(owner, "POST", `/v1/companies/${companyId}/members`, { tenant: member.tenant, role: "operator" })).status).toBe(200);
    expect((await sessionCall(owner, "POST", `/v1/companies/${companyId}/grants`, { tenant: member.tenant, grants: ["tasks.create"] })).status).toBe(200);
    const id = await taskInState(owner, from, companyId);
    const before = await taskSnapshot(owner, id);
    const headers = { "idempotency-key": `${id}-member` };
    const unscoped = await sessionCall(member, "POST", `/v1/tasks/${id}/commands`, { type }, headers);
    expect(unscoped.status).toBe(404);
    expect(await unscoped.json()).toEqual({ error: "not_found" });
    expect(await taskSnapshot(owner, id)).toEqual(before);
    const scoped = await sessionCall(member, "POST", `/v1/tasks/${id}/commands?company=${companyId}`, { type }, headers);
    expect(scoped.status).toBe(200);
    expect((await scoped.json() as TaskDocJSON).rev).toBe(before.doc.rev + 1);
  });
});
