import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMENT_MAX_BYTES, COMMENT_TEXT_MAX, MAX_COMMENTS_PER_RUN, checkComment } from "../src/shared-comments";

// Comments on shared work (OFC-21, #460, docs/office-sharing.md): members
// holding comments.write comment on the published runs in their shared scope,
// every member reads the comments on those runs, and a comment is stamped as
// a person's from the verified session and never starts or approves anything.
// Sessions are minted through the real Apple exchange with the committed test
// JWKS, like shared-items.test.ts; tenants are `apple:<subject>`.

const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = "test-key";
const NONCE = "comments-nonce";

// Upper case, as Swift's `UUID.uuidString` writes them.
const RUN_A = "6B6C1A52-5F7E-4F5E-9D39-1C2B3A4D5E6F";
const RUN_B = "7C7D2B63-6A8F-4A6F-8E4A-2D3C4B5E6F70";
const RUN_C = "8D8E3C74-7B9A-4B7A-9F5B-3E4D5C6F7A81";

let counter = 0;
const freshCompany = () => `comments-${Date.now()}-${counter++}`;
let taskCounter = 0;
const freshTask = () => `task-cm-${Date.now()}-${taskCounter++}`;

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

async function sessionFor(sub: string): Promise<Session> {
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
    body: JSON.stringify({ provider: "apple", identityToken: token, nonce: NONCE, deviceId: "dev-1" }),
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
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/// Authenticated company call. Writes carry the session CSRF unless
/// `csrf: null` is passed to prove they fail closed without it.
function co(session: Session, method: string, path: string, body?: unknown, opts: { csrf?: string | null } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${session.token}`,
  };
  const csrf = opts.csrf === undefined ? session.csrf : opts.csrf;
  if (csrf) headers["x-csrf"] = csrf;
  return SELF.fetch(`https://test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const T = (sub: string) => `apple:${sub}`;

async function sharing(on: boolean) {
  expect((await op("PUT", "/v1/admin/flags", { officeSharing: on })).status).toBe(200);
}

async function companyWithOwner(sub: string) {
  const id = freshCompany();
  expect((await op("PUT", "/v1/admin/entitlements", { tenant: T(sub), canCreateCompany: true })).status).toBe(200);
  const owner = await sessionFor(sub);
  const created = await co(owner, "POST", "/v1/companies", { id, name: "Comment Co", timezone: "Asia/Bangkok" });
  expect(created.status).toBe(200);
  return { owner, id };
}

/// Seats a member with the given role and grants and, when `scope` is
/// passed, narrows them to those runs; returns their session.
async function member(owner: Session, id: string, sub: string, role: string, grants: string[], scope?: string[]) {
  expect((await co(owner, "POST", `/v1/companies/${id}/members`, { tenant: T(sub), role })).status).toBe(200);
  if (grants.length > 0) {
    expect((await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T(sub), grants })).status).toBe(200);
  }
  if (scope) {
    expect((await co(owner, "PATCH", `/v1/companies/${id}/scope`, { tenant: T(sub), sharedScope: scope })).status).toBe(
      200,
    );
  }
  return sessionFor(sub);
}

function record(run: string) {
  return { run: { id: run, state: "Held for you", deliverableNames: ["Q3 plan.xlsx"], revisionNumbers: [1] } };
}

async function publish(owner: Session, id: string, run: string) {
  expect((await co(owner, "PUT", `/v1/companies/${id}/shared/${run}`, record(run))).status).toBe(200);
}

function comment(caller: Session, id: string, run: string, body: unknown, opts: { csrf?: string | null } = {}) {
  return co(caller, "POST", `/v1/companies/${id}/shared/${run}/comments`, body, opts);
}

function comments(caller: Session, id: string, run: string, query = "") {
  return co(caller, "GET", `/v1/companies/${id}/shared/${run}/comments${query}`);
}

type Comment = { id: string; runId: string; authorKind: string; memberId: string; text: string; createdAt: string };
type Page = { comments: Comment[]; nextCursor: string | null; total: number };

async function page(caller: Session, id: string, run: string, query = ""): Promise<Page> {
  const response = await comments(caller, id, run, query);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

async function posted(caller: Session, id: string, run: string, text: string): Promise<Comment> {
  const response = await comment(caller, id, run, { text });
  expect(response.status).toBe(200);
  return ((await response.json()) as { comment: Comment }).comment;
}

type Storage = {
  get<V>(key: string): Promise<V | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
};

function companyObject(id: string) {
  const ns = (env as unknown as { COMPANY: DurableObjectNamespace }).COMPANY;
  return ns.get(ns.idFromName(`c:${id}`)) as never;
}

/// Everything the company's object holds, read from storage itself, so a
/// test sees exactly which keys a comment adds and that nothing else moves.
async function everything(id: string): Promise<Record<string, unknown>> {
  return runInDurableObject(companyObject(id), async (_instance: unknown, state: { storage: Storage }) => {
    return Object.fromEntries(await state.storage.list());
  });
}

const commentKeys = (all: Record<string, unknown>) =>
  Object.keys(all).filter((key) => key.startsWith("comment:") || key.startsWith("comment-count:"));

describe("while officeSharing is off", () => {
  it("comment routes refuse before reading anything, reads included", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-off");
    await sharing(true);
    await publish(owner, id, RUN_A);
    await posted(owner, id, RUN_A, "Kept while the switch is off.");
    await sharing(false);
    const off = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "feature_disabled", feature: "officeSharing" });
    };
    // wrangler.test.json sets no OFFICE_SHARING; the operator turned it off.
    await off(await comment(owner, id, RUN_A, { text: "Looks right." }));
    await off(await comments(owner, id, RUN_A));
    // Neither the CSRF guard, the run id nor the body is reached.
    await off(await comment(owner, id, RUN_A, "not json", { csrf: null }));
    await off(await comment(owner, id, "..%2Fx", { text: "x" }));
    expect((await op("GET", `/v1/companies/${id}/shared/${RUN_A}/comments`)).status).toBe(401);
    const all = await everything(id);
    expect(commentKeys(all).sort()).toEqual([`comment-count:${RUN_A}`, `comment:${RUN_A}:000001`]);
    await sharing(true);
    expect((await page(owner, id, RUN_A)).comments.map((c) => c.text)).toEqual(["Kept while the switch is off."]);
    await sharing(false);
  });
});

describe("comments on shared work", () => {
  beforeAll(async () => {
    await sharing(true);
  });
  afterAll(async () => {
    await sharing(false);
  });

  it("only a member holding comments.write may comment", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-who");
    await publish(owner, id, RUN_A);
    const viewer = await member(owner, id, "bob-cm-who", "viewer", []);
    const ungranted = await member(owner, id, "carl-cm-who", "operator", []);
    const contributor = await member(owner, id, "cara-cm-who", "operator", ["comments.write", "work.request"]);
    const approver = await member(owner, id, "dana-cm-who", "approver", ["approvals.decide", "comments.write"]);
    const outsider = await sessionFor("mallory-cm-who");

    // A Viewer's ceiling holds no comments.write, so no grant call can give it one.
    expect(
      (await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("bob-cm-who"), grants: ["comments.write"] }))
        .status,
    ).toBe(403);
    const refusals: [Response, number, unknown][] = [
      [await comment(viewer, id, RUN_A, { text: "I see it." }), 403, { error: "grant_required", grant: "comments.write" }],
      [await comment(ungranted, id, RUN_A, { text: "Me too." }), 403, { error: "grant_required", grant: "comments.write" }],
      [await comment(outsider, id, RUN_A, { text: "Let me in." }), 403, { error: "forbidden" }],
      [await op("POST", `/v1/companies/${id}/shared/${RUN_A}/comments`, { text: "Operator." }), 401, { error: "unauthorized" }],
      [await comment(contributor, id, RUN_A, { text: "No token." }, { csrf: null }), 403, { error: "csrf_required" }],
    ];
    for (const [response, status, body] of refusals) {
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect(commentKeys(await everything(id))).toEqual([]);

    await posted(contributor, id, RUN_A, "The memo reads well.");
    await posted(approver, id, RUN_A, "Agreed.");
    await posted(owner, id, RUN_A, "Thanks, both.");
    // Reading needs no grant: the Viewer reads all three.
    expect((await page(viewer, id, RUN_A)).comments.map((c) => c.text)).toEqual([
      "The memo reads well.",
      "Agreed.",
      "Thanks, both.",
    ]);
    // The outsider and the operator key read nothing, and learn nothing.
    const denied: [Response, number][] = [[await comments(outsider, id, RUN_A), 403],
      [await op("GET", `/v1/companies/${id}/shared/${RUN_A}/comments`), 401]];
    for (const [response, status] of denied) {
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain("memo");
      expect(text).not.toContain(RUN_A);
    }
  });

  it("a contributor comments only on published work in their scope", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-scope");
    await publish(owner, id, RUN_A);
    await publish(owner, id, RUN_B);
    // RUN_C is in scope but never published.
    const contributor = await member(owner, id, "cara-cm-scope", "operator", ["comments.write"], [RUN_A, RUN_C]);
    const viewer = await member(owner, id, "bob-cm-scope", "viewer", [], [RUN_A]);
    await posted(owner, id, RUN_B, "Owner's note on B.");

    const outside = await comment(contributor, id, RUN_B, { text: "On B." });
    const unpublished = await comment(contributor, id, RUN_C, { text: "On C." });
    const readOutside = await comments(contributor, id, RUN_B);
    const readUnpublished = await comments(contributor, id, RUN_C);
    const bodies = new Set<string>();
    for (const response of [outside, unpublished, readOutside, readUnpublished]) {
      expect(response.status).toBe(404);
      bodies.add(await response.text());
    }
    // Out of scope looks exactly like never published, and carries nothing of B.
    expect(bodies).toEqual(new Set([JSON.stringify({ error: "not_shared" })]));

    const mine = await posted(contributor, id, RUN_A, "On A, which I can see.");
    expect(mine.runId).toBe(RUN_A);
    expect((await page(viewer, id, RUN_A)).comments.map((c) => c.text)).toEqual(["On A, which I can see."]);
    // A Viewer without the grant is refused for the grant before any run is
    // considered, so the refusal is the same in scope or out of it.
    for (const run of [RUN_A, RUN_B, RUN_C]) {
      const response = await comment(viewer, id, run, { text: "x" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "grant_required", grant: "comments.write" });
    }
    expect(commentKeys(await everything(id)).sort()).toEqual([
      `comment-count:${RUN_A}`,
      `comment-count:${RUN_B}`,
      `comment:${RUN_A}:000001`,
      `comment:${RUN_B}:000001`,
    ]);
    // A malformed run id is refused for its shape alone.
    expect((await comment(contributor, id, "..%2Fx", { text: "x" })).status).toBe(400);
  });

  it("is attributed to a person by the verified member id, whatever the body claims", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-attr");
    await publish(owner, id, RUN_A);
    const contributor = await member(owner, id, "cara-cm-attr", "operator", ["comments.write"]);
    for (const [body, field] of [
      [{ text: "Hi", authorKind: "aiTeammate" }, "authorKind"],
      [{ text: "Hi", memberId: T("alice-cm-attr") }, "memberId"],
      [{ text: "Hi", author: "Alice" }, "author"],
      [{ text: "Hi", mentions: [T("alice-cm-attr")] }, "mentions"],
      [{ text: "Hi", createdAt: "2020-01-01T00:00:00Z" }, "createdAt"],
    ] as const) {
      const response = await comment(contributor, id, RUN_A, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unknown_field", field });
    }
    const before = Date.now();
    const stored = await posted(contributor, id, RUN_A, "First line.\nSecond line.");
    expect(Object.keys(stored).sort()).toEqual(["authorKind", "createdAt", "id", "memberId", "runId", "text"]);
    expect(stored).toMatchObject({
      runId: RUN_A,
      authorKind: "person",
      memberId: T("cara-cm-attr"),
      text: "First line.\nSecond line.",
    });
    expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Date.parse(stored.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    const ownerNote = await posted(owner, id, RUN_A, "Owner here.");
    expect(ownerNote).toMatchObject({ authorKind: "person", memberId: T("alice-cm-attr") });
    // Read back exactly as stored, oldest first.
    expect((await page(owner, id, RUN_A)).comments).toEqual([stored, ownerNote]);
  });

  it("refuses malformed comments whole and stores nothing", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-bad");
    await publish(owner, id, RUN_A);
    const cases: [unknown, string, string][] = [
      [[], "invalid_comment", "comment"],
      [null, "invalid_comment", "comment"],
      ["Looks good", "invalid_comment", "comment"],
      [{}, "invalid_comment", "text"],
      [{ text: "" }, "invalid_comment", "text"],
      [{ text: " \n\t " }, "invalid_comment", "text"],
      [{ text: 7 }, "invalid_comment", "text"],
      [{ text: "a\u0000b" }, "invalid_comment", "text"],
      [{ text: "bell\u0007" }, "invalid_comment", "text"],
      [{ text: "x".repeat(COMMENT_TEXT_MAX + 1) }, "invalid_comment", "text"],
    ];
    for (const [body, error, field] of cases) {
      const response = await comment(owner, id, RUN_A, JSON.stringify(body));
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(await response.json()).toEqual({ error, field });
    }
    expect((await comment(owner, id, RUN_A, "{not json")).status).toBe(400);
    expect((await comment(owner, id, RUN_A, { text: "é".repeat(COMMENT_MAX_BYTES) })).status).toBe(413);
    expect(commentKeys(await everything(id))).toEqual([]);
    // At the cap exactly, with tabs and line breaks, it is accepted.
    const longest = "a\tb\r\n".repeat(COMMENT_TEXT_MAX / 5);
    expect((await posted(owner, id, RUN_A, longest)).text).toBe(longest);
  });

  it("a revoked member is refused at their next action, and their comments stay", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-revoke");
    await publish(owner, id, RUN_A);
    await publish(owner, id, RUN_B);
    const contributor = await member(owner, id, "cara-cm-revoke", "operator", ["comments.write"], [RUN_A, RUN_B]);
    await posted(contributor, id, RUN_A, "Before the change.");

    // A narrowed scope holds from the very next comment and read.
    expect(
      (await co(owner, "PATCH", `/v1/companies/${id}/scope`, { tenant: T("cara-cm-revoke"), sharedScope: [RUN_B] }))
        .status,
    ).toBe(200);
    expect((await comment(contributor, id, RUN_A, { text: "Still here?" })).status).toBe(404);
    expect((await comments(contributor, id, RUN_A)).status).toBe(404);
    // So does taking the grant away.
    expect((await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("cara-cm-revoke"), grants: [] })).status).toBe(
      200,
    );
    const ungranted = await comment(contributor, id, RUN_B, { text: "And now?" });
    expect(ungranted.status).toBe(403);
    expect(await ungranted.json()).toEqual({ error: "grant_required", grant: "comments.write" });

    expect((await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("cara-cm-revoke"), grants: ["comments.write"] })).status).toBe(200);
    await posted(contributor, id, RUN_B, "On B before removal.");
    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("cara-cm-revoke") })).status).toBe(200);
    for (const response of [
      await comment(contributor, id, RUN_B, { text: "After removal." }),
      await comments(contributor, id, RUN_B),
      // A fresh sign-in brings nothing back.
      await comment(await sessionFor("cara-cm-revoke"), id, RUN_B, { text: "Signed in again." }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    // Their comments stay, attributed to them.
    expect((await page(owner, id, RUN_A)).comments.map((c) => [c.memberId, c.text])).toEqual([
      [T("cara-cm-revoke"), "Before the change."],
    ]);
    expect((await page(owner, id, RUN_B)).comments.map((c) => c.text)).toEqual(["On B before removal."]);
    // Seated again, they hold no grant until the owner gives one.
    expect((await co(owner, "POST", `/v1/companies/${id}/members`, { tenant: T("cara-cm-revoke"), role: "operator" })).status).toBe(
      200,
    );
    const reseated = await comment(contributor, id, RUN_B, { text: "Back?" });
    expect(reseated.status).toBe(403);
    expect(await reseated.json()).toEqual({ error: "grant_required", grant: "comments.write" });
  });

  it("a comment creates no task, proposal or approval and moves nothing else", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-inert");
    expect((await co(owner, "PUT", "/v1/consent/cloud", { enabled: true })).status).toBe(200);
    await publish(owner, id, RUN_A);
    const contributor = await member(owner, id, "cara-cm-inert", "operator", ["comments.write", "work.request"]);
    // A company task with an exact action awaiting a decision.
    const taskId = freshTask();
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
        "idempotency-key": `${taskId}-key`,
      },
      body: JSON.stringify({
        id: taskId,
        title: "t",
        objective: "o",
        state: "draft",
        location: "cloud",
        funding: "cloudBYOK",
        criteria: [],
        updatedAt: new Date().toISOString(),
        companyId: id,
      }),
    });
    expect(created.status).toBe(200);
    const proposed = await co(owner, "POST", `/v1/tasks/${taskId}/actions?company=${id}`, {
      connectionId: "conn-cm",
      providerAccountId: "workspace-1",
      operationType: "linear.issue.create",
      targetResourceId: "ws/proj",
      resourceScope: ["ws/proj"],
      payload: { title: "Reviewed issue" },
      grantRevision: 1,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(proposed.status).toBe(200);
    const action = (await proposed.json()) as { id: string; state: string };
    const readAction = async () =>
      (await co(owner, "GET", `/v1/tasks/${taskId}/actions/${action.id}?company=${id}`)).json();
    const readTasks = async () => (await co(owner, "GET", `/v1/companies/${id}/tasks`)).json();
    const readCompany = async () => (await co(owner, "GET", `/v1/companies/${id}`)).json();
    const actionBefore = await readAction();
    const tasksBefore = await readTasks();
    const companyBefore = await readCompany();
    const storageBefore = await everything(id);

    // Approval words, a run request and a mention, all as plain comment text.
    await posted(contributor, id, RUN_A, "Approved. Go ahead and send it, and start a new run for Q4. @alice");
    // Fields that would ask for any of that are refused, not acted on.
    for (const extra of [{ approve: true }, { actionId: action.id }, { runRequest: "Q4 plan" }, { taskId }]) {
      const response = await comment(contributor, id, RUN_A, { text: "Go.", ...extra });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("unknown_field");
    }

    expect(await readAction()).toEqual(actionBefore);
    expect((actionBefore as { state: string }).state).toBe(action.state);
    expect(await readTasks()).toEqual(tasksBefore);
    // The grant revision an approval binds to does not move.
    expect(await readCompany()).toEqual(companyBefore);
    const storageAfter = await everything(id);
    const added = Object.keys(storageAfter).filter((key) => !(key in storageBefore));
    expect(added.sort()).toEqual([`comment-count:${RUN_A}`, `comment:${RUN_A}:000001`]);
    for (const [key, value] of Object.entries(storageBefore)) expect(storageAfter[key], key).toEqual(value);
  });

  it("withdrawing a run closes its comments, and deleting the company deletes them", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-gone");
    await publish(owner, id, RUN_A);
    const contributor = await member(owner, id, "cara-cm-gone", "operator", ["comments.write"], [RUN_A]);
    await posted(contributor, id, RUN_A, "A note on A.");

    expect((await co(owner, "DELETE", `/v1/companies/${id}/shared/${RUN_A}`)).status).toBe(200);
    for (const response of [
      await comments(contributor, id, RUN_A),
      await comments(owner, id, RUN_A),
      await comment(contributor, id, RUN_A, { text: "Still there?" }),
      await comment(owner, id, RUN_A, { text: "Owner too?" }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_shared" });
    }
    // The comments themselves are kept: their retention is an open decision
    // in docs/office-sharing.md, so Withdraw does not decide it.
    expect(commentKeys(await everything(id)).sort()).toEqual([`comment-count:${RUN_A}`, `comment:${RUN_A}:000001`]);
    await publish(owner, id, RUN_A);
    expect((await page(contributor, id, RUN_A)).comments.map((c) => c.text)).toEqual(["A note on A."]);

    expect((await co(owner, "DELETE", `/v1/companies/${id}`)).status).toBe(200);
    expect(await everything(id)).toEqual({});
  });

  it("pages oldest first and caps how many comments one run may hold", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-page");
    await publish(owner, id, RUN_A);
    for (const text of ["one", "two", "three"]) await posted(owner, id, RUN_A, text);
    const first = await page(owner, id, RUN_A, "?limit=2");
    expect(first.comments.map((c) => c.text)).toEqual(["one", "two"]);
    expect(first).toMatchObject({ nextCursor: "2", total: 3 });
    const rest = await page(owner, id, RUN_A, "?limit=2&cursor=2");
    expect(rest.comments.map((c) => c.text)).toEqual(["three"]);
    expect(rest.nextCursor).toBeNull();
    expect((await page(owner, id, RUN_A, "?cursor=3")).comments).toEqual([]);
    for (const query of ["?limit=0", "?limit=51", "?limit=two", "?cursor=-1", "?cursor=1.5"]) {
      expect((await comments(owner, id, RUN_A, query)).status, query).toBe(400);
    }
    // A run named in the query is ignored: the path names the run.
    await publish(owner, id, RUN_B);
    expect((await page(owner, id, RUN_B, `?run=${RUN_A}`)).total).toBe(0);

    await runInDurableObject(companyObject(id), async (_instance: unknown, state: { storage: Storage }) => {
      await state.storage.put(`comment-count:${RUN_B}`, MAX_COMMENTS_PER_RUN);
    });
    const full = await comment(owner, id, RUN_B, { text: "One more." });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "comments_full", limit: MAX_COMMENTS_PER_RUN });
    // Another run still takes comments.
    await posted(owner, id, RUN_A, "four");
  });

  it("writes no comment text to the logs", async () => {
    const { owner, id } = await companyWithOwner("alice-cm-logs");
    await publish(owner, id, RUN_A);
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      // The spies see what the company's object writes to the console.
      await runInDurableObject(companyObject(id), async () => {
        console.log("probe from the company object");
      });
      expect(spies[0]!.mock.calls.flat().join(" ")).toContain("probe from the company object");

      const secret = "Private remark 7f3a about the Q3 numbers";
      await posted(owner, id, RUN_A, secret);
      await page(owner, id, RUN_A);
      expect((await comment(owner, id, RUN_A, { text: secret, extra: 1 })).status).toBe(400);
      expect((await comment(owner, id, RUN_C, { text: secret })).status).toBe(404);
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg))).join("\n");
      expect(logged).not.toContain("7f3a");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("the comment check", () => {
  it("takes the text alone and keeps it as written", () => {
    expect(checkComment({ text: "  Spaced out.  " })).toEqual({ ok: true, text: "  Spaced out.  " });
    expect(checkComment({ text: "x".repeat(COMMENT_TEXT_MAX) }).ok).toBe(true);
    expect(checkComment({ text: "x", ["a".repeat(100)]: 1 })).toEqual({
      ok: false,
      error: "unknown_field",
      field: "a".repeat(64),
    });
  });
});
