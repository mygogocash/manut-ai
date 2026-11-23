import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";

import { describe, expect, it } from "vitest";

// Company-scoped tasks and the exact-action binding. Each test mints its own
// users (Apple subjects) so the shared AuthObject never leaks state between
// tests; company ids are unique per test for the same reason.

const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = "test-key";
const NONCE = "task-company-nonce";
const T = (sub: string) => `apple:${sub}`;

let counter = 31000;
const freshCompany = () => `tc-${Date.now()}-${counter++}`;
let taskCounter = 71000;
const freshTask = () => `task-tc-${Date.now()}-${taskCounter++}`;
let keyCounter = 91000;
const freshKey = () => `key-tc-${Date.now()}-${keyCounter++}`;

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const strip = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const cut = part.slice(i);
    return cut[0]! >= 128 ? new Uint8Array([0, ...cut]) : cut;
  };
  const rEnc = strip(r);
  const sEnc = strip(s);
  const out = new Uint8Array(2 + 2 + rEnc.length + 2 + sEnc.length);
  out[0] = 0x30;
  out[1] = out.length - 2;
  out[2] = 0x02;
  out[3] = rEnc.length;
  out.set(rEnc, 4);
  out[4 + rEnc.length] = 0x02;
  out[5 + rEnc.length] = sEnc.length;
  out.set(sEnc, 6 + rEnc.length);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Session = { token: string; csrf: string };

async function sessionFor(sub: string, device: string): Promise<Session> {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "test-client",
      sub,
      iat: now - 60,
      exp: now + 600,
      nonce: await sha256Hex(NONCE),
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const half = signature.length / 2;
  const token = `${header}.${payload}.${base64Url(derEncode(signature.slice(0, half), signature.slice(half)))}`;
  const response = await SELF.fetch("https://test/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken: token, nonce: NONCE, deviceId: device }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { accessToken: string; csrf: string };
  return { token: session.accessToken, csrf: session.csrf };
}

function op(method: string, path: string, body?: unknown) {
  const fetch = path.startsWith("/v1/admin/") ? adminFetch : SELF.fetch.bind(SELF);
  return fetch(`https://test${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function call(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function co(session: Session, method: string, path: string, body?: unknown) {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      "x-csrf": session.csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function consent(session: Session) {
  const response = await call(session, "PUT", "/v1/consent/cloud", { enabled: true });
  expect(response.status).toBe(200);
}

async function world(ownerSub: string, name: string) {
  await op("PUT", "/v1/admin/entitlements", { tenant: T(ownerSub), canCreateCompany: true });
  const owner = await sessionFor(ownerSub, `dev-${ownerSub}`);
  await consent(owner);
  const id = freshCompany();
  const created = await co(owner, "POST", "/v1/companies", { id, name, timezone: "Asia/Bangkok" });
  expect(created.status).toBe(200);
  return { owner, id };
}

async function addMember(owner: Session, companyId: string, sub: string, role: string, grants: string[]) {
  const added = await co(owner, "POST", `/v1/companies/${companyId}/members`, { tenant: T(sub), role });
  expect(added.status).toBe(200);
  const member = await sessionFor(sub, `dev-${sub}`);
  await consent(member);
  if (grants.length > 0) {
    const granted = await co(owner, "POST", `/v1/companies/${companyId}/grants`, {
      tenant: T(sub),
      grants,
    });
    expect(granted.status).toBe(200);
  }
  return member;
}

function draft(id: string, companyId?: string) {
  return {
    id,
    title: "t",
    objective: "o",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
    ...(companyId ? { companyId } : {}),
  };
}

function createTask(session: Session, id: string, companyId?: string) {
  return call(session, "POST", "/v1/tasks", draft(id, companyId), { "idempotency-key": freshKey() });
}

function proposal(extra: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-tc",
    providerAccountId: "workspace-1",
    operationType: "linear.issue.create",
    targetResourceId: "ws/proj",
    resourceScope: ["ws/proj"],
    payload: { title: "Reviewed issue" },
    grantRevision: 1,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...extra,
  };
}

describe("company-scoped tasks", () => {
  it.each(["commands", "claim", "heartbeat", "steps", "finish"])(
    "a viewer cannot write %s, even with company membership and a valid attempt token",
    async (action) => {
      const { owner, id } = await world(`tc-write-owner-${action}`, "Write boundary");
      const viewer = await addMember(owner, id, `tc-write-viewer-${action}`, "viewer", []);
      const taskId = freshTask();
      expect((await createTask(owner, taskId, id)).status).toBe(200);
      const claim = await call(owner, "POST", `/v1/tasks/${taskId}/attempts`, {
        executorId: "owner", inputRevision: "r",
      });
      expect(claim.status).toBe(200);
      const attempt = await claim.json() as { id: string; fence: unknown };
      const path = action === "commands" ? "commands"
        : action === "claim" ? "attempts" : `attempts/${attempt.id}/${action}`;
      const body = action === "commands" ? { type: "queue" }
        : action === "claim" ? { executorId: "viewer", inputRevision: "r" }
        : { fence: attempt.fence, outcome: "done", step: { id: "s", name: "s", status: "done" } };
      const response = await call(viewer, "POST", `/v1/tasks/${taskId}/${path}?company=${id}`, body, {
        "idempotency-key": freshKey(), "x-company-writer": id,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "grant_required" });
      expect((await call(viewer, "GET", `/v1/tasks/${taskId}?company=${id}`)).status).toBe(200);
    },
  );

  it.each([["operator", "tasks.create"], ["approver", "approvals.decide"]])(
    "an explicitly granted %s can write company attempts",
    async (role, grant) => {
      const { owner, id } = await world(`tc-write-allowed-${role}`, "Granted boundary");
      const member = await addMember(owner, id, `tc-write-member-${role}`, role, [grant]);
      const taskId = freshTask();
      expect((await createTask(owner, taskId, id)).status).toBe(200);
      const claimed = await call(member, "POST", `/v1/tasks/${taskId}/attempts?company=${id}`, {
        executorId: role, inputRevision: "r",
      });
      expect(claimed.status).toBe(200);
      const attempt = await claimed.json() as { id: string; fence: unknown };
      for (const action of ["heartbeat", "steps", "finish"]) {
        const response = await call(member, "POST", `/v1/tasks/${taskId}/attempts/${attempt.id}/${action}?company=${id}`, {
          fence: attempt.fence, outcome: "done", step: { id: "s", name: "s", status: "done" },
        });
        expect(response.status).toBe(200);
      }
      expect((await call(member, "POST", `/v1/tasks/${taskId}/commands?company=${id}`, { type: "queue" }, {
        "idempotency-key": freshKey(),
      })).status).toBe(200);
    },
  );

  it("a creator whose company grant was revoked cannot omit the company hint to write", async () => {
    const { owner, id } = await world("tc-write-revoked-owner", "Revoked boundary");
    const creator = await addMember(owner, id, "tc-write-revoked-creator", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(creator, taskId, id)).status).toBe(200);
    expect((await co(owner, "POST", `/v1/companies/${id}/grants`, {
      tenant: T("tc-write-revoked-creator"), grants: [],
    })).status).toBe(200);
    const response = await call(creator, "POST", `/v1/tasks/${taskId}/commands`, { type: "queue" }, {
      "idempotency-key": freshKey(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "grant_required" });
    expect((await call(creator, "GET", `/v1/tasks/${taskId}`)).status).toBe(200);
  });

  it("creating a company task needs membership and the tasks.create grant", async () => {
    const { owner, id } = await world("tc-owner-1", "Task Co 1");
    const outsider = await sessionFor("tc-out-1", "dev-out");
    await consent(outsider);
    expect((await createTask(outsider, freshTask(), id)).status).toBe(403);
    const member = await addMember(owner, id, "tc-member-1", "operator", []);
    expect((await createTask(member, freshTask(), id)).status).toBe(403);
  });

  it("a granted member creates tasks stamped to the verified company", async () => {
    const { owner, id } = await world("tc-owner-2", "Task Co 2");
    const member = await addMember(owner, id, "tc-member-2", "operator", ["tasks.create"]);
    const taskId = freshTask();
    const response = await createTask(member, taskId, id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { companyId?: string }).companyId).toBe(id);
  });

  it("tasks outside any company keep tenant-only behavior", async () => {
    const owner = await sessionFor("tc-owner-2b", "dev-1");
    await consent(owner);
    const taskId = freshTask();
    const response = await createTask(owner, taskId);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { companyId?: string }).companyId).toBeUndefined();
  });

  it("fellow members read company tasks through the company hint, never without", async () => {
    const { owner, id } = await world("tc-owner-3", "Task Co 3");
    const member = await addMember(owner, id, "tc-member-3", "viewer", []);
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    expect((await call(member, "GET", `/v1/tasks/${taskId}`)).status).toBe(404);
    const hinted = await call(member, "GET", `/v1/tasks/${taskId}?company=${id}`);
    expect(hinted.status).toBe(200);
    expect(((await hinted.json()) as { id: string }).id).toBe(taskId);
    // A hint for the wrong company opens nothing.
    const { id: other } = await world("tc-owner-3b", "Task Co 3b");
    const wrong = await call(member, "GET", `/v1/tasks/${taskId}?company=${other}`);
    expect(wrong.status).toBe(403);
  });

  it("the company scope is immutable once set and unverified scope is refused", async () => {
    const { owner, id } = await world("tc-owner-4", "Task Co 4");
    const member = await addMember(owner, id, "tc-member-4", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const { id: other } = await world("tc-owner-4b", "Task Co 4b");
    // Joining the second company still cannot move the task: the scope is
    // immutable once set.
    const ownerB = await sessionFor("tc-owner-4b", "dev-4b");
    expect((await co(ownerB, "POST", `/v1/companies/${other}/members`, { tenant: T("tc-member-4"), role: "operator" })).status).toBe(200);
    expect((await co(ownerB, "POST", `/v1/companies/${other}/grants`, { tenant: T("tc-member-4"), grants: ["tasks.create"] })).status).toBe(200);
    const moved = await call(member, "PUT", `/v1/tasks/${taskId}`, {
      ...draft(taskId, other),
    });
    expect(moved.status).toBe(409);
    // Stripping the company by omission preserves it: scope is sticky and
    // only a verified assertion can move it.
    const stripped = await call(member, "PUT", `/v1/tasks/${taskId}`, { ...draft(taskId) });
    expect(stripped.status).toBe(200);
    expect(((await stripped.json()) as { companyId?: string }).companyId).toBe(id);
    // An explicit null is a self-asserted scope change, not an omission.
    const nulled = await call(member, "PUT", `/v1/tasks/${taskId}`, { ...draft(taskId), companyId: null });
    expect(nulled.status).toBe(400);
    // Adopting a company-less task takes membership plus the grant.
    const orphan = freshTask();
    expect((await createTask(member, orphan)).status).toBe(200);
    const adopted = await call(member, "PUT", `/v1/tasks/${orphan}`, { ...draft(orphan, id) });
    expect(adopted.status).toBe(200);
    expect(((await adopted.json()) as { companyId?: string }).companyId).toBe(id);
  });

  it("members act on company tasks through the hint: events and commands", async () => {
    const { owner, id } = await world("tc-owner-5", "Task Co 5");
    const member = await addMember(owner, id, "tc-member-5", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    expect((await call(member, "GET", `/v1/tasks/${taskId}/events`)).status).toBe(404);
    expect((await call(member, "GET", `/v1/tasks/${taskId}/events?company=${id}`)).status).toBe(200);
    const queued = await call(member, "POST", `/v1/tasks/${taskId}/commands?company=${id}`, { type: "queue" }, { "idempotency-key": freshKey() });
    expect(queued.status).toBe(200);
  });
});

describe("company-bound exact actions", () => {
  async function taskWithProposal(ownerSub: string, memberSub: string, extra: Record<string, unknown> = {}) {
    const { owner, id } = await world(ownerSub, `Action ${ownerSub}`);
    const member = await addMember(owner, id, memberSub, "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const proposed = await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal(extra));
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string; grantRevision: number };
    return { owner, member, id, taskId, action };
  }

  it("a viewer cannot dispatch a company action or spend its approval", async () => {
    const { owner, id, taskId, action } = await taskWithProposal("tc-dispatch-owner", "tc-dispatch-creator");
    const viewer = await addMember(owner, id, "tc-dispatch-viewer", "viewer", []);
    const response = await call(viewer, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "grant_required" });
    const read = await call(viewer, "GET", `/v1/tasks/${taskId}/actions/${action.id}?company=${id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: "proposed" });
  });

  it("proposals stamp the live grant revision and need the grant", async () => {
    const { owner, id } = await world("tc-owner-6", "Action Co 6");
    const member = await addMember(owner, id, "tc-member-6", "viewer", []);
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    // Viewer membership alone cannot propose.
    expect((await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal())).status).toBe(403);
    // A forged revision is overwritten with the authority's own.
    const operator = await addMember(owner, id, "tc-op-6", "operator", ["tasks.create"]);
    const authority = (await (await co(owner, "GET", `/v1/companies/${id}`)).json()) as {
      grantRevision: number;
    };
    const proposed = await call(operator, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal({ grantRevision: 999 }));
    expect(proposed.status).toBe(200);
    expect(((await proposed.json()) as { grantRevision: number }).grantRevision).toBe(authority.grantRevision);
  });

  it("approving needs the decide grant; rejecting needs membership", async () => {
    const { member, id, taskId, action } = await taskWithProposal("tc-owner-7", "tc-member-7");
    // Operator holds tasks.create but not approvals.decide.
    const denied = await call(member, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "anyone",
    });
    expect(denied.status).toBe(403);
    // Rejection stays open to members.
    const rejected = await call(member, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: false,
      by: "anyone",
    });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { state: string }).state).toBe("rejected");
  });

  it("an entitled approver decides and the approval records them", async () => {
    const { owner, id, taskId, action } = await taskWithProposal("tc-owner-8", "tc-member-8");
    const approver = await addMember(owner, id, "tc-approver-8", "approver", ["approvals.decide"]);
    const decided = await call(approver, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "self-attested-name",
    });
    expect(decided.status).toBe(200);
    const body = (await decided.json()) as { state: string; approval: { by: string } };
    expect(body.state).toBe("approved");
    // Identity comes from the verified session, never the self-attested body.
    expect(body.approval.by).toBe(T("tc-approver-8"));
  });

  it("dispatch after grant revocation refuses with no provider call", async () => {
    const { owner, id, taskId, action } = await taskWithProposal("tc-owner-9", "tc-member-9");
    const approver = await addMember(owner, id, "tc-approver-9", "approver", ["approvals.decide"]);
    const decided = await call(approver, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "x",
    });
    expect(decided.status).toBe(200);
    // Revoking the approver's grant bumps the company revision...
    const revoked = await co(owner, "POST", `/v1/companies/${id}/grants`, {
      tenant: T("tc-approver-9"),
      grants: [],
    });
    expect(revoked.status).toBe(200);
    // ...so the bound approval no longer dispatches.
    const dispatched = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
    });
    expect(dispatched.status).toBe(409);
    expect(((await dispatched.json()) as { error: string }).error).toBe("grant_changed");
    // And the approval itself is still unspent, not half-dispatched.
    const reread = await call(owner, "GET", `/v1/tasks/${taskId}/actions/${action.id}?company=${id}`);
    expect(((await reread.json()) as { state: string }).state).toBe("approved");
  });

  it("dispatching an undecided company action answers from the begin gate", async () => {
    const { owner, id, taskId, action } = await taskWithProposal("tc-owner-9b", "tc-member-9b");
    const dispatched = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
    });
    expect(dispatched.status).toBe(409);
    expect(((await dispatched.json()) as { error: string }).error).toBe("not_approved");
  });

  it("a bound target revision must still match at dispatch", async () => {
    const { owner, id, taskId } = await (async () => {
      const { owner, id } = await world("tc-owner-10", "Action Co 10");
      const member = await addMember(owner, id, "tc-member-10", "operator", ["tasks.create"]);
      const approver = await addMember(owner, id, "tc-approver-10", "approver", ["approvals.decide"]);
      const taskId = freshTask();
      expect((await createTask(member, taskId, id)).status).toBe(200);
      return { owner, member, approver, id, taskId };
    })();
    const proposed = await call(owner, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal({ expectedTargetRevision: "rev-1" }));
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string; grantRevision: number };
    const approver = await sessionFor("tc-approver-10", "dev-tc-approver-10");
    const decided = await call(approver, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "x",
    });
    expect(decided.status).toBe(200);
    const missing = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
    });
    expect(missing.status).toBe(400);
    const stale = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
      currentTargetRevision: "rev-2",
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("target_changed");
    // Matching revision is accepted for dispatch (202); the broker then
    // settles without a connection, never reaching a provider.
    const accepted = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
      currentTargetRevision: "rev-1",
    });
    expect(accepted.status).toBe(202);
  });

  it("a member of another company cannot propose on this company's tasks", async () => {
    const { owner, id } = await world("tc-owner-11", "Action Co 11");
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const { owner: ownerB } = await world("tc-owner-11b", "Action Co 11b");
    void ownerB;
    const bob = await sessionFor("tc-owner-11b", "dev-tc-owner-11b");
    expect((await call(bob, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal())).status).toBe(403);
  });
});

describe("company task list and templates", () => {
  it("members page through the company task list with cursors", async () => {
    const { owner, id } = await world("tc-owner-12", "List Co 12");
    const member = await addMember(owner, id, "tc-member-12", "viewer", []);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const taskId = freshTask();
      ids.push(taskId);
      expect((await createTask(owner, taskId, id)).status).toBe(200);
    }
    const first = (await (
      await call(member, "GET", `/v1/companies/${id}/tasks?limit=2`)
    ).json()) as { tasks: { id: string; unavailable?: boolean }[]; nextCursor: string | null; total: number };
    expect(first.tasks.length).toBe(2);
    expect(first.total).toBe(3);
    expect(typeof first.nextCursor).toBe("string");
    // Fellow members resolve full documents, not unavailable stubs.
    expect(first.tasks.every((t) => !t.unavailable)).toBe(true);
    const second = (await (
      await call(member, "GET", `/v1/companies/${id}/tasks?limit=2&cursor=${first.nextCursor}`)
    ).json()) as { tasks: { id: string }[]; nextCursor: string | null; total: number };
    expect(second.tasks.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(second.tasks.map((t) => t.id).sort()).toEqual(ids.slice(2));
    const bad = await call(member, "GET", `/v1/companies/${id}/tasks?cursor=nope`);
    expect(bad.status).toBe(400);
    // Non-members get the authority's refusal, not a list.
    const outsider = await sessionFor("tc-out-12", "dev-out");
    expect((await call(outsider, "GET", `/v1/companies/${id}/tasks`)).status).toBe(403);
  });

  it("template export carries structure only; import restores no authority", async () => {
    const { owner, id } = await world("tc-owner-13", "Template Co 13");
    await addMember(owner, id, "tc-member-13", "operator", ["tasks.create"]);
    await addMember(owner, id, "tc-approver-13", "approver", ["approvals.decide"]);
    const exported = await co(owner, "GET", `/v1/companies/${id}/template`);
    expect(exported.status).toBe(200);
    const template = (await exported.json()) as {
      version: number;
      company: { name: string; timezone: string };
      roles: string[];
    };
    expect(template.version).toBe(1);
    expect(template.company.name).toBe("Template Co 13");
    expect(template.roles.sort()).toEqual(["approver", "operator", "owner"]);
    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain("tc-member-13");
    expect(serialized).not.toContain("tasks.create");
    // Import needs the entitlement like creation.
    const importer = await sessionFor("tc-importer-13", "dev-imp");
    await consent(importer);
    expect((await co(importer, "POST", "/v1/companies/import-template", { template })).status).toBe(403);
    await op("PUT", "/v1/admin/entitlements", { tenant: T("tc-importer-13"), canCreateCompany: true });
    const bad = await co(importer, "POST", "/v1/companies/import-template", {
      template: { version: 1, company: { name: "x" }, roles: ["superadmin"] },
    });
    expect(bad.status).toBe(400);
    const imported = await co(importer, "POST", "/v1/companies/import-template", {
      template,
      name: "Template Co 13 Copy",
    });
    expect(imported.status).toBe(200);
    const body = (await imported.json()) as {
      company: { id: string; name: string };
      membership: { role: string };
      grants: string[];
    };
    expect(body.company.name).toBe("Template Co 13 Copy");
    expect(body.membership.role).toBe("owner");
    expect(body.grants).toContain("company.delete");
    // The old members hold nothing in the new company.
    const old = await sessionFor("tc-member-13", "dev-old");
    expect((await call(old, "GET", `/v1/companies/${body.company.id}`)).status).toBe(403);
  });
});

describe("event wait long-poll", () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("returns immediately when events already exist", async () => {
    const { owner, id } = await world("tc-owner-16", "Wait Co 16");
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const wait = await call(owner, "GET", `/v1/tasks/${taskId}/events/wait?after=0&timeoutMs=5000`);
    expect(wait.status).toBe(200);
    const body = (await wait.json()) as { events: unknown[]; waitedMs: number };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.waitedMs).toBeLessThan(3000);
  });

  it("times out empty and delivers events published mid-wait", async () => {
    const { owner, id } = await world("tc-owner-17", "Wait Co 17");
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const tip = ((await (await call(owner, "GET", `/v1/tasks/${taskId}/events`)).json()) as { tip: number }).tip;
    const waiting = call(owner, "GET", `/v1/tasks/${taskId}/events/wait?after=${tip}&timeoutMs=8000`);
    await delay(300);
    const queued = await call(owner, "POST", `/v1/tasks/${taskId}/commands`, { type: "queue" }, { "idempotency-key": freshKey() });
    expect(queued.status).toBe(200);
    const delivered = (await (await waiting).json()) as { events: { seq: number }[]; tip: number };
    expect(delivered.events.length).toBeGreaterThan(0);
    expect(delivered.events.every((e) => e.seq > tip)).toBe(true);
  });

  it("empty waits end at the timeout with the tip", async () => {
    const { owner, id } = await world("tc-owner-18", "Wait Co 18");
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const tip = ((await (await call(owner, "GET", `/v1/tasks/${taskId}/events`)).json()) as { tip: number }).tip;
    const started = Date.now();
    const wait = await call(owner, "GET", `/v1/tasks/${taskId}/events/wait?after=${tip}&timeoutMs=600`);
    expect(wait.status).toBe(200);
    const body = (await wait.json()) as { events: unknown[]; tip: number; waitedMs: number };
    expect(body.events).toEqual([]);
    expect(body.tip).toBe(tip);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("non-members cannot wait on company tasks and cursors validate", async () => {
    const { owner, id } = await world("tc-owner-19", "Wait Co 19");
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const outsider = await sessionFor("tc-out-19", "dev-out");
    // No scope named: the task does not exist for the outsider (no oracle).
    expect((await call(outsider, "GET", `/v1/tasks/${taskId}/events/wait?after=0`)).status).toBe(404);
    // A named scope the outsider does not belong to is refused as forbidden.
    expect((await call(outsider, "GET", `/v1/tasks/${taskId}/events/wait?after=0&company=${id}`)).status).toBe(403);
    expect((await call(owner, "GET", `/v1/tasks/${taskId}/events/wait?after=nope`)).status).toBe(400);
  });
});
describe("company deletion and tenant wipe lifecycle", () => {
  it("deleting a company releases its tasks back to tenant isolation", async () => {
    const { owner, id } = await world("tc-owner-14", "Detach Co 14");
    const member = await addMember(owner, id, "tc-member-14", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const deleted = await co(owner, "DELETE", `/v1/companies/${id}`);
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { detached: string[]; detachFailed: string[] };
    expect(body.detached).toEqual([taskId]);
    expect(body.detachFailed).toEqual([]);
    // The creator still reads her task under tenant isolation, now
    // company-less; the company scope no longer resolves for anyone.
    const reread = (await (await call(member, "GET", `/v1/tasks/${taskId}`)).json()) as {
      companyId?: string;
    };
    expect(reread.companyId).toBeUndefined();
    expect((await call(member, "GET", `/v1/tasks/${taskId}?company=${id}`)).status).toBe(404);
  });

  it("tenant wipe prunes the wiped tasks out of surviving company lists", async () => {
    const { owner, id } = await world("tc-owner-15", "Wipe Co 15");
    const member = await addMember(owner, id, "tc-member-15", "viewer", []);
    const taskId = freshTask();
    expect((await createTask(owner, taskId, id)).status).toBe(200);
    const wipe = await SELF.fetch("https://test/v1/tenant/data", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(wipe.status).toBe(200);
    const report = (await wipe.json()) as { companyIndexPruned: string[]; companyIndexFailed: string[] };
    expect(report.companyIndexPruned).toEqual([id]);
    expect(report.companyIndexFailed).toEqual([]);
    // The surviving member's company list no longer carries the wiped task,
    // not even as an unavailable stub.
    const listed = (await (
      await call(member, "GET", `/v1/companies/${id}/tasks`)
    ).json()) as { tasks: unknown[]; total: number };
    expect(listed.tasks).toEqual([]);
    expect(listed.total).toBe(0);
  });
});

describe("company connection allowlist", () => {
  async function allow(owner: Session, id: string, connectionIds: unknown) {
    return co(owner, "POST", `/v1/companies/${id}/connections`, { connectionIds });
  }

  it("proposals on unrestricted companies ignore the allowlist", async () => {
    const { owner, id } = await world("tc-owner-20", "Conn Co 20");
    const member = await addMember(owner, id, "tc-member-20", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    expect((await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal())).status).toBe(200);
  });

  it("a restricted company refuses foreign connections at propose time", async () => {
    const { owner, id } = await world("tc-owner-21", "Conn Co 21");
    const member = await addMember(owner, id, "tc-member-21", "operator", ["tasks.create"]);
    expect((await allow(owner, id, ["conn-a"])).status).toBe(200);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const refused = await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("connection_not_allowed");
    const allowed = await call(
      member,
      "POST",
      `/v1/tasks/${taskId}/actions?company=${id}`,
      proposal({ connectionId: "conn-a", providerAccountId: "ws-a" }),
    );
    expect(allowed.status).toBe(200);
  });

  it("tightening the list blocks approval and dispatch of now-foreign actions", async () => {
    const { owner, id } = await world("tc-owner-22", "Conn Co 22");
    const member = await addMember(owner, id, "tc-member-22", "operator", ["tasks.create"]);
    const approver = await addMember(owner, id, "tc-approver-22", "approver", ["approvals.decide"]);
    expect((await allow(owner, id, ["conn-a", "conn-b"])).status).toBe(200);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const proposed = await call(
      member,
      "POST",
      `/v1/tasks/${taskId}/actions?company=${id}`,
      proposal({ connectionId: "conn-a", providerAccountId: "ws-a" }),
    );
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string; grantRevision: number };
    // Tightening is a live policy, not a revision bump: the pending approval
    // stays bound, but the connection is no longer usable.
    expect((await allow(owner, id, ["conn-b"])).status).toBe(200);
    const decide = await call(approver, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "x",
    });
    expect(decide.status).toBe(403);
    expect(((await decide.json()) as { error: string }).error).toBe("connection_not_allowed");
  });

  it("dispatch re-checks the connection against the live list", async () => {
    const { owner, id } = await world("tc-owner-23", "Conn Co 23");
    const member = await addMember(owner, id, "tc-member-23", "operator", ["tasks.create"]);
    const approver = await addMember(owner, id, "tc-approver-23", "approver", ["approvals.decide"]);
    expect((await allow(owner, id, ["conn-a"])).status).toBe(200);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    const proposed = await call(
      member,
      "POST",
      `/v1/tasks/${taskId}/actions?company=${id}`,
      proposal({ connectionId: "conn-a", providerAccountId: "ws-a" }),
    );
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string; grantRevision: number };
    const decided = await call(approver, "POST", `/v1/tasks/${taskId}/actions/${action.id}/decision?company=${id}`, {
      approve: true,
      by: "x",
    });
    expect(decided.status).toBe(200);
    expect((await allow(owner, id, ["conn-b"])).status).toBe(200);
    const dispatched = await call(owner, "POST", `/v1/tasks/${taskId}/actions/${action.id}/dispatch?company=${id}`, {
      grantRevision: action.grantRevision,
    });
    expect(dispatched.status).toBe(403);
    expect(((await dispatched.json()) as { error: string }).error).toBe("connection_not_allowed");
  });

  it("an empty list denies all and null lifts the restriction", async () => {
    const { owner, id } = await world("tc-owner-24", "Conn Co 24");
    const member = await addMember(owner, id, "tc-member-24", "operator", ["tasks.create"]);
    const taskId = freshTask();
    expect((await createTask(member, taskId, id)).status).toBe(200);
    expect((await allow(owner, id, [])).status).toBe(200);
    expect(
      (await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal())).status,
    ).toBe(403);
    expect((await allow(owner, id, null)).status).toBe(200);
    expect((await call(member, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, proposal())).status).toBe(200);
  });

  it("managing the list needs the members grant", async () => {
    const { owner, id } = await world("tc-owner-25", "Conn Co 25");
    const member = await addMember(owner, id, "tc-member-25", "operator", ["tasks.create"]);
    expect((await allow(member, id, ["conn-a"])).status).toBe(403);
    const bad = await co(owner, "POST", `/v1/companies/${id}/connections`, { connectionIds: "conn-a" });
    expect(bad.status).toBe(400);
  });
});
