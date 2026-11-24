import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { credStub, scheduleStub, tenantCall } from "../src/tenant-data";
import { asSession, bindings, emailSignIn, setFlags, signIn } from "./people-fixtures";

// The lifted routes (index.ts, `contextOf`) and a person's own sign-in by email. The security review of 24 Nov 2026
// found that once email sign-in is on, anyone could sign in and use every lifted session route for a tenant of their own:
// cloud tasks, schedules that fire, a Linear token stored and read through this API, and the tenant wipe, which scans
// every session. A person's email sign-in is refused on all of them now, as a shop session is, but for the three reads
// the desktop makes for a person in no shop, which find nothing.

const ROUTE = /^\/v1\//;
const enc = encodeURIComponent;

/// Every lifted route a person's email sign-in is refused on, with a body where the route reads one, and why.
const REFUSED: [string, string, unknown?][] = [
  // Connections are the operator's or a shop's (LINE, Google); this one would store a Linear token for anyone, and the
  // issues route would read Linear through this API with it.
  ["POST", "/v1/connections", { provider: "linear", accountId: "workspace-x", scopes: ["read"], resourceIds: ["p"],
    refreshToken: "a-stranger's-token" }],
  ["GET", "/v1/connections"],
  ["DELETE", "/v1/connections/connection-x"],
  ["GET", "/v1/connections/connection-x/linear/issues?updatedSince=2026-01-01T00:00:00Z&first=5&projectIds=p"],
  // Consent to cloud work is a shop's, given from its owner's session or link (shops.ts, pilot.ts).
  ["GET", "/v1/consent/cloud"],
  ["PUT", "/v1/consent/cloud", { enabled: true }],
  // A shop is deleted with its owner's yes on the deletion link; the wipe also scans every session.
  ["DELETE", "/v1/tenant/data"],
  // Schedules that fire mint cloud tasks; reading one by id is no read the desktop makes.
  ["POST", "/v1/schedules", { id: "schedule-x", name: "x", prompt: "x", hour: 8, minute: 0, weekdays: [1],
    timeZone: "Asia/Bangkok", hasSchedulingConsent: true }],
  ["GET", "/v1/schedules/schedule-x"],
  ["DELETE", "/v1/schedules/schedule-x"],
  // Cloud tasks and their executor's protocol: the team's work is the job flow's, inside the Worker, never these.
  ["POST", "/v1/tasks", { id: "task-x", location: "cloud" }],
  ["GET", "/v1/tasks/task-x"],
  ["PUT", "/v1/tasks/task-x", { id: "task-x" }],
  ["POST", "/v1/tasks/task-x/commands", { type: "queue" }],
  ["POST", "/v1/tasks/task-x/attempts", {}],
  ["POST", "/v1/tasks/task-x/attempts/attempt-x/heartbeat", {}],
  ["POST", "/v1/tasks/task-x/actions", {}],
  ["GET", "/v1/tasks/task-x/actions/action-x"],
  ["POST", "/v1/tasks/task-x/actions/action-x/decision", { approve: true }],
  ["POST", "/v1/tasks/task-x/actions/action-x/dispatch", { grantRevision: 1 }],
  ["GET", "/v1/tasks/task-x/events"],
  ["GET", "/v1/tasks/task-x/events/wait?timeoutMs=100"],
  // Companies are the lifted product's, not a shop's.
  ["POST", "/v1/companies", { name: "x" }],
  ["GET", "/v1/companies/mine"],
  ["GET", "/v1/companies/company-x"],
  ["GET", "/v1/companies/company-x/tasks"],
  ["GET", "/v1/companies/company-x/template"],
  ["GET", "/v1/companies/company-x/shared"],
  ["POST", "/v1/companies/import-template", { template: {} }],
];

describe("a person's own sign-in by email on the lifted routes", () => {
  it("is refused on every route that acts for a tenant's cloud work, connections, consent, data or companies", async () => {
    expect((await setFlags({ officeCloud: true, officeRoutines: true, officeExternalWrites: true, officeInbound: true,
      officeSharing: true })).status).toBe(200);
    const person = await emailSignIn(`lifted-${crypto.randomUUID()}@example.org`);
    for (const [method, path, body] of REFUSED) {
      expect(path).toMatch(ROUTE);
      const answer = await asSession(person.headers, method, path, body);
      expect([method, path, answer]).toEqual([method, path, { status: 401, body: { error: "unauthorized" } }]);
    }
    // Nothing was kept for the person's tenant: no consent, no connection, no schedule, no task.
    const consent = await tenantCall(bindings, person.tenant, `/consent?tenant=${enc(person.tenant)}`);
    expect(await consent.json()).toMatchObject({ cloudWork: false });
    const index = await tenantCall(bindings, person.tenant, `/index?tenant=${enc(person.tenant)}`);
    expect(await index.json()).toMatchObject({ taskIds: [] });
    const connections = await credStub(bindings, person.tenant).fetch(new Request(
      `https://cred/connections?tenant=${enc(person.tenant)}`, { headers: { "x-tenant": person.tenant } }));
    expect(await connections.json()).toMatchObject({ connections: [] });
    await runInDurableObject(scheduleStub(bindings, person.tenant), async (_instance, state) => {
      expect([...(await state.storage.list()).keys()]).toEqual([]);
    });
    // The person's sign-in still works where it belongs.
    expect((await asSession(person.headers, "GET", "/v1/shops")).status).toBe(200);
  });

  it("never runs the tenant wipe, which scans every session", async () => {
    // The review's proof: this answered 200 and wiped the stranger's own tenant, scanning every stored session to do it.
    const person = await emailSignIn(`wipe-${crypto.randomUUID()}@example.org`);
    expect(await asSession(person.headers, "DELETE", "/v1/tenant/data")).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    // No tombstone, and the session lives on.
    const tombstone = await tenantCall(bindings, person.tenant, `/tombstone?tenant=${enc(person.tenant)}`);
    expect(await tombstone.json()).toEqual({ tombstone: null });
    expect((await asSession(person.headers, "GET", "/v1/shops")).status).toBe(200);
  });

  it("keeps the three reads the desktop makes for a person in no shop, which find nothing", async () => {
    expect((await setFlags({ officeInbound: false })).status).toBe(200);
    const person = await emailSignIn(`reads-${crypto.randomUUID()}@example.org`);
    const exported = await asSession<{ tenant: string; tasks: unknown[]; schedules: unknown[] }>(person.headers, "GET",
      "/v1/tenant/export");
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ tenant: person.tenant, tasks: [], schedules: [] });
    expect(await asSession(person.headers, "GET", "/v1/schedules")).toEqual({ status: 200, body: { schedules: [] } });
    // The inbound feed is off by default, which the desktop reads as no feed; on, the person's own is empty.
    expect(await asSession(person.headers, "GET", "/v1/inbound/attention")).toEqual({ status: 403,
      body: { error: "feature_disabled", feature: "officeInbound" } });
    expect((await setFlags({ officeInbound: true })).status).toBe(200);
    expect(await asSession(person.headers, "GET", "/v1/inbound/attention")).toMatchObject({ status: 200,
      body: { items: [] } });
  });

  it("leaves Apple's sign-in on the lifted routes until it is turned on, which docs/turning-on.md says to change first",
    async () => {
      const person = await signIn();
      expect(person.tenant).toMatch(/^apple:/);
      expect(await asSession(person.headers, "PUT", "/v1/consent/cloud", { enabled: true })).toMatchObject({ status: 200,
        body: { cloudWork: true } });
    });
});
