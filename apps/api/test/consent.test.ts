import { sourceWorker as SELF } from "./source-worker";

import { describe, expect, it } from "vitest";

// Compact identity minter for consent flows. Full rejection coverage lives
// in auth.test.ts; here a session is just a means to a tenant.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = { authorization: "Bearer test-key" };
const NONCE = "consent-nonce";

let counter = 4000;
const freshID = () => `consent-task-${Date.now()}-${counter++}`;

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

async function sessionFor(sub: string, device: string): Promise<string> {
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
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function setConsent(accessToken: string, enabled: boolean) {
  return SELF.fetch("https://test/v1/consent/cloud", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ enabled }),
  });
}

function draft(id: string) {
  return {
    id,
    title: "t",
    objective: "o",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
  };
}

async function createTask(accessToken: string, id: string, key: string) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "idempotency-key": key,
    },
    body: JSON.stringify(draft(id)),
  });
}

async function call(
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// No connection is stored for this proposal on purpose: if the dispatch gate
// ever regressed, the broker would settle `failed` on the missing connection
// instead of reaching out to a real provider from the test.
function proposal() {
  return {
    connectionId: "conn-consent",
    providerAccountId: "workspace-1",
    operationType: "linear.issue.create",
    targetResourceId: "ws/proj",
    resourceScope: ["ws/proj"],
    payload: { title: "Reviewed issue" },
    grantRevision: 1,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}

async function errorOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: string }).error;
}

describe("consent and tenant data", () => {
  it("blocks cloud work until the tenant opts in", async () => {
    const access = await sessionFor("consent-sub-1", "consent-device-1");
    expect((await createTask(access, freshID(), "consent-k1")).status).toBe(403);
    expect((await setConsent(access, true)).status).toBe(200);
    expect((await createTask(access, freshID(), "consent-k2")).status).toBe(200);
    const view = await SELF.fetch("https://test/v1/consent/cloud", {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(((await view.json()) as { cloudWork?: boolean }).cloudWork).toBe(true);
    expect((await setConsent(access, false)).status).toBe(200);
    expect((await createTask(access, freshID(), "consent-k3")).status).toBe(403);
  });

  it("withdrawal stops mid-task work but keeps stop and data routes open", async () => {
    const access = await sessionFor("consent-sub-5", "consent-device-5");
    expect((await setConsent(access, true)).status).toBe(200);
    const id = freshID();
    expect((await createTask(access, id, "consent-k7")).status).toBe(200);
    const approvedAction = (await (await call(access, "POST", `/v1/tasks/${id}/actions`, proposal())).json()) as {
      id: string;
    };
    expect(
      (await call(access, "POST", `/v1/tasks/${id}/actions/${approvedAction.id}/decision`, { approve: true, by: "me" }))
        .status,
    ).toBe(200);
    const pendingResponse = await call(access, "POST", `/v1/tasks/${id}/actions`, proposal());
    expect(pendingResponse.status).toBe(200);
    const pendingAction = (await pendingResponse.json()) as { id: string };
    const claimed = await call(access, "POST", `/v1/tasks/${id}/attempts`, { executorId: "e", inputRevision: "r" });
    expect(claimed.status).toBe(200);
    const attempt = (await claimed.json()) as { id: string; fence: string };

    expect((await setConsent(access, false)).status).toBe(200);

    // Anything that starts or continues work is refused.
    const refused: [string, Response][] = [
      ["queue", await call(access, "POST", `/v1/tasks/${id}/commands`, { type: "queue" }, { "idempotency-key": "c-q" })],
      ["retry", await call(access, "POST", `/v1/tasks/${id}/commands`, { type: "retry" }, { "idempotency-key": "c-r" })],
      ["replan", await call(access, "POST", `/v1/tasks/${id}/commands`, { type: "replan" }, { "idempotency-key": "c-p" })],
      ["propose", await call(access, "POST", `/v1/tasks/${id}/actions`, proposal())],
      [
        "approve",
        await call(access, "POST", `/v1/tasks/${id}/actions/${pendingAction.id}/decision`, { approve: true, by: "me" }),
      ],
      [
        "dispatch",
        await call(access, "POST", `/v1/tasks/${id}/actions/${approvedAction.id}/dispatch`, { grantRevision: 1 }),
      ],
      ["claim", await call(access, "POST", `/v1/tasks/${id}/attempts`, { executorId: "e2", inputRevision: "r" })],
      ["heartbeat", await call(access, "POST", `/v1/tasks/${id}/attempts/${attempt.id}/heartbeat`, { fence: attempt.fence })],
      [
        "steps",
        await call(access, "POST", `/v1/tasks/${id}/attempts/${attempt.id}/steps`, {
          fence: attempt.fence,
          step: { id: "s1", name: "Step", status: "done" },
        }),
      ],
    ];
    for (const [label, response] of refused) {
      expect({ label, status: response.status, error: await errorOf(response) }).toEqual({
        label,
        status: 403,
        error: "consent_required",
      });
    }
    // The refused dispatch never began: the approval is still unspent.
    const approvedRead = await call(access, "GET", `/v1/tasks/${id}/actions/${approvedAction.id}`);
    expect(((await approvedRead.json()) as { state?: string }).state).toBe("approved");

    // Pause is not gated: on a draft the object refuses it on its own terms.
    const pause = await call(access, "POST", `/v1/tasks/${id}/commands`, { type: "pause" }, { "idempotency-key": "c-z" });
    expect(pause.status).toBe(409);
    expect(await errorOf(pause)).toBe("illegal_command");

    // Stopping work and taking data stay open.
    const rejected = await call(access, "POST", `/v1/tasks/${id}/actions/${pendingAction.id}/decision`, {
      approve: false,
      by: "me",
    });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { state?: string }).state).toBe("rejected");
    const finished = await call(access, "POST", `/v1/tasks/${id}/attempts/${attempt.id}/finish`, {
      fence: attempt.fence,
      outcome: "failed",
    });
    expect(finished.status).toBe(200);
    const cancelled = await call(access, "POST", `/v1/tasks/${id}/commands`, { type: "cancel" }, { "idempotency-key": "c-c" });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { state?: string }).state).toBe("cancelled");
    expect((await call(access, "GET", `/v1/tasks/${id}`)).status).toBe(200);
    expect((await call(access, "GET", `/v1/tasks/${id}/events?after=0`)).status).toBe(200);
    const exported = await call(access, "GET", "/v1/tenant/export");
    expect(exported.status).toBe(200);
    expect(((await exported.json()) as { tasks?: { task?: { id?: string } }[] }).tasks?.map((entry) => entry.task?.id)).toEqual([id]);
    expect((await call(access, "DELETE", "/v1/tenant/data")).status).toBe(200);
  });

  it("refuses operator task commands without a tenant session", async () => {
    // Admin authority never grants a tenant identity or a consent bypass.
    const id = freshID();
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...OPERATOR, "idempotency-key": "consent-op-1" },
      body: JSON.stringify({ ...draft(id), tenantId: "apple:consent-never" }),
    });
    expect(created.status).toBe(401);
    const queued = await call("test-key", "POST", `/v1/tasks/${id}/commands`, { type: "queue" }, {
      "idempotency-key": "consent-op-2",
    });
    expect(queued.status).toBe(401);
    expect((await call("test-key", "POST", `/v1/tasks/${id}/attempts`, { executorId: "e", inputRevision: "r" })).status).toBe(
      401,
    );
  });

  it("exports tasks, connection metadata, and consent without secrets", async () => {
    const access = await sessionFor("consent-sub-2", "consent-device-2");
    expect((await setConsent(access, true)).status).toBe(200);
    const first = freshID();
    const second = freshID();
    expect((await createTask(access, first, "consent-k4")).status).toBe(200);
    expect((await createTask(access, second, "consent-k5")).status).toBe(200);
    const connection = await SELF.fetch("https://test/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({
        provider: "linear",
        accountId: "workspace-1",
        scopes: ["read"],
        refreshToken: "linear-refresh-plain",
      }),
    });
    expect(connection.status).toBe(200);

    const exported = await SELF.fetch("https://test/v1/tenant/export", {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as {
      tenant?: string;
      tasks?: { task?: { id?: string }; events?: unknown[]; actions?: unknown[]; attempts?: unknown[] }[];
      connections?: { accountId?: string }[];
      consent?: { cloudWork?: boolean };
    };
    expect(body.tenant).toBe("apple:consent-sub-2");
    expect((body.tasks ?? []).map((entry) => entry.task?.id).sort()).toEqual([first, second].sort());
    for (const entry of body.tasks ?? []) {
      // Creating a task appends its genesis event, so the export carries
      // history from the very first write.
      expect((entry.events ?? []).length).toBeGreaterThanOrEqual(1);
      expect(entry.actions).toEqual([]);
      expect(entry.attempts).toEqual([]);
    }
    expect(body.connections).toHaveLength(1);
    expect(body.consent?.cloudWork).toBe(true);
    expect(JSON.stringify(body)).not.toContain("linear-refresh-plain");
  });

  it("deletes everything and leaves a tombstone", async () => {
    const access = await sessionFor("consent-sub-3", "consent-device-3");
    expect((await setConsent(access, true)).status).toBe(200);
    const id = freshID();
    expect((await createTask(access, id, "consent-k6")).status).toBe(200);
    expect(
      (
        await SELF.fetch("https://test/v1/connections", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
          body: JSON.stringify({
            provider: "gmail",
            accountId: "user@example.com",
            scopes: ["gmail.readonly"],
            refreshToken: "gmail-refresh-plain",
          }),
        })
      ).status,
    ).toBe(200);

    const deleted = await SELF.fetch("https://test/v1/tenant/data", {
      method: "DELETE",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(deleted.status).toBe(200);
    const receipt = (await deleted.json()) as {
      tasksWiped?: number;
      connectionsWiped?: number;
      deletedAt?: string;
    };
    expect(receipt.tasksWiped).toBe(1);
    expect(receipt.connectionsWiped).toBe(1);
    expect(typeof receipt.deletedAt).toBe("string");

    // The task, its history, and the session are gone; the export names the
    // tombstone instead of resurrecting anything.
    const auth = { authorization: `Bearer ${access}` };
    expect((await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: auth })).status).toBe(401);
    const exported = await SELF.fetch("https://test/v1/tenant/export", { headers: auth });
    expect(exported.status).toBe(401);
  });

  it("wipe removes the task history, not just the task", async () => {
    // The qualification-matrix wipe row had no test reading history after a
    // wipe: the task, its events, its attempts and its action proposals must
    // all be gone. A fresh sign-in reads after the old session is revoked.
    const access = await sessionFor("consent-sub-5", "consent-device-5");
    expect((await setConsent(access, true)).status).toBe(200);
    const id = freshID();
    expect((await createTask(access, id, "consent-k7")).status).toBe(200);
    const auth = { authorization: `Bearer ${access}` };
    const claimed = (await (
      await SELF.fetch(`https://test/v1/tasks/${id}/attempts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ executorId: "e", inputRevision: "r" }),
      })
    ).json()) as { id: string; fence: string };
    expect(
      (
        await SELF.fetch(`https://test/v1/tasks/${id}/attempts/${claimed.id}/finish`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ fence: claimed.fence, outcome: "done" }),
        })
      ).status,
    ).toBe(200);
    const connection = (await (
      await SELF.fetch("https://test/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          provider: "linear",
          accountId: "workspace-1",
          scopes: ["read"],
          refreshToken: "linear-refresh-plain",
          resourceIds: ["ws/proj"],
          allowsActions: true,
        }),
      })
    ).json()) as { id: string };
    const proposed = await SELF.fetch(`https://test/v1/tasks/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        connectionId: connection.id,
        providerAccountId: "workspace-1",
        operationType: "linear.issue.create",
        targetResourceId: "ws/proj",
        resourceScope: ["ws/proj"],
        payload: { title: "Reviewed issue", description: "From the brief." },
        grantRevision: 1,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string };

    const deleted = await SELF.fetch("https://test/v1/tenant/data", {
      method: "DELETE",
      headers: auth,
    });
    expect(deleted.status).toBe(200);

    // A fresh verified tenant reader models sign-in after deletion; the
    // revoked session cannot provide this missing-data proof.
    const reader = { authorization: `Bearer ${await sessionFor("consent-sub-5", "fresh-reader-5")}` };
    const read = (path: string) => SELF.fetch(`https://test${path}`, { headers: reader });
    expect((await read(`/v1/tasks/${id}`)).status).toBe(404);
    expect((await read(`/v1/tasks/${id}/events?after=0`)).status).toBe(404);
    expect((await read(`/v1/tasks/${id}/actions/${action.id}`)).status).toBe(404);
  });

  it("answers a wiped tenant with its tombstone", async () => {    const access = await sessionFor("consent-sub-4", "consent-device-4");
    expect((await setConsent(access, true)).status).toBe(200);
    // The current session performs the wipe; a new sign-in inspects its tombstone.
    const wiped = await SELF.fetch("https://test/v1/tenant/data?tenant=apple:consent-sub-4", {
      method: "DELETE",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(wiped.status).toBe(200);
    expect((await call(access, "GET", "/v1/tenant/export")).status).toBe(401);
    const reader = { authorization: `Bearer ${await sessionFor("consent-sub-4", "fresh-reader-4")}` };
    const exported = await SELF.fetch("https://test/v1/tenant/export?tenant=apple:consent-sub-4", {
      headers: reader,
    });
    expect(exported.status).toBe(404);
    const body = (await exported.json()) as { error?: string; deletedAt?: string };
    expect(body.error).toBe("tenant_deleted");
    expect(typeof body.deletedAt).toBe("string");
  });
});
