import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { googleConfig, revokeToken } from "../src/google";
import { authCall, tenantDelete, type TenantDataEnv } from "../src/tenant-data";
import { CLIENT_ID, CLIENT_SECRET, GOOGLE } from "./google-fake";
import {
  connect,
  googleEnv,
  holdsNoToken,
  installGoogle,
  operator,
  paidIn,
  readyShop,
  askBooks,
  decide,
  lastMonth,
  send,
  status,
  vaultRecords,
  world,
} from "./google-fixtures";
import { bindings, linkedOwner, type Shop } from "./people-fixtures";

// Deleting a shop's data revokes its Google token at Google before the vault forgets it (tenant-data.ts, `revokeGoogle`;
// docs/pilot-api.md, "Export and deletion"), as `POST /v1/google/disconnect` does, in the operator's path and in the owner's.
// Google being unreachable never stops the deletion: the answer and the deletion's record say how many connections were and
// were not revoked, never with a token. End to end in real workerd against the real objects, with Google the fake in
// google-fake.ts.

beforeEach(() => installGoogle());

afterEach(() => {
  expect(world.google.elsewhere).toEqual([]);
  vi.restoreAllMocks();
});

const WEB = "https://app.manut.test";

/// A pilot shop that never went live (no consent, no LINE connection), with its owner signed in and Google connected.
async function newShopWithGoogle(name = "Baan Somtam"): Promise<{ shop: Shop; connectionId: string; token: string }> {
  const created = await operator("POST", "/v1/admin/pilot/shops", { name, ownerName: "Fon" }, googleEnv);
  expect(created.status).toBe(200);
  const { tenant } = (await created.json()) as { tenant: string };
  const shop: Shop = { tenant, connectionId: "", name };
  const owner = await linkedOwner(shop);
  const connectionId = await connect(owner);
  return { shop, connectionId, token: refreshTokenOf(shop) };
}

/// The refresh token the shop's vault holds for its live Google connection: read from the vault's own storage, since no
/// route gives it out. Used only to look for it in what the deletion answered and wrote.
function refreshTokenOf(_shop: Shop): string {
  const tokens = [...world.google.refreshTokens.keys()];
  expect(tokens).toHaveLength(1);
  return tokens[0]!;
}

async function askToDelete(env: Env, shop: Shop) {
  const response = await operator("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: shop.name }, env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/// The owner's yes on the deletion link an operator's request for a live shop gave out.
async function ownerSaysYes(env: Env, confirmUrl: string) {
  const token = confirmUrl.slice(`${WEB}/delete/`.length);
  const response = await send(`/v1/pilot/deletions/${token}/decision`, { method: "POST", body: { approve: true },
    target: env });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/// The deletion's own record, which outlives the shop.
async function deletionCounts(shop: Shop): Promise<Record<string, number> | undefined> {
  const response = await authCall(bindings, `/pilot-deletions?tenant=${encodeURIComponent(shop.tenant)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { deletion: { counts?: Record<string, number> } | null }).deletion?.counts;
}

/// The vault's connection records for the shop, as stored: none once it was wiped.
async function connectionRecords(shop: Shop) {
  return Object.keys(await vaultRecords(shop)).filter((key) => key.startsWith("conn:"));
}

/// The Worker's environment with one kind of call to one object failing the next `times` times, as when an object cannot be
/// reached part way through a deletion. Every other call reaches the real objects, and Google is still the fake's.
function failingCalls(binding: "CRED" | "SCHEDULES", method: string, path: string, times: number): Env {
  let left = times;
  const namespace = googleEnv[binding];
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === method && new URL(request.url).pathname === path && left > 0) {
          left--;
          return Response.json({ error: "fixture_call_failed" }, { status: 500 });
        }
        return stub.fetch(request);
      } };
    },
  } as unknown as DurableObjectNamespace;
  return { ...googleEnv, [binding]: wrapped };
}

describe("the operator's deletion of a shop that never went live", () => {
  it("revokes the shop's Google token at Google before its vault forgets it, and says so", async () => {
    const { shop, token } = await newShopWithGoogle();
    expect(world.google.refreshTokens.get(token)).toEqual({ revoked: false });
    expect(await connectionRecords(shop)).toHaveLength(1);

    const deleted = await askToDelete(googleEnv, shop);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ tasksWiped: 0, connectionsWiped: 1, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: expect.any(Number), googleRevoked: 1, googleNotRevoked: 0, deletedAt: expect.any(String) });

    // Google was told, once, with the shop's own token in the body; the fake revokes only a token it handed out, so a token
    // the vault had already forgotten would have been answered `invalid_token` and left the grant standing.
    expect(world.google.revokes()).toHaveLength(1);
    expect(new URLSearchParams(world.google.revokes()[0]!.body).get("token")).toBe(token);
    expect(world.google.revokes()[0]!.url.search).toBe("");
    expect(world.google.refreshTokens.get(token)).toEqual({ revoked: true });
    // Then the vault forgot it with everything else of the shop, and the deletion's record keeps the counts.
    expect(await connectionRecords(shop)).toEqual([]);
    expect(await deletionCounts(shop)).toMatchObject({ connectionsWiped: 1, googleRevoked: 1, googleNotRevoked: 0 });
    holdsNoToken(JSON.stringify(deleted.body));
    holdsNoToken(world.logged.join("\n"));
  });

  it("completes when Google cannot be reached, says the grant still stands, and never holds the token", async () => {
    const { shop, token } = await newShopWithGoogle();
    world.google.revokeAnswer = "throw";
    const deleted = await askToDelete(googleEnv, shop);
    expect(deleted).toMatchObject({ status: 200, body: { connectionsWiped: 1, googleRevoked: 0, googleNotRevoked: 1,
      deletedAt: expect.any(String) } });
    // Google was tried, and its token is still good there; the shop's data is gone all the same.
    expect(world.google.revokes()).toHaveLength(1);
    expect(world.google.refreshTokens.get(token)).toEqual({ revoked: false });
    expect(await connectionRecords(shop)).toEqual([]);
    expect(await deletionCounts(shop)).toMatchObject({ googleRevoked: 0, googleNotRevoked: 1 });
    holdsNoToken(JSON.stringify(deleted.body));
    holdsNoToken(JSON.stringify(await vaultRecords(shop)));
    holdsNoToken(world.logged.join("\n"));
  });

  it("counts a connection as not revoked, reaching Google not at all, where Google is not set up", async () => {
    const { shop } = await newShopWithGoogle();
    const calls = world.google.calls.length;
    // The owner's client was taken out of this environment after the shop connected: there is nothing to ask Google with.
    const deleted = await askToDelete(bindings, shop);
    expect(deleted).toMatchObject({ status: 200, body: { connectionsWiped: 1, googleRevoked: 0, googleNotRevoked: 1 } });
    expect(world.google.calls.length).toBe(calls);
    expect(await connectionRecords(shop)).toEqual([]);
  });

  it("answers exactly as it did before for a shop with no Google connection, and asks Google nothing", async () => {
    const created = await operator("POST", "/v1/admin/pilot/shops", { name: "Baan Dao", ownerName: "Dao" }, googleEnv);
    const { tenant } = (await created.json()) as { tenant: string };
    const calls = world.google.calls.length;
    const deleted = await askToDelete(googleEnv, { tenant, connectionId: "", name: "Baan Dao" });
    expect(deleted).toEqual({ status: 200, body: { tasksWiped: 0, connectionsWiped: 0, schedulesWiped: 0,
      occurrencesWiped: 0, sessionsWiped: expect.any(Number), deletedAt: expect.any(String) } });
    expect(world.google.calls.length).toBe(calls);
  });

  it("revokes once for a connection that broke, whose token Google may already have ended", async () => {
    const { shop, token } = await newShopWithGoogle();
    // The owner removed Manut AI in their Google account: Google no longer knows the token, and answers `invalid_token`.
    world.google.refreshTokens.delete(token);
    const deleted = await askToDelete(googleEnv, shop);
    expect(deleted).toMatchObject({ status: 200, body: { googleRevoked: 1, googleNotRevoked: 0 } });
    expect(world.google.revokes()).toHaveLength(1);
  });
});

describe("the owner's yes on their deletion link", () => {
  it("revokes the shop's Google token before the shop's data goes", async () => {
    const { shop, owner } = await readyShop();
    const token = [...world.google.refreshTokens.keys()][0]!;
    const asked = await askToDelete(googleEnv, shop);
    expect(asked).toMatchObject({ status: 202, body: { status: "awaiting_owner" } });
    // Asking deletes nothing, and revokes nothing.
    expect(world.google.revokes()).toEqual([]);
    expect((await status(owner)).connected).toBe(true);

    const decided = await ownerSaysYes(googleEnv, asked.body.confirmUrl as string);
    expect(decided).toMatchObject({ status: 200, body: { state: "deleted" } });
    expect(world.google.revokes()).toHaveLength(1);
    expect(world.google.refreshTokens.get(token)).toEqual({ revoked: true });
    expect(await connectionRecords(shop)).toEqual([]);
    // The shop's LINE connection and its Google connection, both forgotten; only Google's was Google's to be told of.
    expect(await deletionCounts(shop)).toMatchObject({ connectionsWiped: 2, googleRevoked: 1, googleNotRevoked: 0 });
    holdsNoToken(JSON.stringify(decided.body));
    holdsNoToken(world.logged.join("\n"));
  });

  it("goes through when Google cannot be reached, and the deletion's record keeps that it was not revoked", async () => {
    const { shop } = await readyShop();
    const asked = await askToDelete(googleEnv, shop);
    world.google.revokeAnswer = "throw";
    const decided = await ownerSaysYes(googleEnv, asked.body.confirmUrl as string);
    expect(decided).toMatchObject({ status: 200, body: { state: "deleted" } });
    expect(await connectionRecords(shop)).toEqual([]);
    expect(await deletionCounts(shop)).toMatchObject({ googleRevoked: 0, googleNotRevoked: 1 });
  });

  it("revokes a token whose books were asked for and sent, and leaves nothing of the shop but its record", async () => {
    const { shop, owner } = await readyShop();
    const month = lastMonth();
    await paidIn(shop, month, [{ orderRef: "SP-1", amountSatang: 4_200 }]);
    const asked = await askBooks(owner, month);
    expect((await decide(owner.headers, asked.body.requestId!)).body.action).toBe("confirmed");
    const asked2 = await askToDelete(googleEnv, shop);
    const decided = await ownerSaysYes(googleEnv, asked2.body.confirmUrl as string);
    expect(decided.body.state).toBe("deleted");
    expect(world.google.revokes()).toHaveLength(1);
    expect(JSON.stringify(await vaultRecords(shop))).not.toContain("SP-1");
  });
});

describe("a deletion that stops part way", () => {
  it("names the revoke on the answer of the run that stopped, and a second run finishes with nothing left to revoke", async () => {
    const { shop } = await newShopWithGoogle();
    const stopped = await askToDelete(failingCalls("SCHEDULES", "POST", "/tenant-wipe", 1), shop);
    expect(stopped).toMatchObject({ status: 500, body: { error: "wipe_incomplete", failed: ["schedules"],
      googleRevoked: 1, googleNotRevoked: 0 } });
    expect(world.google.revokes()).toHaveLength(1);
    // The vault was wiped with the revoke done, so the same request, sent again, finishes it and asks Google nothing more.
    const finished = await askToDelete(googleEnv, shop);
    expect(finished.status).toBe(200);
    expect(finished.body).not.toHaveProperty("googleRevoked");
    expect(world.google.revokes()).toHaveLength(1);
  });

  it("does not wipe the vault, and so forgets no token it did not look at, when the vault cannot be listed", async () => {
    const { shop, token } = await newShopWithGoogle();
    const stopped = await askToDelete(failingCalls("CRED", "GET", "/connections", 1), shop);
    expect(stopped).toMatchObject({ status: 500, body: { error: "wipe_incomplete", failed: ["connections"] } });
    // The sealed token is still there to revoke, and nothing went to Google.
    expect(await connectionRecords(shop)).toHaveLength(1);
    expect(world.google.revokes()).toEqual([]);
    const finished = await askToDelete(googleEnv, shop);
    expect(finished).toMatchObject({ status: 200, body: { googleRevoked: 1, googleNotRevoked: 0 } });
    expect(world.google.refreshTokens.get(token)).toEqual({ revoked: true });
  });
});

describe("tenantDelete with its own Google", () => {
  const stubbed = (reached: string[], connections: unknown) => {
    const answers: Record<string, (request: Request) => Response> = {
      "TENANT GET /index": () => Response.json({ taskIds: [] }),
      "CRED GET /connections": () => Response.json({ connections }),
      "CRED POST /use": () => Response.json({ refreshToken: "1//stub-refresh" }),
      "CRED POST /tenant-wipe": () => Response.json({ connectionsWiped: 1 }),
      "SCHEDULES POST /tenant-wipe": () => Response.json({ schedulesWiped: 0, occurrencesWiped: 0 }),
      "AUTH POST /tenant-wipe": () => Response.json({ sessionsWiped: 0 }),
      "TENANT POST /tenant-wipe": () => Response.json({ deletedAt: "2026-11-24T00:00:00.000Z", tasksWiped: 0 }),
      "AUTH DELETE /pilot-shops": () => Response.json({ removed: true }),
    };
    const namespace = (ns: string) => ({ idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      const key = `${ns} ${request.method} ${new URL(request.url).pathname}`;
      reached.push(key);
      return answers[key] ? answers[key]!(request) : Response.json({ error: "unexpected_call" }, { status: 599 });
    } }) });
    return { TASK: namespace("TASK"), AUTH: namespace("AUTH"), CRED: namespace("CRED"), SCHEDULES: namespace("SCHEDULES"),
      TENANT: namespace("TENANT"), GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      PUBLIC_API_ORIGIN: "https://api.manut.test", TEST_GOOGLE_ORIGIN: GOOGLE } as unknown as TenantDataEnv & Env;
  };

  it("asks Google to end the token between listing the vault and wiping it, with the fetch it is given", async () => {
    const reached: string[] = [];
    const seen: { url: string; body: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      reached.push("GOOGLE revoke");
      seen.push({ url, body: String(init?.body) });
      return new Response(null, { status: 200 });
    };
    const answer = await tenantDelete(stubbed(reached, [{ id: "c1", provider: "linear" }, { id: "g1", provider: "gsheets" }]),
      "pilot:stub", { fetchImpl });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ googleRevoked: 1, googleNotRevoked: 0, connectionsWiped: 1 });
    // Only the Google connection, once, and before the vault's wipe.
    expect(reached.filter((step) => step.startsWith("CRED") || step.startsWith("GOOGLE"))).toEqual([
      "CRED GET /connections", "CRED POST /use", "GOOGLE revoke", "CRED POST /tenant-wipe"]);
    expect(seen).toEqual([{ url: `${GOOGLE}/revoke`, body: "token=1%2F%2Fstub-refresh" }]);
    expect(googleConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      PUBLIC_API_ORIGIN: "https://api.manut.test", TEST_GOOGLE_ORIGIN: GOOGLE })?.revokeUrl).toBe(`${GOOGLE}/revoke`);
  });

  it("counts a connection whose secret will not open, or whose revoke throws, as not revoked, and goes on", async () => {
    for (const [label, env, fetchImpl] of [
      ["the revoke throws", stubbed([], [{ id: "g1", provider: "gsheets" }]), async () => { throw new TypeError("down"); }],
      ["the secret will not open", (() => {
        const reached: string[] = [];
        const env = stubbed(reached, [{ id: "g1", provider: "gsheets" }]);
        (env.CRED as unknown as { get: () => unknown }).get = () => ({ fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/use") return Response.json({ error: "unseal_failed" }, { status: 500 });
          if (path === "/connections") return Response.json({ connections: [{ id: "g1", provider: "gsheets" }] });
          return Response.json({ connectionsWiped: 1 });
        } });
        return env;
      })(), async () => new Response(null, { status: 200 })],
    ] as const) {
      const answer = await tenantDelete(env, "pilot:stub", { fetchImpl });
      expect(answer.status, label).toBe(200);
      expect(await answer.json(), label).toMatchObject({ googleRevoked: 0, googleNotRevoked: 1 });
    }
  });

  it("refuses to wipe the vault when it cannot be listed, however it fails", async () => {
    for (const listing of [() => Response.json({ error: "boom" }, { status: 500 }), () => new Response("not json")]) {
      const reached: string[] = [];
      const env = stubbed(reached, []);
      const cred = env.CRED as unknown as { get: () => { fetch: (request: Request) => Promise<Response> } };
      const real = cred.get();
      cred.get = () => ({ fetch: async (request: Request) => (new URL(request.url).pathname === "/connections"
        ? listing() : real.fetch(request)) });
      const answer = await tenantDelete(env, "pilot:stub");
      expect(answer.status).toBe(500);
      expect(await answer.json()).toMatchObject({ error: "wipe_incomplete", failed: ["connections"] });
      expect(reached).not.toContain("CRED POST /tenant-wipe");
    }
  });

  it("revokes only what Google treats as revoked: a refusal other than an already-ended token is not", async () => {
    const config = googleConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      PUBLIC_API_ORIGIN: "https://api.manut.test", TEST_GOOGLE_ORIGIN: GOOGLE })!;
    expect(await revokeToken(async () => Response.json({ error: "invalid_token" }, { status: 400 }), config, "t")).toBe(true);
    expect(await revokeToken(async () => Response.json({ error: "invalid_request" }, { status: 400 }), config, "t")).toBe(false);
    expect(await revokeToken(async () => new Response(null, { status: 503 }), config, "t")).toBe(false);
  });

  it("is the same path every deletion takes: the person's own tenant has no Google, and its answer is unchanged", async () => {
    const reached: string[] = [];
    const answer = await tenantDelete(stubbed(reached, []), "person-tenant");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ tasksWiped: 0, connectionsWiped: 1, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: 0, deletedAt: "2026-11-24T00:00:00.000Z" });
    expect(reached.filter((step) => step.startsWith("CRED"))).toEqual(["CRED GET /connections", "CRED POST /tenant-wipe"]);
  });
});
