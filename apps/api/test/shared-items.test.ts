import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SHARED_ITEMS, SHARED_LIMITS, SHARED_RECORD_MAX_BYTES, checkSharedRecord } from "../src/shared-items";

// Published shared run records (OFC-21, #460, docs/office-sharing.md): the
// owner publishes and withdraws one run's shared copy, and members read only
// what is in their shared scope. Sessions are minted through the real Apple
// exchange with the committed test JWKS, like member-scope.test.ts; each user
// is an Apple subject and tenants are `apple:<subject>`.

const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = "test-key";
const NONCE = "shared-nonce";

// Upper case, as Swift's `UUID.uuidString` writes them.
const RUN_A = "0B0C6A52-5F7E-4F5E-9D39-1C2B3A4D5E6F";
const RUN_B = "1C1D7B63-6A8F-4A6F-8E4A-2D3C4B5E6F70";
const RUN_C = "2D2E8C74-7B9A-4B7A-9F5B-3E4D5C6F7A81";
const RUN_D = "3E3F9D85-8CAB-4C8B-AF6C-4F5E6D7A8B92";
const REVISION = "4F4FAE96-9DBC-4D9C-BF7D-5A6F7E8B9CA3";
const DECISION = "5A5ABFA7-AECD-4EAD-8F8E-6B7A8F9CADB4";

let counter = 0;
const freshCompany = () => `shared-${Date.now()}-${counter++}`;

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

async function companyWithOwner(sub: string, id = freshCompany()) {
  expect((await op("PUT", "/v1/admin/entitlements", { tenant: T(sub), canCreateCompany: true })).status).toBe(200);
  const owner = await sessionFor(sub);
  const created = await co(owner, "POST", "/v1/companies", { id, name: "Shared Co", timezone: "Asia/Bangkok" });
  expect(created.status).toBe(200);
  return { owner, id };
}

async function addMember(owner: Session, id: string, sub: string, role: string) {
  const response = await co(owner, "POST", `/v1/companies/${id}/members`, { tenant: T(sub), role });
  expect(response.status).toBe(200);
}

async function setScope(owner: Session, id: string, sub: string, sharedScope: string[]) {
  const response = await co(owner, "PATCH", `/v1/companies/${id}/scope`, { tenant: T(sub), sharedScope });
  expect(response.status).toBe(200);
}

/// One run's record exactly as `OfficeSharePayload`'s per-run fields encode
/// through `JSONEncoder.makeStorage()`: UUID strings, ISO 8601 dates.
function record(run: string) {
  return {
    run: { id: run, state: "Held for you", deliverableNames: ["Q3 plan.xlsx", "Board memo.docx"], revisionNumbers: [1, 2] },
    reviews: [{ revisionID: REVISION, revisionNumber: 2, outcome: "changesRequested", decidedAt: "2026-10-02T09:15:00Z" }],
    decisions: [{ instanceID: DECISION, runID: run, title: "Send the board memo to ~/Shared" }],
  };
}

function publish(caller: Session, id: string, run: string, body: unknown, opts: { csrf?: string | null } = {}) {
  return co(caller, "PUT", `/v1/companies/${id}/shared/${run}`, body, opts);
}

function withdraw(caller: Session, id: string, run: string, opts: { csrf?: string | null } = {}) {
  return co(caller, "DELETE", `/v1/companies/${id}/shared/${run}`, undefined, opts);
}

function read(caller: Session, id: string, run: string) {
  return co(caller, "GET", `/v1/companies/${id}/shared/${run}`);
}

type Item = { run: { id: string; state: string }; publishedAt: string; updatedAt: string } & Record<string, unknown>;
type Page = { items: Item[]; nextCursor: string | null; total: number };

async function list(caller: Session, id: string, query = ""): Promise<Page> {
  const response = await co(caller, "GET", `/v1/companies/${id}/shared${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

type Storage = {
  get<V>(key: string): Promise<V | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
};

/// What the company's object holds for shared runs, read from storage itself
/// rather than through a route, so a withdrawal or a company delete is seen
/// to remove the bytes and not just hide them.
async function stored(id: string): Promise<{ records: string[]; index: string[] | undefined }> {
  const ns = (env as unknown as { COMPANY: DurableObjectNamespace }).COMPANY;
  return runInDurableObject(ns.get(ns.idFromName(`c:${id}`)) as never, async (_instance: unknown, state: { storage: Storage }) => {
    const records = [...(await state.storage.list({ prefix: "shared:" })).keys()];
    return { records, index: await state.storage.get<string[]>("shared-index") };
  });
}

describe("while officeSharing is off", () => {
  it("every shared route refuses before reading anything, reads included", async () => {
    const { owner, id } = await companyWithOwner("alice-off");
    const off = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "feature_disabled", feature: "officeSharing" });
    };
    // wrangler.test.json sets no OFFICE_SHARING, so the switch starts off.
    await off(await publish(owner, id, RUN_A, record(RUN_A)));
    await off(await withdraw(owner, id, RUN_A));
    await off(await co(owner, "GET", `/v1/companies/${id}/shared`));
    await off(await read(owner, id, RUN_A));
    // Neither the CSRF guard, the ids nor the body are reached.
    await off(await publish(owner, id, RUN_A, "not json", { csrf: null }));
    await off(await co(owner, "GET", `/v1/companies/${id}/shared/..%2Fx`));
    expect((await op("GET", `/v1/companies/${id}/shared`)).status).toBe(401);
    expect(await stored(id)).toEqual({ records: [], index: undefined });

    // Work published while it was on is shown to nobody once it is off, and
    // is still there, unchanged, when it comes back on.
    await sharing(true);
    const published = await publish(owner, id, RUN_A, record(RUN_A));
    expect(published.status).toBe(200);
    const item = ((await published.json()) as { item: Item }).item;
    await sharing(false);
    await off(await read(owner, id, RUN_A));
    await off(await co(owner, "GET", `/v1/companies/${id}/shared`));
    await off(await withdraw(owner, id, RUN_A));
    await sharing(true);
    const again = await read(owner, id, RUN_A);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { item: Item }).item).toEqual(item);
    await sharing(false);
  });
});

describe("shared run records", () => {
  beforeAll(async () => {
    await sharing(true);
  });
  afterAll(async () => {
    await sharing(false);
  });

  it("stores exactly the published fields and stamps when", async () => {
    const { owner, id } = await companyWithOwner("alice-store");
    const response = await publish(owner, id, RUN_A, { ...record(RUN_A), brief: "Plan Q3 for the board." });
    expect(response.status).toBe(200);
    const { item } = (await response.json()) as { item: Item };
    expect(Object.keys(item).sort()).toEqual(["brief", "decisions", "publishedAt", "reviews", "run", "updatedAt"]);
    expect(item).toMatchObject({ ...record(RUN_A), brief: "Plan Q3 for the board." });
    expect(item.publishedAt).toBe(item.updatedAt);
    // Without Include the brief there is no brief key at all.
    const plain = await publish(owner, id, RUN_B, { ...record(RUN_B), brief: null });
    expect(Object.keys(((await plain.json()) as { item: Item }).item)).not.toContain("brief");
    expect(await stored(id)).toEqual({ records: [`shared:${RUN_A}`, `shared:${RUN_B}`], index: [RUN_A, RUN_B] });
  });

  it("a viewer sees only the runs in their scope", async () => {
    const { owner, id } = await companyWithOwner("alice-view");
    for (const run of [RUN_A, RUN_B, RUN_C]) expect((await publish(owner, id, run, record(run))).status).toBe(200);
    await addMember(owner, id, "bob-view", "viewer");
    await setScope(owner, id, "bob-view", [RUN_A, RUN_C]);
    await addMember(owner, id, "carol-view", "viewer");

    const bob = await sessionFor("bob-view");
    const page = await list(bob, id);
    expect(page.items.map((item) => item.run.id)).toEqual([RUN_A, RUN_C]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect((await read(bob, id, RUN_A)).status).toBe(200);
    expect((await read(bob, id, RUN_C)).status).toBe(200);
    expect((await read(bob, id, RUN_B)).status).toBe(404);

    // The owner sees all of it, and a member seated before sharing, with the
    // pre-sharing full-access scope, still does too.
    expect((await list(owner, id)).items.map((item) => item.run.id)).toEqual([RUN_A, RUN_B, RUN_C]);
    expect((await read(owner, id, RUN_B)).status).toBe(200);
    const carol = await sessionFor("carol-view");
    expect((await list(carol, id)).total).toBe(3);

    // Outsiders and the operator key get the plain refusal with no content.
    const outsider = await sessionFor("mallory-view");
    const denied: [Response, number][] = [
      [await co(outsider, "GET", `/v1/companies/${id}/shared`), 403],
      [await read(outsider, id, RUN_A), 403],
      [await op("GET", `/v1/companies/${id}/shared`), 401],
      [await op("GET", `/v1/companies/${id}/shared/${RUN_A}`), 401],
    ];
    for (const [response, status] of denied) {
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain("Held for you");
      expect(text).not.toContain("Q3 plan");
      expect(text).not.toContain(RUN_A);
    }
  });

  it("a run outside the scope answers exactly like one that was never published", async () => {
    const { owner, id } = await companyWithOwner("alice-same");
    for (const run of [RUN_A, RUN_B, RUN_C]) expect((await publish(owner, id, run, record(run))).status).toBe(200);
    await addMember(owner, id, "bob-same", "viewer");
    await setScope(owner, id, "bob-same", [RUN_A, RUN_C]);
    expect((await withdraw(owner, id, RUN_C)).status).toBe(200);
    const bob = await sessionFor("bob-same");
    const outside = await read(bob, id, RUN_B);
    const missing = await read(bob, id, RUN_D);
    const withdrawn = await read(bob, id, RUN_C);
    const bodies = [];
    for (const response of [outside, missing, withdrawn]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(outside.headers.get("content-type"));
      bodies.push(await response.text());
    }
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: "not_shared" })]));
    expect((await list(bob, id)).total).toBe(1);
    // A malformed id is refused for its shape alone, whether or not anything exists.
    expect((await read(bob, id, "..%2Fx")).status).toBe(400);
  });

  it("refuses any field outside the schema, at every level, and stores nothing", async () => {
    const { owner, id } = await companyWithOwner("alice-unknown");
    const base = record(RUN_A);
    const cases: [unknown, string][] = [
      [{ ...base, companyName: "Shared Co" }, "companyName"],
      [{ ...base, roles: [] }, "roles"],
      [{ ...base, comments: ["Looks good"] }, "comments"],
      [{ ...base, instructions: "You are the CFO." }, "instructions"],
      [{ ...base, transcript: "user: plan Q3" }, "transcript"],
      [{ ...base, sources: ["notes.md"] }, "sources"],
      [{ ...base, files: [{ name: "Q3 plan.xlsx", content: "UEsDBA==" }] }, "files"],
      [{ ...base, run: { ...base.run, path: "/Users/alice/Office/Q3" } }, "run.path"],
      [{ ...base, run: { ...base.run, steps: { done: 2, total: 5 } } }, "run.steps"],
      [{ ...base, reviews: [{ ...base.reviews[0], reviewer: "alice" }] }, "reviews.0.reviewer"],
      [{ ...base, decisions: [{ ...base.decisions[0], source: "notes.md" }] }, "decisions.0.source"],
    ];
    for (const [body, field] of cases) {
      const response = await publish(owner, id, RUN_A, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unknown_field", field });
    }
    expect(await stored(id)).toEqual({ records: [], index: undefined });
    expect((await read(owner, id, RUN_A)).status).toBe(404);
  });

  it("refuses malformed records whole, and stores nothing", async () => {
    const { owner, id } = await companyWithOwner("alice-bad");
    const base = record(RUN_A);
    const run = (patch: Record<string, unknown>) => ({ ...base, run: { ...base.run, ...patch } });
    const review = (patch: Record<string, unknown>) => ({ ...base, reviews: [{ ...base.reviews[0], ...patch }] });
    const decision = (patch: Record<string, unknown>) => ({ ...base, decisions: [{ ...base.decisions[0], ...patch }] });
    const { runID: _dropped, ...withoutRun } = base.decisions[0]!;
    const cases: [unknown, string, string][] = [
      [[], "invalid_shared_record", "record"],
      [{ reviews: [] }, "invalid_shared_record", "run"],
      [record(RUN_B), "run_id_mismatch", "run.id"],
      [run({ id: "not-a-uuid" }), "invalid_shared_record", "run.id"],
      [decision({ runID: RUN_B }), "run_id_mismatch", "decisions.0.runID"],
      [{ ...base, decisions: [withoutRun] }, "run_id_mismatch", "decisions.0.runID"],
      [run({ state: "" }), "invalid_shared_record", "run.state"],
      [run({ state: "Done\nsee /Users/alice" }), "invalid_shared_record", "run.state"],
      [run({ state: "x".repeat(SHARED_LIMITS.stateLength + 1) }), "invalid_shared_record", "run.state"],
      [run({ deliverableNames: ["/Users/alice/Q3 plan.xlsx"] }), "invalid_shared_record", "run.deliverableNames.0"],
      [run({ deliverableNames: ["ok.xlsx", "..\\secrets.txt"] }), "invalid_shared_record", "run.deliverableNames.1"],
      [run({ deliverableNames: [".."] }), "invalid_shared_record", "run.deliverableNames.0"],
      [
        run({ deliverableNames: Array.from({ length: SHARED_LIMITS.deliverableNames + 1 }, (_, i) => `f${i}.md`) }),
        "invalid_shared_record",
        "run.deliverableNames",
      ],
      [run({ deliverableNames: "Q3 plan.xlsx" }), "invalid_shared_record", "run.deliverableNames"],
      [run({ revisionNumbers: [0] }), "invalid_shared_record", "run.revisionNumbers.0"],
      [run({ revisionNumbers: [1.5] }), "invalid_shared_record", "run.revisionNumbers.0"],
      [run({ revisionNumbers: ["2"] }), "invalid_shared_record", "run.revisionNumbers.0"],
      [run({ revisionNumbers: [1, 2, 2] }), "invalid_shared_record", "run.revisionNumbers"],
      [review({ revisionNumber: 3 }), "invalid_shared_record", "reviews.0.revisionNumber"],
      [review({ outcome: "approved" }), "invalid_shared_record", "reviews.0.outcome"],
      [review({ revisionID: "r-1" }), "invalid_shared_record", "reviews.0.revisionID"],
      [review({ decidedAt: "yesterday" }), "invalid_shared_record", "reviews.0.decidedAt"],
      // A Date encoded the Swift default way, as seconds since 2001, is not accepted.
      [review({ decidedAt: 781_000_000 }), "invalid_shared_record", "reviews.0.decidedAt"],
      [decision({ instanceID: 7 }), "invalid_shared_record", "decisions.0.instanceID"],
      [decision({ title: " " }), "invalid_shared_record", "decisions.0.title"],
      [decision({ title: "a\u0000b" }), "invalid_shared_record", "decisions.0.title"],
      [decision({ title: "x".repeat(SHARED_LIMITS.titleLength + 1) }), "invalid_shared_record", "decisions.0.title"],
      [{ ...base, brief: 7 }, "invalid_shared_record", "brief"],
      [{ ...base, brief: "x".repeat(SHARED_LIMITS.briefLength + 1) }, "invalid_shared_record", "brief"],
      [{ ...base, reviews: {} }, "invalid_shared_record", "reviews"],
    ];
    for (const [body, error, field] of cases) {
      const response = await publish(owner, id, RUN_A, body);
      expect(response.status, field).toBe(400);
      expect(await response.json()).toEqual({ error, field });
    }
    const tooLarge = await publish(owner, id, RUN_A, { ...base, brief: "x".repeat(SHARED_RECORD_MAX_BYTES) });
    expect(tooLarge.status).toBe(413);
    expect((await publish(owner, id, RUN_A, "{not json")).status).toBe(400);
    expect((await publish(owner, id, "..%2Fx", base)).status).toBe(400);
    expect(await stored(id)).toEqual({ records: [], index: undefined });
  });

  it("only an active owner holding company.configure publishes or withdraws", async () => {
    const { owner, id } = await companyWithOwner("alice-who");
    await addMember(owner, id, "dan-who", "admin");
    expect(
      (await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("dan-who"), grants: ["company.configure"] }))
        .status,
    ).toBe(200);
    await addMember(owner, id, "erin-who", "owner");
    expect((await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("erin-who"), grants: [] })).status).toBe(
      200,
    );
    await addMember(owner, id, "bob-who", "viewer");
    const admin = await sessionFor("dan-who");
    const ungranted = await sessionFor("erin-who");
    const viewer = await sessionFor("bob-who");
    const outsider = await sessionFor("mallory-who");

    const refusals: [Response, string][] = [
      [await publish(admin, id, RUN_A, record(RUN_A)), "owner_required"],
      [await publish(ungranted, id, RUN_A, record(RUN_A)), "grant_required"],
      [await publish(viewer, id, RUN_A, record(RUN_A)), "grant_required"],
      [await publish(outsider, id, RUN_A, record(RUN_A)), "forbidden"],
      [await op("PUT", `/v1/companies/${id}/shared/${RUN_A}`, record(RUN_A)), "unauthorized"],
      [await publish(owner, id, RUN_A, record(RUN_A), { csrf: null }), "csrf_required"],
    ];
    for (const [response, error] of refusals) {
      expect(response.status).toBe(error === "unauthorized" ? 401 : 403);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    expect(await stored(id)).toEqual({ records: [], index: undefined });

    expect((await publish(owner, id, RUN_A, record(RUN_A))).status).toBe(200);
    for (const response of [
      await withdraw(admin, id, RUN_A),
      await withdraw(ungranted, id, RUN_A),
      await withdraw(viewer, id, RUN_A),
      await withdraw(outsider, id, RUN_A),
      await withdraw(owner, id, RUN_A, { csrf: null }),
    ]) {
      expect(response.status).toBe(403);
    }
    expect((await op("DELETE", `/v1/companies/${id}/shared/${RUN_A}`)).status).toBe(401);
    expect((await read(owner, id, RUN_A)).status).toBe(200);
  });

  it("Update shared copy replaces the record in place, and Withdraw deletes it at once", async () => {
    const { owner, id } = await companyWithOwner("alice-withdraw");
    await addMember(owner, id, "bob-withdraw", "viewer");
    await setScope(owner, id, "bob-withdraw", [RUN_A]);
    const bob = await sessionFor("bob-withdraw");
    const first = ((await (await publish(owner, id, RUN_A, record(RUN_A))).json()) as { item: Item }).item;
    expect((await read(bob, id, RUN_A)).status).toBe(200);

    const updated = await publish(owner, id, RUN_A, { ...record(RUN_A), run: { ...record(RUN_A).run, state: "Done" } });
    expect(updated.status).toBe(200);
    const second = ((await updated.json()) as { item: Item }).item;
    expect(second.run.state).toBe("Done");
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    expect((await list(owner, id)).total).toBe(1);

    const withdrawn = await withdraw(owner, id, RUN_A);
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({ withdrawn: RUN_A, deleted: true });
    expect((await read(bob, id, RUN_A)).status).toBe(404);
    expect((await read(owner, id, RUN_A)).status).toBe(404);
    expect((await list(bob, id)).items).toEqual([]);
    expect(await stored(id)).toEqual({ records: [], index: [] });

    // A retried withdraw after a lost reply still succeeds.
    const retried = await withdraw(owner, id, RUN_A);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ withdrawn: RUN_A, deleted: false });
  });

  it("a narrowed scope or a revocation holds from the very next read", async () => {
    const { owner, id } = await companyWithOwner("alice-next");
    for (const run of [RUN_A, RUN_B]) expect((await publish(owner, id, run, record(run))).status).toBe(200);
    await addMember(owner, id, "bob-next", "viewer");
    await setScope(owner, id, "bob-next", [RUN_A, RUN_B]);
    const bob = await sessionFor("bob-next");
    expect((await read(bob, id, RUN_A)).status).toBe(200);

    await setScope(owner, id, "bob-next", [RUN_B]);
    expect((await read(bob, id, RUN_A)).status).toBe(404);
    expect((await list(bob, id)).items.map((item) => item.run.id)).toEqual([RUN_B]);

    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("bob-next") })).status).toBe(200);
    for (const response of [await read(bob, id, RUN_B), await co(bob, "GET", `/v1/companies/${id}/shared`)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    // Seated again, they get back the scope they had, never more.
    await addMember(owner, id, "bob-next", "viewer");
    expect((await read(bob, id, RUN_B)).status).toBe(200);
    expect((await read(bob, id, RUN_A)).status).toBe(404);
  });

  it("deleting the company deletes its shared records, even with sharing off", async () => {
    const { owner, id } = await companyWithOwner("alice-gone");
    for (const run of [RUN_A, RUN_B]) expect((await publish(owner, id, run, record(run))).status).toBe(200);
    expect((await stored(id)).records).toHaveLength(2);
    await sharing(false);
    expect((await co(owner, "DELETE", `/v1/companies/${id}`)).status).toBe(200);
    expect(await stored(id)).toEqual({ records: [], index: undefined });
    await sharing(true);
    // A company created again under the same id starts with nothing shared.
    await companyWithOwner("alice-gone", id);
    expect((await list(owner, id)).total).toBe(0);
    expect((await read(owner, id, RUN_A)).status).toBe(404);
  });

  it("pages the list within the caller's scope", async () => {
    const { owner, id } = await companyWithOwner("alice-page");
    for (const run of [RUN_A, RUN_B, RUN_C]) expect((await publish(owner, id, run, record(run))).status).toBe(200);
    const first = await list(owner, id, "?limit=2");
    expect(first.items.map((item) => item.run.id)).toEqual([RUN_A, RUN_B]);
    expect(first).toMatchObject({ nextCursor: "2", total: 3 });
    const rest = await list(owner, id, "?limit=2&cursor=2");
    expect(rest.items.map((item) => item.run.id)).toEqual([RUN_C]);
    expect(rest.nextCursor).toBeNull();
    for (const query of ["?limit=0", "?limit=51", "?limit=two", "?cursor=-1", "?cursor=1.5"]) {
      expect((await co(owner, "GET", `/v1/companies/${id}/shared${query}`)).status).toBe(400);
    }
    await addMember(owner, id, "bob-page", "viewer");
    await setScope(owner, id, "bob-page", [RUN_A, RUN_C]);
    const bob = await sessionFor("bob-page");
    const scoped = await list(bob, id, "?limit=1");
    expect(scoped.items.map((item) => item.run.id)).toEqual([RUN_A]);
    expect(scoped).toMatchObject({ nextCursor: "1", total: 2 });
    expect((await list(bob, id, "?limit=1&cursor=1")).items.map((item) => item.run.id)).toEqual([RUN_C]);
  });

  it("caps how many runs one company may publish", async () => {
    const { owner, id } = await companyWithOwner("alice-cap");
    const ns = (env as unknown as { COMPANY: DurableObjectNamespace }).COMPANY;
    const seeded = [RUN_A, ...Array.from({ length: MAX_SHARED_ITEMS - 1 }, (_, i) => `seed-${i}`)];
    await runInDurableObject(ns.get(ns.idFromName(`c:${id}`)) as never, async (_instance: unknown, state: { storage: Storage }) => {
      await state.storage.put("shared-index", seeded);
    });
    const full = await publish(owner, id, RUN_B, record(RUN_B));
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "shared_items_full", limit: MAX_SHARED_ITEMS });
    // A run already in the index can still be updated.
    expect((await publish(owner, id, RUN_A, record(RUN_A))).status).toBe(200);
    expect((await stored(id)).index).toHaveLength(MAX_SHARED_ITEMS);
  });
});

describe("the shared record check", () => {
  it("accepts the per-run fields of OfficeSharePayload and rebuilds them alone", () => {
    const checked = checkSharedRecord({ ...record(RUN_A), brief: "Plan Q3." }, RUN_A);
    expect(checked).toEqual({ ok: true, record: { ...record(RUN_A), brief: "Plan Q3." } });
    // Lists OfficeSharePayload decodes as empty may be left out, and so may the brief.
    expect(checkSharedRecord({ run: record(RUN_A).run }, RUN_A)).toEqual({
      ok: true,
      record: { run: record(RUN_A).run, reviews: [], decisions: [] },
    });
    // A multi-line decision title and brief keep their line breaks.
    const multiline = checkSharedRecord(
      { ...record(RUN_A), decisions: [{ instanceID: DECISION, runID: RUN_A, title: "Line one\nLine two" }], brief: "a\n\tb" },
      RUN_A,
    );
    expect(multiline.ok).toBe(true);
  });

  it("refuses a path id that cannot be a shared item", () => {
    expect(checkSharedRecord(record(RUN_A), "../x")).toEqual({ ok: false, error: "run_id_mismatch", field: "run.id" });
  });
});
