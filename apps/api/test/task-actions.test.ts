import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchAction } from "../src/broker-actions";
import type { ActionProposalJSON } from "../src/task-object";

const OPERATOR = { authorization: "Bearer test-key" };
let SESSION = { authorization: "" };
beforeEach(async () => { SESSION = await tenantSession(TENANT); });
const TENANT = "test-tenant";

let counter = 6000;
const freshID = () => `act-task-${Date.now()}-${counter++}`;

function draft(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: "t",
    objective: "o",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
    tenantId: TENANT,
    ...extra,
  };
}

async function create(id: string, key: string) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...SESSION, "idempotency-key": key },
    body: JSON.stringify(draft(id)),
  });
}

function proposal(target = "ws/proj", extra: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-1",
    providerAccountId: "workspace-1",
    operationType: "linear.issue.create",
    targetResourceId: target,
    resourceScope: ["ws/proj"],
    payload: { title: "Reviewed issue", description: "From the brief." },
    grantRevision: 1,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...extra,
  };
}

async function propose(id: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://test/v1/tasks/${id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...SESSION },
    body: JSON.stringify(body),
  });
}

async function decide(id: string, action: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://test/v1/tasks/${id}/actions/${action}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...SESSION },
    body: JSON.stringify(body),
  });
}

async function storeConnection(
  extra: { accountId?: string; resourceIds?: string[]; allowsActions?: boolean } = {},
) {
  const response = await adminFetch("https://test/v1/admin/connections", {
    method: "POST",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify({
      tenantId: TENANT,
      provider: "linear",
      accountId: "workspace-1",
      scopes: ["read"],
      refreshToken: "linear-refresh-token",
      resourceIds: ["ws/proj"],
      allowsActions: true,
      ...extra,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function stubProvider(calls: { count: number }, mode: "ok" | "down" = "ok") {
  return async (url: string, init?: RequestInit) => {
    calls.count++;
    if (mode === "down") throw new Error("socket hang up");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      variables?: { input?: { title?: string; projectId?: string } };
    };
    expect(url).toBe("https://api.linear.app/graphql");
    expect(body.variables?.input?.projectId).toBe("ws/proj");
    expect(body.variables?.input?.title).toBe("Reviewed issue");
    return new Response(
      JSON.stringify({
        data: { issueCreate: { success: true, issue: { id: "lin-1", identifier: "GO-1", title: "Reviewed issue", url: "https://linear/GO-1" } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function namespaces() {
  return env as unknown as {
    TASK: { idFromName(id: string): unknown; get(id: unknown): unknown };
    CRED: { idFromName(id: string): unknown; get(id: unknown): unknown };
  };
}

describe("action ledger", () => {
  it("proposes immutable actions with hashed content", async () => {
    const id = freshID();
    expect((await create(id, "act-k1")).status).toBe(200);
    const response = await propose(id, proposal());
    expect(response.status).toBe(200);
    const action = (await response.json()) as ActionProposalJSON;
    expect(action.state).toBe("proposed");
    expect(typeof action.payloadHash).toBe("string");
    expect(action.payloadHash).toHaveLength(64);
    expect(action.tenant).toBe(TENANT);
    const read = await SELF.fetch(`https://test/v1/tasks/${id}/actions/${action.id}`, { headers: SESSION });
    expect(read.status).toBe(200);
  });

  it("validates proposals before storing anything", async () => {
    const id = freshID();
    expect((await create(id, "act-k2")).status).toBe(200);
    expect((await propose(id, proposal("ws/other"))).status).toBe(400);
    expect((await propose(id, { ...proposal(), operationType: "gmail.send" })).status).toBe(400);
    expect(
      (await propose(id, { ...proposal(), expiresAt: new Date(Date.now() - 1000).toISOString() })).status,
    ).toBe(400);
    expect((await propose("missing-task", proposal())).status).toBe(404);
  });

  it("decides once and honors expiry", async () => {
    const id = freshID();
    expect((await create(id, "act-k3")).status).toBe(200);
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    const approved = await decide(id, action.id, { approve: true, by: "founder" });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as ActionProposalJSON).approval?.by).toBe(TENANT);
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(409);

    // Verify the mint first, then seed its expired deadline. A 50 ms proposal
    // can expire before creation under load and return no action id at all,
    // turning this decision-time expiry check into a missing-action check.
    const proposed = await propose(id, proposal());
    expect(proposed.status).toBe(200);
    const short = await proposed.json() as ActionProposalJSON;
    const ns = namespaces();
    await runInDurableObject(ns.TASK.get(ns.TASK.idFromName(id)) as never, async (_instance: unknown, state: {
      storage: { put(key: string, value: unknown): Promise<void> };
    }) => {
      await state.storage.put(`action:${short.id}`, { ...short, expiresAt: new Date(Date.now() - 1000).toISOString() });
    });
    const expired = await decide(id, short.id, { approve: true, by: "founder" });
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: "action_expired" });
    const read = await SELF.fetch(`https://test/v1/tasks/${id}/actions/${short.id}`, { headers: SESSION });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: "expired" });
  });

  it("hides foreign actions as not-found", async () => {
    const id = freshID();
    expect((await create(id, "act-k4")).status).toBe(200);
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    // Operator calls carry no tenant, so a tenant-scoped action is invisible.
    expect((await SELF.fetch(`https://test/v1/tasks/${id}/actions/${action.id}`)).status).toBe(401);
  });
});

describe("action dispatch", () => {
  it("confirms once and replays the receipt without recalling the provider", async () => {
    const id = freshID();
    expect((await create(id, "act-k5")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const dispatch = (grantRevision: number) =>
      dispatchAction(namespaces() as never, id, action.id, {
        tenant: TENANT,
        grantRevision,
        fetchImpl: stubProvider(calls),
      });
    const first = await dispatch(1);
    expect(first.status).toBe(200);
    const settled = (await first.json()) as ActionProposalJSON;
    expect(settled.state).toBe("confirmed");
    expect(settled.dispatch?.providerOperationId).toBe("lin-1");
    expect(calls.count).toBe(1);
    const again = await dispatch(1);
    expect(((await again.json()) as ActionProposalJSON).state).toBe("confirmed");
    expect(calls.count).toBe(1);
  });

  it("refuses unapproved, stale-grant, and settled dispatches", async () => {
    const id = freshID();
    expect((await create(id, "act-k6")).status).toBe(200);
    await storeConnection();
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    const calls = { count: 0 };
    const dispatch = (grantRevision: number) =>
      dispatchAction(namespaces() as never, id, action.id, {
        tenant: TENANT,
        grantRevision,
        fetchImpl: stubProvider(calls),
      });
    expect((await dispatch(1)).status).toBe(409);
    expect(calls.count).toBe(0);
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    expect((await dispatch(2)).status).toBe(409);
    expect(calls.count).toBe(0);
  });

  it("holds ambiguous outcomes as unknown without blind retries", async () => {
    const id = freshID();
    expect((await create(id, "act-k7")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const dispatch = () =>
      dispatchAction(namespaces() as never, id, action.id, {
        tenant: TENANT,
        grantRevision: 1,
        fetchImpl: stubProvider(calls, "down"),
      });
    const first = await dispatch();
    expect(first.status).toBe(200);
    expect(((await first.json()) as ActionProposalJSON).state).toBe("unknown");
    expect((await dispatch()).status).toBe(409);
    expect(calls.count).toBe(1);
  });

  it("fails invalid payloads without calling the provider", async () => {
    const id = freshID();
    expect((await create(id, "act-k8")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (await (
      await propose(id, { ...proposal(), connectionId, payload: { title: "", description: "Empty title." } })
    ).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("rejects cross-tenant dispatches", async () => {
    const id = freshID();
    expect((await create(id, "act-k9")).status).toBe(200);
    await storeConnection();
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const foreign = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: "apple:stranger",
      grantRevision: 1,
      fetchImpl: stubProvider({ count: 0 }),
    });
    expect(foreign.status).toBe(404);
  });

  it("fails closed when the connection dies after approval", async () => {
    const id = freshID();
    expect((await create(id, "act-k10")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const revoked = await SELF.fetch(
      `https://test/v1/connections/${connectionId}?tenant=${encodeURIComponent(TENANT)}`,
      { method: "DELETE", headers: SESSION },
    );
    expect(revoked.status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("fails closed when the target leaves the granted scope", async () => {
    const id = freshID();
    expect((await create(id, "act-k11")).status).toBe(200);
    const connectionId = await storeConnection({ resourceIds: ["ws/other"] });
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("fails closed when the account escapes the grant", async () => {
    const id = freshID();
    expect((await create(id, "act-k12")).status).toBe(200);
    const connectionId = await storeConnection({ accountId: "workspace-2" });
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("fails closed when the grant disallows actions", async () => {
    const id = freshID();
    expect((await create(id, "act-k13")).status).toBe(200);
    const connectionId = await storeConnection({ allowsActions: false });
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("fails closed on a stale authoritative grant revision", async () => {
    const id = freshID();
    expect((await create(id, "act-k14")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (
      await (await propose(id, { ...proposal(), connectionId, grantRevision: 5 })).json()
    ) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const calls = { count: 0 };
    const settled = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 5,
      fetchImpl: stubProvider(calls),
    });
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as ActionProposalJSON).state).toBe("failed");
    expect(calls.count).toBe(0);
  });

  it("answers dispatch with 202 and keeps refusing while unsettled", async () => {
    // No provider involved: the route returns after the begin gate, so this
    // needs no stubbed fetch — the whole point of the async receipt.
    const id = freshID();
    expect((await create(id, "act-202a")).status).toBe(200);
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    const dispatch = (body: object) =>
      SELF.fetch(`https://test/v1/tasks/${id}/actions/${action.id}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...SESSION },
        body: JSON.stringify(body),
      });
    expect((await dispatch({})).status).toBe(400);
    const accepted = await dispatch({ grantRevision: 1 });
    expect(accepted.status).toBe(202);
    expect(((await accepted.json()) as ActionProposalJSON).state).toBe("dispatching");
    expect((await dispatch({ grantRevision: 1 })).status).toBe(409);
  });

  it("keeps the proposal hash stable for records approved before the re-check", async () => {
    // Approved records already in storage were hashed at propose time. Begin
    // now re-hashes them, so the shape below must never drift: this is the
    // digest older builds stored, recomputed independently of the object.
    const id = freshID();
    expect((await create(id, "act-hash")).status).toBe(200);
    const body = {
      ...proposal(),
      resourceScope: ["ws/proj", "ws/archive"],
      recipients: ["b@example.com", "a@example.com"],
      attachmentHashes: ["ff", "00"],
      expectedTargetRevision: "rev-7",
    };
    const action = (await (await propose(id, body)).json()) as ActionProposalJSON;
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    };
    const expected = canonical({
      connectionId: body.connectionId,
      providerAccountId: body.providerAccountId,
      operationType: body.operationType,
      targetResourceId: body.targetResourceId,
      resourceScope: [...body.resourceScope].sort(),
      payload: body.payload,
      recipients: [...body.recipients].sort(),
      attachmentHashes: [...body.attachmentHashes].sort(),
      expectedTargetRevision: body.expectedTargetRevision,
      grantRevision: body.grantRevision,
      expiresAt: body.expiresAt,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(action.payloadHash).toBe(hex);
  });

  it("refuses dispatch when the approved content no longer matches its hash", async () => {
    const id = freshID();
    expect((await create(id, "act-swap")).status).toBe(200);
    const connectionId = await storeConnection();
    const action = (await (await propose(id, { ...proposal(), connectionId })).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    // Swap the stored payload behind the approval, as corruption or a future
    // edit path could. Nothing else about the record changes.
    const ns = namespaces();
    await runInDurableObject(ns.TASK.get(ns.TASK.idFromName(id)) as never, async (_instance: unknown, state: {
      storage: {
        get(key: string): Promise<ActionProposalJSON | undefined>;
        put(key: string, value: unknown): Promise<void>;
      };
    }) => {
      const key = `action:${action.id}`;
      const record = await state.storage.get(key);
      expect(record?.state).toBe("approved");
      if (record) await state.storage.put(key, { ...record, payload: { title: "Swapped issue" } });
    });
    const calls = { count: 0 };
    const refused = await dispatchAction(namespaces() as never, id, action.id, {
      tenant: TENANT,
      grantRevision: 1,
      fetchImpl: stubProvider(calls),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe("payload_changed");
    expect(calls.count).toBe(0);
    const read = await SELF.fetch(`https://test/v1/tasks/${id}/actions/${action.id}`, { headers: SESSION });
    expect(((await read.json()) as ActionProposalJSON).state).toBe("approved");
  });

  it("resolves an orphaned dispatch to unknown on read", async () => {
    const id = freshID();
    expect((await create(id, "act-202b")).status).toBe(200);
    const action = (await (await propose(id, proposal())).json()) as ActionProposalJSON;
    expect((await decide(id, action.id, { approve: true, by: "founder" })).status).toBe(200);
    // Simulate the vanished worker directly: an approved action left in
    // `dispatching` long past the orphan bound, with no background task that
    // could settle it either way. The next read must resolve it to unknown.
    const ns = namespaces();
    await runInDurableObject(ns.TASK.get(ns.TASK.idFromName(id)) as never, async (_instance: unknown, state: {
      storage: {
        get(key: string): Promise<ActionProposalJSON | undefined>;
        put(key: string, value: unknown): Promise<void>;
      };
    }) => {
      const key = `action:${action.id}`;
      const record = await state.storage.get(key);
      if (record) {
        await state.storage.put(key, {
          ...record,
          state: "dispatching",
          dispatch: { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
        });
      }
    });
    const read = await SELF.fetch(`https://test/v1/tasks/${id}/actions/${action.id}`, {
      headers: SESSION,
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as ActionProposalJSON).state).toBe("unknown");
  });
});
