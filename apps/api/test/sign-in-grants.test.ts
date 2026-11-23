import { adminFetch, tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { sourceWorker } from "./source-worker";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import { sha256Hex } from "../src/auth";
import type { Env } from "../src/index";
import { cancelAttempt, startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import type { TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";

// The sign-in step (docs/browser-control.md): a worker's attempt asks for a sign-in by its id, the vault issues a
// one-time grant bound to that attempt, one outpost and the sign-in for 60 seconds, and only that outpost can redeem
// it, once, with its own credential, for the username and the password. The outpost's side is a stub: no browser and
// no site. The global fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const off: JobFlags = async () => ({ officeCloud: false, officeExternalWrites: false });
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
const SITE = "Shopee Seller Centre";
const ORIGINS = ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"];
const USERNAME = "baan.mali@example.com";
// Made up for each run and never a real password, so a search for it finds only what this file stored.
const PASSWORD = `pw-${crypto.randomUUID()}`;
const NEW_PASSWORD = `pw-new-${crypto.randomUUID()}`;

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Shop = { tenant: string; taskId: string };

/// A shop with consent given and one draft task, indexed for export and deletion.
async function shop(): Promise<Shop> {
  const tenant = fresh("signin:shop");
  const taskId = fresh("signin-task");
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Parcel status", objective: "Read the parcel status.",
    state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() },
  tenant)).status).toBe(200);
  return { tenant, taskId };
}

/// An attempt at the shop's task for `member`, and the port its worker holds.
async function attempt(s: Shop, member: string, flags: JobFlags = on): Promise<WorkerPort> {
  const started = await startAttempt(flowEnv, { tenant: s.tenant, taskId: s.taskId, executorId: member }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  return workerPort(flowEnv, started.job, { flags });
}

async function addSignIn(tenant: string, members: string[] = ["nam", "ton"]): Promise<string> {
  const response = await adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD, members }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { signIn: { id: string } }).signIn.id;
}

type SignIn = { id: string; state: string; brokenAt: string | null; brokenBy: string | null;
  lastUsedAt: string | null; lastUsedBy: string | null };

async function signIns(tenant: string): Promise<SignIn[]> {
  const response = await adminFetch(`${API}/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(tenant)}`,
    { headers: OPERATOR });
  expect(response.status).toBe(200);
  return ((await response.json()) as { signIns: SignIn[] }).signIns;
}

/// The outpost's side, played by a stub: it beats and redeems with its own credential.
class StubOutpost {
  constructor(readonly tenant: string, readonly id: string, readonly credential: string) {}

  beat() {
    return sourceWorker.fetch(`${API}/v1/outposts/heartbeat`, { method: "POST", headers: this.headers(this.credential),
      body: JSON.stringify({ tenant: this.tenant, outpostId: this.id }) });
  }

  redeem(grantId: string, as: { tenant?: string; outpostId?: string; credential?: string | null } = {}) {
    const credential = as.credential === undefined ? this.credential : as.credential;
    return sourceWorker.fetch(`${API}/v1/outposts/redeem`, { method: "POST", headers: this.headers(credential),
      body: JSON.stringify({ tenant: as.tenant ?? this.tenant, outpostId: as.outpostId ?? this.id, grantId }) });
  }

  private headers(credential: string | null): Record<string, string> {
    return { "content-type": "application/json", ...(credential !== null ? { authorization: `Bearer ${credential}` } : {}) };
  }
}

/// A registered outpost, beating unless told not to.
async function outpost(tenant: string, options: { name?: string; kind?: string; beat?: boolean } = {}) {
  const response = await adminFetch(`${API}/v1/admin/outposts`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, name: options.name ?? "This Mac", kind: options.kind ?? "this_mac" }) });
  expect(response.status).toBe(200);
  const { outpost: registered, credential } = (await response.json()) as { outpost: { id: string }; credential: string };
  const stub = new StubOutpost(tenant, registered.id, credential);
  if (options.beat !== false) expect((await stub.beat()).status).toBe(200);
  return stub;
}

function vault(tenant: string) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
}

async function vaultKeys(tenant: string): Promise<string[]> {
  return runInDurableObject(vault(tenant), async (_instance, state) => [...(await state.storage.list()).keys()]);
}

async function grantOf(port: WorkerPort, signInId: string, outpostId: string): Promise<string> {
  const asked = await port.signIn(signInId, outpostId);
  if (!asked.ok) throw new Error(`grant_refused_${asked.error}`);
  return asked.value.grantId;
}

async function refusal(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said).filter((entry) =>
    entry.action.startsWith("signin.") && entry.action !== "signin.created");
}

describe("the sign-in step", () => {
  it("grants one attempt one sign-in, and only its outpost gets the password, once", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;

    const asked = await nam.signIn(signInId, mac.id);
    expect(asked).toEqual({ ok: true, value: { grantId: expect.any(String), signInId, site: SITE, outpostId: mac.id,
      expiresAt: expect.any(String) } });
    if (!asked.ok) return;
    const { grantId } = asked.value;
    const lasts = Date.parse(asked.value.expiresAt) - Date.now();
    expect(lasts).toBeGreaterThan(55_000);
    expect(lasts).toBeLessThanOrEqual(60_000);
    // What the worker holds names the grant and nothing it could type.
    expect(JSON.stringify(asked)).not.toContain(PASSWORD);
    expect(JSON.stringify(asked)).not.toContain(USERNAME);

    const redeemed = await mac.redeem(grantId);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toBe("no-store");
    expect(await redeemed.json()).toEqual({ signInId, site: SITE, origins: ORIGINS, username: USERNAME,
      password: PASSWORD });

    await refusal(await mac.redeem(grantId), 409, "grant_used");
    expect(await signIns(s.tenant)).toEqual([expect.objectContaining({ id: signInId, lastUsedAt: expect.any(String),
      lastUsedBy: "nam" })]);

    const bound = { signInId, taskId: s.taskId, attemptId, outpostId: mac.id, grantId };
    expect(await audit(s.tenant)).toEqual([
      { actor: { kind: "worker", attemptId }, action: "signin.requested", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "signin.redeemed", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "signin.redeemed", subject: bound, outcome: "refused",
        reason: "grant_used" },
    ]);
  });

  it("refuses a grant redeemed late, and one never issued", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const grantId = await grantOf(await attempt(s, "nam"), signInId, mac.id);
    await runInDurableObject(vault(s.tenant), async (_instance, state) => {
      const grant = await state.storage.get<Record<string, unknown>>(`signin-grant:${grantId}`);
      await state.storage.put(`signin-grant:${grantId}`, { ...grant, expiresAt: new Date(Date.now() - 1).toISOString() });
    });
    await refusal(await mac.redeem(grantId), 409, "grant_expired");
    await refusal(await mac.redeem(crypto.randomUUID()), 404, "grant_not_found");
    await refusal(await mac.redeem("not-a-grant"), 404, "grant_not_found");
  });

  it("refuses a grant redeemed from another outpost, and leaves it for its own", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const cloud = await outpost(s.tenant, { name: "Cloud outpost", kind: "cloud" });
    const grantId = await grantOf(await attempt(s, "nam"), signInId, mac.id);
    await refusal(await cloud.redeem(grantId), 403, "wrong_outpost");
    expect((await mac.redeem(grantId)).status).toBe(200);
  });

  it("refuses a redeem without the outpost's own credential, and uses nothing up", async () => {
    const s = await shop();
    const other = fresh("signin:other-shop");
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const foreign = await outpost(other);
    const grantId = await grantOf(await attempt(s, "nam"), signInId, mac.id);
    const session = (await tenantSession(s.tenant)).authorization.slice("Bearer ".length);
    for (const response of [
      await mac.redeem(grantId, { credential: null }),
      await mac.redeem(grantId, { credential: `mo1_${"A".repeat(43)}` }),
      await mac.redeem(grantId, { credential: "test-key" }),
      await mac.redeem(grantId, { credential: session }),
      await mac.redeem(grantId, { outpostId: foreign.id, credential: foreign.credential }),
    ]) {
      await refusal(response, 401, "unauthorized");
    }
    // Another shop's outpost, in its own vault, finds no such grant at all.
    await refusal(await foreign.redeem(grantId), 404, "grant_not_found");
    expect((await mac.redeem(grantId)).status).toBe(200);
  });

  it.each(["finished", "cancelled"] as const)("refuses a grant whose attempt has %s, and uses it up", async (how) => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const grantId = await grantOf(nam, signInId, mac.id);
    if (how === "finished") expect((await nam.finish("done")).ok).toBe(true);
    else expect((await cancelAttempt(flowEnv, s.tenant, s.taskId, nam.job.attemptId, { kind: "owner" })).ok).toBe(true);
    await refusal(await mac.redeem(grantId), 409, "attempt_ended");
    await refusal(await mac.redeem(grantId), 409, "grant_used");
    // An ended attempt cannot ask for another.
    expect(await nam.signIn(signInId, mac.id)).toEqual({ ok: false, error: "stale_attempt", ended: true });
  });

  it("refuses a member the sign-in does not name, and issues nothing", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant, ["nam", "ton"]);
    const mac = await outpost(s.tenant);
    const pim = await attempt(s, "pim");
    expect(await pim.signIn(signInId, mac.id)).toEqual({ ok: false, error: "member_not_allowed" });
    const kit = await attempt(s, "kit");
    expect(await kit.signIn(signInId, mac.id)).toEqual({ ok: false, error: "member_not_allowed" });
    expect((await vaultKeys(s.tenant)).filter((key) => key.startsWith("signin-grant:"))).toEqual([]);
    expect(await audit(s.tenant)).toEqual([
      { actor: { kind: "worker", attemptId: pim.job.attemptId }, action: "signin.requested",
        subject: { signInId, taskId: s.taskId, attemptId: pim.job.attemptId, outpostId: mac.id }, outcome: "refused",
        reason: "member_not_allowed" },
      { actor: { kind: "worker", attemptId: kit.job.attemptId }, action: "signin.requested",
        subject: { signInId, taskId: s.taskId, attemptId: kit.job.attemptId, outpostId: mac.id }, outcome: "refused",
        reason: "member_not_allowed" },
    ]);
    // Ton is named on it.
    expect((await (await attempt(s, "ton")).signIn(signInId, mac.id)).ok).toBe(true);
  });

  it("stops using a broken sign-in until the owner types a new password", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const waiting = await grantOf(nam, signInId, mac.id);

    expect(await nam.signInBroken(signInId)).toEqual({ ok: true, value: { signInId, state: "broken" } });
    expect(await signIns(s.tenant)).toEqual([expect.objectContaining({ id: signInId, state: "broken",
      brokenAt: expect.any(String), brokenBy: "nam" })]);
    await refusal(await mac.redeem(waiting), 409, "sign_in_broken");
    expect(await nam.signIn(signInId, mac.id)).toEqual({ ok: false, error: "sign_in_broken" });

    // Only a member named on it can say so; a second report keeps the first.
    const pim = await attempt(s, "pim");
    expect(await pim.signInBroken(signInId)).toEqual({ ok: false, error: "member_not_allowed" });
    const ton = await attempt(s, "ton");
    expect((await ton.signInBroken(signInId)).ok).toBe(true);
    expect((await signIns(s.tenant))[0]?.brokenBy).toBe("nam");

    const replaced = await adminFetch(`${API}/v1/admin/vault/sign-ins/password`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, signInId, password: NEW_PASSWORD }) });
    expect(replaced.status).toBe(200);
    expect(await signIns(s.tenant)).toEqual([expect.objectContaining({ state: "working", brokenAt: null,
      brokenBy: null })]);
    const mended = await mac.redeem(await grantOf(ton, signInId, mac.id));
    expect(((await mended.json()) as { password: string }).password).toBe(NEW_PASSWORD);

    const broken = (await audit(s.tenant)).filter((entry) => entry.action === "signin.broken");
    expect(broken).toEqual([
      { actor: { kind: "worker", attemptId: nam.job.attemptId }, action: "signin.broken",
        subject: { signInId, taskId: s.taskId, attemptId: nam.job.attemptId }, outcome: "ok" },
      { actor: { kind: "worker", attemptId: pim.job.attemptId }, action: "signin.broken",
        subject: { signInId, taskId: s.taskId, attemptId: pim.job.attemptId }, outcome: "refused",
        reason: "member_not_allowed" },
      { actor: { kind: "worker", attemptId: ton.job.attemptId }, action: "signin.broken",
        subject: { signInId, taskId: s.taskId, attemptId: ton.job.attemptId }, outcome: "ok" },
    ]);
  });

  it("refuses an outpost that is asleep or unknown", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const nam = await attempt(s, "nam");
    const never = await outpost(s.tenant, { beat: false });
    expect(await nam.signIn(signInId, never.id)).toEqual({ ok: false, error: "outpost_asleep" });

    const mac = await outpost(s.tenant);
    await runInDurableObject(vault(s.tenant), async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>(`outpost:${mac.id}`);
      await state.storage.put(`outpost:${mac.id}`, { ...record,
        lastHeartbeatAt: new Date(Date.now() - 91_000).toISOString() });
    });
    expect(await nam.signIn(signInId, mac.id)).toEqual({ ok: false, error: "outpost_asleep" });
    expect((await mac.beat()).status).toBe(200);
    expect((await nam.signIn(signInId, mac.id)).ok).toBe(true);

    expect(await nam.signIn(signInId, crypto.randomUUID())).toEqual({ ok: false, error: "outpost_not_found" });
    expect(await nam.signIn(signInId, (await outpost(fresh("signin:other-shop"))).id))
      .toEqual({ ok: false, error: "outpost_not_found" });
  });

  it("grants a removed sign-in to nobody, and refuses its waiting grant", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const waiting = await grantOf(nam, signInId, mac.id);
    expect((await adminFetch(`${API}/v1/admin/vault/sign-ins/remove`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, signInId }) })).status).toBe(200);
    await refusal(await mac.redeem(waiting), 404, "sign_in_not_found");
    expect(await nam.signIn(signInId, mac.id)).toEqual({ ok: false, error: "sign_in_not_found" });
    expect(await nam.signIn("not-a-sign-in", mac.id)).toEqual({ ok: false, error: "sign_in_not_found" });
    expect(await nam.signInBroken(signInId)).toEqual({ ok: false, error: "sign_in_not_found" });
  });

  it("reads the switches and the owner's consent at the grant and at the redeem", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const waiting = await grantOf(nam, signInId, mac.id);
    expect(await (await attempt(s, "nam", off)).signIn(signInId, mac.id))
      .toEqual({ ok: false, error: "feature_disabled" });

    expect((await tenantCall(bindings, s.tenant, "/consent", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: s.tenant, cloudWork: false }) })).status).toBe(200);
    await refusal(await mac.redeem(waiting), 403, "consent_required");
    expect(await nam.signIn(signInId, mac.id)).toEqual({ ok: false, error: "consent_required" });
    expect(await nam.signInBroken(signInId)).toEqual({ ok: false, error: "consent_required" });
  });

  it("keeps the password out of every answer, event, log, export and audit entry", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const answers: string[] = [];
    const kept = async (response: Response) => {
      answers.push(await response.clone().text());
      return response;
    };
    const s = await shop();
    const created = await kept(await adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
        members: ["nam", "ton"] }) }));
    const signInId = ((await created.json()) as { signIn: { id: string } }).signIn.id;
    await kept(await adminFetch(`${API}/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(s.tenant)}`,
      { headers: OPERATOR }));
    const mac = await outpost(s.tenant);
    await kept(await mac.beat());
    await kept(await adminFetch(`${API}/v1/admin/outposts?tenant=${encodeURIComponent(s.tenant)}`, { headers: OPERATOR }));

    const nam = await attempt(s, "nam");
    const asked = await nam.signIn(signInId, mac.id);
    answers.push(JSON.stringify(asked));
    if (!asked.ok) throw new Error("grant_refused");
    // The one answer that holds it: to the outpost the grant names, once.
    const redeemed = await mac.redeem(asked.value.grantId);
    expect(((await redeemed.json()) as { password: string }).password).toBe(PASSWORD);
    await kept(await mac.redeem(asked.value.grantId));
    answers.push(JSON.stringify(await nam.signInBroken(signInId)));
    answers.push(JSON.stringify(await nam.report([{ type: "turnCompleted", status: "completed" }])));
    await kept(await adminFetch(`${API}/v1/admin/vault/sign-ins/password`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, signInId, password: NEW_PASSWORD }) }));
    answers.push(JSON.stringify(await nam.finish("done")));

    const exported = await kept(await SELF.fetch(`${API}/v1/tenant/export`, { headers: await tenantSession(s.tenant) }));
    expect(exported.status).toBe(200);
    const bundle = (await exported.json()) as { tasks: { events: TaskEventJSON[] }[]; signIns: SignIn[];
      outposts: { id: string }[] };
    // The export carries the sign-in and the outpost as the operator sees them.
    expect(bundle.signIns.map((entry) => entry.id)).toEqual([signInId]);
    expect(bundle.outposts.map((entry) => entry.id)).toEqual([mac.id]);
    const events = JSON.stringify(bundle.tasks.flatMap((task) => task.events));
    expect(events).toContain("turnCompleted");
    const auditLog = await (await tenantCall(bindings, s.tenant,
      `/audit/export?tenant=${encodeURIComponent(s.tenant)}`)).text();
    expect(auditLog).toContain("signin.redeemed");

    const digest = await sha256Hex(mac.credential);
    for (const text of [...answers, events, auditLog, ...logged]) {
      for (const secret of [PASSWORD, NEW_PASSWORD, mac.credential, digest]) expect(text).not.toContain(secret);
    }
  });

  it("goes with the shop's deletion: sign-ins, outposts and grants", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const waiting = await grantOf(await attempt(s, "nam"), signInId, mac.id);
    expect((await vaultKeys(s.tenant)).some((key) => key.startsWith("signin-grant:"))).toBe(true);
    const deleted = await SELF.fetch(`${API}/v1/tenant/data`, { method: "DELETE",
      headers: await tenantSession(s.tenant) });
    expect(deleted.status).toBe(200);
    expect((await vaultKeys(s.tenant)).filter((key) => /^(signin|outpost|signin-grant):/.test(key))).toEqual([]);
    await refusal(await mac.redeem(waiting), 401, "unauthorized");
  });
});
