import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import {
  appendRows,
  authorizationUrl,
  createSheet,
  exchangeCode,
  googleConfig,
  pkceChallenge,
  readSheet,
  refreshAccess,
  revokeToken,
  type FetchImpl,
  type GoogleConfig,
} from "../src/google";
import { CLIENT_ID, CLIENT_SECRET, DRIVE_FILE, GOOGLE, REDIRECT } from "./google-fake";
import {
  auditOf,
  callbackPath,
  connect,
  enc,
  googleEnv,
  holdsNoToken,
  installGoogle,
  operator,
  send,
  sendJson,
  startConnect,
  status,
  vault,
  vaultRecords,
  world,
} from "./google-fixtures";
import { bindings, joinHelper, linkedOwner, setupShop } from "./people-fixtures";

// Connecting the owner's own Google account for Ton's books (google-connect.ts, google-vault.ts; docs/pilot-api.md,
// "Google Sheets for Ton's books"), end to end in real workerd against the real objects. Google is the fake in
// google-fake.ts, at the test-only origin in wrangler.test.json; every other outbound call answers 599, and a test
// fails if one was tried.

beforeEach(() => installGoogle());

afterEach(() => {
  expect(world.google.elsewhere).toEqual([]);
  vi.restoreAllMocks();
});

describe("off until the owner's OAuth client exists", () => {
  it("answers google_not_configured on every route, before anything else, and reaches no Google", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const routes: [string, string, unknown?][] = [["GET", "/v1/google"], ["POST", "/v1/google/connect", {}],
      ["POST", "/v1/google/disconnect", {}], ["GET", "/v1/google/callback?state=x&code=y"]];
    for (const target of [bindings, { ...bindings, GOOGLE_CLIENT_ID: CLIENT_ID } as Env,
      { ...bindings, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } as Env]) {
      for (const [method, path, body] of routes) {
        for (const headers of [owner.headers, {}]) {
          const answer = await sendJson(path, { method, headers, target, ...(body !== undefined ? { body } : {}) });
          expect(answer, `${method} ${path}`).toEqual({ status: 503, body: { error: "google_not_configured" } });
        }
      }
    }
    expect(world.google.calls).toEqual([]);
  });

  it("uses Google's own hosts unless the test origin is a .test name, and needs the public origin", () => {
    const base = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      PUBLIC_API_ORIGIN: "https://api.manut.xyz" };
    expect(googleConfig(base)).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      redirectUri: "https://api.manut.xyz/v1/google/callback", authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token", revokeUrl: "https://oauth2.googleapis.com/revoke",
      sheetsOrigin: "https://sheets.googleapis.com" });
    for (const fake of ["https://evil.example", "http://google.test", "https://google.test.example.com"]) {
      expect(googleConfig({ ...base, TEST_GOOGLE_ORIGIN: fake })?.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    }
    expect(googleConfig({ ...base, TEST_GOOGLE_ORIGIN: GOOGLE })?.tokenUrl).toBe(`${GOOGLE}/token`);
    const { PUBLIC_API_ORIGIN: _origin, ...noOrigin } = base;
    expect(googleConfig(noOrigin)).toBeNull();
    expect(googleConfig({ ...base, PUBLIC_API_ORIGIN: "http://api.manut.xyz" })).toBeNull();
    expect(googleConfig({ ...base, GOOGLE_CLIENT_SECRET: "  " })).toBeNull();
  });
});

describe("connecting the owner's Google account", () => {
  it("lets only the shop's owner reach the routes, and refuses a helper, no session, and the operator key", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop);
    for (const [method, path, body] of [["GET", "/v1/google"], ["POST", "/v1/google/connect", {}],
      ["POST", "/v1/google/disconnect", {}]] as const) {
      expect(await sendJson(path, { method, headers: helper.headers, ...(body ? { body } : {}) }), path)
        .toEqual({ status: 403, body: { error: "owner_only" } });
      expect((await sendJson(path, { method, ...(body ? { body } : {}) })).status, path).toBe(401);
      expect((await sendJson(path, { method, headers: { authorization: "Bearer test-key" }, ...(body ? { body } : {}) }))
        .status, path).toBe(401);
    }
    expect(world.google.calls).toEqual([]);
  });

  it("asks Google for drive.file only, offline, with consent, a state and an S256 challenge, and takes no field more", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const url = await startConnect(owner);
    expect(url.origin + url.pathname).toBe(`${GOOGLE}/o/oauth2/v2/auth`);
    const params = Object.fromEntries(url.searchParams);
    expect(Object.keys(params).sort()).toEqual(["access_type", "client_id", "code_challenge", "code_challenge_method",
      "prompt", "redirect_uri", "response_type", "scope", "state"]);
    expect(params).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: DRIVE_FILE,
      access_type: "offline", prompt: "consent", code_challenge_method: "S256" });
    // The sensitive read-write scope is never asked for.
    expect(url.href).not.toContain("auth/spreadsheets");
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.state).toMatch(/^mgs1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    // The secret never leaves the Worker: not in the address, and not in the answer.
    expect(url.href).not.toContain(CLIENT_SECRET);
    // Exact bodies and one method each; a shop or a role named in the query is refused.
    expect((await sendJson("/v1/google/connect", { method: "POST", headers: owner.headers,
      body: { tenant: shop.tenant } })).status).toBe(400);
    expect((await sendJson("/v1/google/connect", { headers: owner.headers })).status).toBe(405);
    expect((await sendJson(`/v1/google?shop=${enc(shop.tenant)}`, { headers: owner.headers })).status).toBe(400);
    expect(world.google.calls).toEqual([]);
  });

  it("checks the state and PKCE, seals the token, and refuses a replayed callback", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const url = await startConnect(owner);
    const answer = world.google.consent(url.href);
    const back = await send(callbackPath(answer));
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(back.headers.get("referrer-policy")).toBe("no-referrer");
    expect(back.headers.get("cache-control")).toBe("no-store");
    const page = await back.text();
    expect(page).toContain("Google is connected");

    // The exchange sent the verifier whose S256 is the challenge the consent page was given, with the client's secret in
    // the body, never in an address.
    const [exchange] = world.google.tokenCalls("authorization_code");
    expect(exchange?.get("code")).toBe(answer.code);
    expect(exchange?.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange?.get("client_secret")).toBe(CLIENT_SECRET);
    expect(await pkceChallenge(exchange!.get("code_verifier")!)).toBe(url.searchParams.get("code_challenge"));
    expect(world.google.calls.every((call) => call.url.search === "")).toBe(true);

    // The refresh token is sealed in the vault, and is in no answer, no stored record in plain text, and no log.
    const records = await vaultRecords(shop);
    const connections = Object.entries(records).filter(([key, record]) => key.startsWith("conn:") &&
      record.provider === "gsheets");
    expect(connections).toHaveLength(1);
    const [, stored] = connections[0]!;
    expect(stored).toMatchObject({ accountId: "google", scopes: [DRIVE_FILE], resourceIds: [], allowsActions: true,
      grantRevision: 1, revokedAt: null });
    expect((stored.sealed as { data: string }).data.length).toBeGreaterThan(0);
    holdsNoToken(JSON.stringify(records));
    holdsNoToken(page);
    const now = await status(owner);
    holdsNoToken(JSON.stringify(now));
    expect(now.connection).toMatchObject({ state: "working", sheet: null });
    // The sign-in is used up: the vault keeps no state for it.
    expect(Object.keys(records).filter((key) => key.startsWith("gflow:"))).toEqual([]);

    // The same callback again finds nothing, and Google is not asked again.
    const again = await send(callbackPath(answer));
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("already used");
    expect(world.google.tokenCalls("authorization_code")).toHaveLength(1);

    // A state this API never made, or one naming the shop that it never started, connects nothing.
    expect((await send(callbackPath({ state: "not-a-state", code: "4/x" }))).status).toBe(400);
    const forged = `mgs1.${url.searchParams.get("state")!.split(".")[1]}.${"0".repeat(64)}`;
    expect((await send(callbackPath({ state: forged, code: "4/x" }))).status).toBe(400);
    expect(world.google.tokenCalls("authorization_code")).toHaveLength(1);
    holdsNoToken(world.logged.join("\n"));

    const entries = await auditOf(shop);
    const connected = entries.filter((entry) => entry.action === "google.connected");
    expect(connected).toEqual([{ id: expect.any(String), at: expect.any(String), actor: { kind: "owner", id: owner.accountId },
      action: "google.connected", subject: { connectionId: now.connection!.id }, outcome: "ok" }]);
    holdsNoToken(JSON.stringify(entries));
  });

  it("refuses a code bound to another verifier, a state past its ten minutes, a refusal on Google's page, and a missing scope", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);

    // Google refuses a code whose challenge is not the one the Worker's verifier makes: nothing is stored.
    const url = await startConnect(owner);
    const wrong = world.google.consent(url.href, await pkceChallenge("a-verifier-this-worker-never-made-0123456789abc"));
    const refused = await send(callbackPath(wrong));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("did not accept");
    expect((await status(owner)).connected).toBe(false);

    // A state past its ten minutes is refused before Google is asked, and is gone.
    const late = await startConnect(owner);
    await runInDurableObject(vault(shop), async (_instance, state) => {
      for (const [key, flow] of await state.storage.list<Record<string, unknown>>({ prefix: "gflow:" })) {
        await state.storage.put(key, { ...flow, expiresAt: Date.now() - 1 });
      }
    });
    const before = world.google.calls.length;
    const tooOld = await send(callbackPath(world.google.consent(late.href)));
    expect(tooOld.status).toBe(410);
    expect(world.google.calls.length).toBe(before);

    // A newer sign-in replaces an older one that was never finished.
    const first = await startConnect(owner);
    const second = await startConnect(owner);
    expect((await send(callbackPath(world.google.consent(first.href)))).status).toBe(400);

    // The owner says no on Google's page: nothing is connected, and the state is used up.
    const declined = { state: second.searchParams.get("state")!, error: "access_denied" };
    const no = await send(callbackPath(declined));
    expect(no.status).toBe(200);
    expect(await no.text()).toContain("Google was not connected");
    expect((await send(callbackPath(declined))).status).toBe(400);

    // Google gives a token without the drive.file scope: it is not kept.
    world.google.grantedScope = "openid";
    const narrow = await startConnect(owner);
    const noScope = await send(callbackPath(world.google.consent(narrow.href)));
    expect(noScope.status).toBe(400);
    expect((await status(owner)).connected).toBe(false);
    expect(Object.keys(await vaultRecords(shop)).filter((key) => key.startsWith("conn:") ||
      key.startsWith("gflow:"))).toEqual([`conn:${shop.connectionId}`]);
    expect((await auditOf(shop)).filter((entry) => entry.action === "google.connected")
      .map((entry) => [entry.outcome, entry.reason])).toEqual([["declined", "access_denied"]]);
  });

  it("checks that the owner session which started a sign-in still holds when Google sends the browser back", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const url = await startConnect(owner);
    // The operator unlinks the owner's account meanwhile.
    expect((await operator("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    const back = await send(callbackPath(world.google.consent(url.href)));
    expect(back.status).toBe(401);
    expect(world.google.tokenCalls("authorization_code")).toEqual([]);
  });

  it("replaces the first connection with a second, without revoking at Google, and disconnecting revokes and forgets", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const first = await connect(owner);
    const second = await connect(owner);
    expect(second).not.toBe(first);
    const records = await vaultRecords(shop);
    expect(records[`conn:${first}`]).toMatchObject({ provider: "gsheets", revokedAt: expect.any(String),
      sealed: { keyTag: "", iv: "", data: "" } });
    expect(records[`conn:${second}`]).toMatchObject({ provider: "gsheets", revokedAt: null });
    // Revoking at Google would end the whole grant, the new token's too when the same account connects again.
    expect(world.google.revokes()).toEqual([]);
    expect((await auditOf(shop)).find((entry) => entry.action === "google.connected" &&
      entry.subject.connectionId === second)?.subject).toEqual({ connectionId: second, previousConnectionId: first });

    const [, secondToken] = [...world.google.refreshTokens.keys()];
    const disconnected = await sendJson("/v1/google/disconnect", { method: "POST", headers: owner.headers, body: {} });
    expect(disconnected).toEqual({ status: 200, body: { disconnected: true, revoked: true } });
    // The token went to Google's revoke endpoint in the body, never in the address.
    expect(world.google.revokes()).toHaveLength(1);
    expect(new URLSearchParams(world.google.revokes()[0]!.body).get("token")).toBe(secondToken);
    expect(world.google.revokes()[0]!.url.search).toBe("");
    expect(world.google.refreshTokens.get(secondToken!)?.revoked).toBe(true);
    expect((await vaultRecords(shop))[`conn:${second}`]).toMatchObject({ revokedAt: expect.any(String),
      sealed: { keyTag: "", iv: "", data: "" } });
    expect(await status(owner)).toEqual({ connected: false, connection: null });
    expect(await sendJson("/v1/google/disconnect", { method: "POST", headers: owner.headers, body: {} }))
      .toEqual({ status: 404, body: { error: "not_connected" } });

    // Google cannot be reached: the token is forgotten all the same, and the answer says it was not revoked.
    await connect(owner);
    world.google.revokeAnswer = "throw";
    expect(await sendJson("/v1/google/disconnect", { method: "POST", headers: owner.headers, body: {} }))
      .toEqual({ status: 200, body: { disconnected: true, revoked: false } });
    expect(await status(owner)).toEqual({ connected: false, connection: null });
    expect((await auditOf(shop)).filter((entry) => entry.action === "google.disconnected").map((entry) => entry.reason))
      .toEqual(["not_revoked", undefined]);
  });

  it("keeps the generic connection routes from storing a Google token, so the sign-in is the only way in", async () => {
    const shop = await setupShop();
    const stored = await operator("POST", "/v1/admin/connections", { tenantId: shop.tenant, provider: "gsheets",
      accountId: "google", scopes: [DRIVE_FILE], refreshToken: "1//planted", allowsActions: true });
    expect(stored.status).toBe(400);
    // Nor can anything but this API's own code reach the vault's Google operations.
    const direct = await vault(shop).fetch(new Request("https://cred/google/connections", { method: "POST",
      headers: { "x-tenant": shop.tenant, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "1//planted", scopes: [DRIVE_FILE] }) }));
    expect(direct.status).toBe(403);
  });

  it("limits the public callback per address before reading anything, and fails closed without its limiter", async () => {
    const { GOOGLE_CALLBACK_LIMITER: _limiter, ...unlimited } = googleEnv;
    expect(await sendJson("/v1/google/callback?state=x&code=y", { target: unlimited as Env }))
      .toEqual({ status: 503, body: { error: "rate_limit_unavailable" } });
    // The real binding: 30 a minute from one address. Off, each answers google_not_configured until the limit.
    const fill = async () => {
      const ip = `2001:db8::${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}`;
      const answers: number[] = [];
      for (let index = 0; index <= 30; index++) {
        const context = createExecutionContext();
        const response = await worker.fetch(new Request("https://api.manut.test/v1/google/callback?state=x",
          { headers: { "cf-connecting-ip": ip } }), bindings, context);
        await waitOnExecutionContext(context);
        answers.push(response.status);
      }
      return answers;
    };
    // The limiter counts in 60-second windows; on a loaded machine the run can cross one, so it is tried once more.
    let answers = await fill();
    if (answers.at(-1) !== 429) answers = await fill();
    expect(answers.slice(0, 30).every((code) => code === 503)).toBe(true);
    expect(answers.at(-1)).toBe(429);
  });
});

describe("the vault's Google operations", () => {
  it("lets one claim make the sheet, binds only that claim's sheet under a new revision, and marks a refusal broken once", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const id = await connect(owner);
    const google = (path: string, body: unknown) => vault(shop).fetch(new Request(`https://cred${path}`, { method: "POST",
      headers: { "x-tenant": shop.tenant, "x-google": "1", "content-type": "application/json" },
      body: JSON.stringify(body) })).then(async (response) => ({ status: response.status,
      body: (await response.json()) as Record<string, unknown> }));

    const claimed = await google("/google/sheet-claim", { id, replacing: null });
    expect(claimed.status).toBe(200);
    expect(await google("/google/sheet-claim", { id, replacing: null }))
      .toEqual({ status: 409, body: { error: "sheet_in_progress" } });
    const sheet = { id: "sheet_1", title: "Manut AI books: Baan Mali", tab: "Books",
      url: "https://docs.google.com/spreadsheets/d/sheet_1/edit" };
    expect(await google("/google/sheet", { id, claim: "not-the-claim", sheet }))
      .toEqual({ status: 409, body: { error: "claim_lost" } });
    expect(await google("/google/sheet", { id, claim: claimed.body.claim, sheet })).toMatchObject({ status: 200,
      body: { grantRevision: 2, sheet: { ...sheet, madeAt: expect.any(String) } } });
    expect((await vaultRecords(shop))[`conn:${id}`]).toMatchObject({ resourceIds: ["sheet_1"], grantRevision: 2 });
    // Someone made one meanwhile: a claim that found none is refused, so a second sheet is never made.
    expect(await google("/google/sheet-claim", { id, replacing: null }))
      .toEqual({ status: 409, body: { error: "sheet_changed" } });
    // A claim given back frees the way for the next.
    const again = await google("/google/sheet-claim", { id, replacing: "sheet_1" });
    expect(await google("/google/sheet-release", { id, claim: again.body.claim })).toEqual({ status: 200,
      body: { released: true } });
    expect((await google("/google/sheet-claim", { id, replacing: "sheet_1" })).status).toBe(200);

    expect(await google("/google/broken", { id, reason: "invalid_grant" }))
      .toEqual({ status: 200, body: { broken: true, newly: true } });
    expect(await google("/google/broken", { id, reason: "invalid_grant" }))
      .toEqual({ status: 200, body: { broken: true, newly: false } });
    expect(await google("/google/sheet-claim", { id, replacing: "sheet_1" }))
      .toEqual({ status: 409, body: { error: "connection_broken" } });
    expect((await status(owner)).connection).toEqual({ id, connectedAt: expect.any(String), state: "broken",
      broken: { at: expect.any(String), reason: "invalid_grant",
        words: "Google no longer lets Manut AI into your sheet: the access was removed or ran out. Connect Google again." },
      sheet: { id: "sheet_1", title: "Manut AI books: Baan Mali", tab: "Books",
        url: "https://docs.google.com/spreadsheets/d/sheet_1/edit" } });
    // Connecting again mends it, keeps the sheet, and makes the sheet the new connection's one resource.
    const mended = await connect(owner);
    expect((await status(owner)).connection).toMatchObject({ id: mended, state: "working", sheet: { id: "sheet_1" } });
    expect((await vaultRecords(shop))[`conn:${mended}`]).toMatchObject({ resourceIds: ["sheet_1"], grantRevision: 1 });

    // The tenant's wipe takes a sign-in in flight with everything else.
    await startConnect(owner);
    expect(Object.keys(await vaultRecords(shop)).some((key) => key.startsWith("gflow:"))).toBe(true);
    const wiped = await vault(shop).fetch(new Request("https://cred/tenant-wipe", { method: "POST",
      headers: { "x-wipe": "1", "content-type": "application/json" }, body: JSON.stringify({ tenant: shop.tenant }) }));
    expect(wiped.status).toBe(200);
    expect(Object.keys(await vaultRecords(shop)).filter((key) => key.startsWith("gflow:") || key.startsWith("conn:")))
      .toEqual([]);
  });
});

describe("Google's answers, classified", () => {
  const config = googleConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    PUBLIC_API_ORIGIN: "https://api.manut.test", TEST_GOOGLE_ORIGIN: GOOGLE }) as GoogleConfig;
  const answering = (status: number, body: unknown = {}): FetchImpl => async () => Response.json(body, { status });
  const dropped: FetchImpl = async () => {
    throw new TypeError("connection dropped");
  };
  const request = { method: "POST" as const, path: "/v4/spreadsheets/abc/values/Books!A1:append",
    query: { valueInputOption: "RAW" as const, insertDataOption: "INSERT_ROWS" as const },
    body: { range: "Books!A1", majorDimension: "ROWS" as const, values: [] } };

  it("settles an append as confirmed only on success, failed only on a refusal, and unknown otherwise", async () => {
    expect(await appendRows(answering(200, { updates: { updatedRange: "Books!A1:G2", updatedRows: 2 } }), config, "t",
      request)).toEqual({ outcome: "confirmed", updatedRange: "Books!A1:G2", updatedRows: 2 });
    for (const refused of [400, 401, 403, 404, 429]) {
      expect(await appendRows(answering(refused), config, "t", request))
        .toEqual({ outcome: "failed", code: `google_${refused}` });
    }
    for (const unclear of [408, 409, 500, 502, 503, 504]) {
      expect(await appendRows(answering(unclear), config, "t", request))
        .toEqual({ outcome: "unknown", code: `google_${unclear}` });
    }
    expect(await appendRows(dropped, config, "t", request)).toEqual({ outcome: "unknown", code: "no_answer" });
  });

  it("tells a refused grant from no answer, and keeps no token it was not given", async () => {
    expect(await refreshAccess(answering(400, { error: "invalid_grant" }), config, "r"))
      .toEqual({ ok: false, error: "invalid_grant" });
    expect(await refreshAccess(answering(401, { error: "invalid_client" }), config, "r"))
      .toEqual({ ok: false, error: "refused" });
    expect(await refreshAccess(answering(503), config, "r")).toEqual({ ok: false, error: "unreachable" });
    expect(await refreshAccess(dropped, config, "r")).toEqual({ ok: false, error: "unreachable" });
    expect(await exchangeCode(answering(200, { access_token: "a", scope: DRIVE_FILE }), config, "c", "v"))
      .toEqual({ ok: false, error: "no_refresh_token" });
    expect(await revokeToken(answering(400, { error: "invalid_token" }), config, "r")).toBe(true);
    expect(await revokeToken(answering(400, { error: "invalid_request" }), config, "r")).toBe(false);
    expect(await readSheet(answering(404), config, "a", "abc")).toEqual({ state: "gone" });
    expect(await readSheet(answering(500), config, "a", "abc")).toEqual({ state: "unreachable" });
    expect(await createSheet(answering(200, { spreadsheetId: "../etc" }), config, "a", "T", "Books")).toBeNull();
  });

  it("builds Google's consent address from the config alone, with the state and challenge given", async () => {
    const real = googleConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      PUBLIC_API_ORIGIN: "https://api.manut.xyz" })!;
    const url = new URL(authorizationUrl(real, "mgs1.c2hvcA.00", await pkceChallenge("v".repeat(43))));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.manut.xyz/v1/google/callback");
    expect(url.searchParams.get("code_challenge")).toBe(await pkceChallenge("v".repeat(43)));
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});
