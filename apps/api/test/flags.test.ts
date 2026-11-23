import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const OPERATOR = { authorization: "Bearer test-key" };
let SESSION = { authorization: "" };
beforeEach(async () => { SESSION = await tenantSession("apple:flags-fixture"); });

async function admin(body: Record<string, unknown>) {
  return adminFetch("https://test/v1/admin/flags", {
    method: "PUT",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify(body),
  });
}

async function adminGet() {
  return adminFetch("https://test/v1/admin/flags", { headers: OPERATOR });
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

async function create(id: string, key: string) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...SESSION, "idempotency-key": key },
    body: JSON.stringify(draft(id)),
  });
}

describe("capability flags and kill switches", () => {
  it("keeps administration on the operator key", async () => {
    expect((await adminFetch("https://test/v1/admin/flags")).status).toBe(403);
    expect(
      (
        await adminFetch("https://test/v1/admin/flags", {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: "Bearer test-key-wrong" },
          body: JSON.stringify({ officeCloud: false }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin({ officeCloud: "yes" } as unknown as Record<string, unknown>)
      ).status,
    ).toBe(400);
  });

  it("disabling cloud work blocks new tasks and commands until re-enabled", async () => {
    const id = `flag-task-${Date.now()}`;
    expect((await admin({ officeCloud: false })).status).toBe(200);
    const view = (await (await adminGet()).json()) as { officeCloud?: boolean };
    expect(view.officeCloud).toBe(false);

    const blocked = await create(id, "flag-k1");
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error?: string; feature?: string }).feature).toBe("officeCloud");

    const command = await SELF.fetch(`https://test/v1/tasks/${id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION, "idempotency-key": "flag-k2" },
      body: JSON.stringify({ type: "queue" }),
    });
    expect(command.status).toBe(403);

    expect((await admin({ officeCloud: true })).status).toBe(200);
    expect((await create(id, "flag-k3")).status).toBe(200);
  });

  it("keeps officeInbound off by default, and only the operator turns it on", async () => {
    // wrangler.test.json sets no OFFICE_INBOUND, like every deployed config,
    // and no test before this one writes the dynamic record.
    const initial = (await (await adminGet()).json()) as { officeInbound?: boolean };
    expect(initial.officeInbound).toBe(false);
    expect((await admin({ officeInbound: "yes" } as unknown as Record<string, unknown>)).status).toBe(400);
    expect((await admin({ officeInbound: true })).status).toBe(200);
    expect(((await (await adminGet()).json()) as { officeInbound?: boolean }).officeInbound).toBe(true);
    expect((await admin({ officeInbound: false })).status).toBe(200);
    expect(((await (await adminGet()).json()) as { officeInbound?: boolean }).officeInbound).toBe(false);
  });

  it("reads back routine and write flags", async () => {
    expect((await admin({ officeRoutines: false, officeExternalWrites: false })).status).toBe(200);
    const view = (await (await adminGet()).json()) as {
      officeRoutines?: boolean;
      officeExternalWrites?: boolean;
    };
    expect(view.officeRoutines).toBe(false);
    expect(view.officeExternalWrites).toBe(false);
    expect((await admin({ officeRoutines: true, officeExternalWrites: true })).status).toBe(200);
  });

  it("gates action proposals and attempt writes on their kill switches", async () => {
    const id = `flag-task-${Date.now()}-gates`;
    expect((await create(id, "flag-g1")).status).toBe(200);
    const claim = await SELF.fetch(`https://test/v1/tasks/${id}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION },
      body: JSON.stringify({ executorId: "exec-1", inputRevision: "r1" }),
    });
    expect(claim.status).toBe(200);
    const attemptId = ((await claim.json()) as { id: string }).id;

    expect((await admin({ officeCloud: false })).status).toBe(200);
    const noPropose = await SELF.fetch(`https://test/v1/tasks/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION },
      body: JSON.stringify({}),
    });
    expect(noPropose.status).toBe(403);
    expect(((await noPropose.json()) as { feature?: string }).feature).toBe("officeCloud");
    const noBeat = await SELF.fetch(`https://test/v1/tasks/${id}/attempts/${attemptId}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION },
      body: JSON.stringify({ fence: 1 }),
    });
    expect(noBeat.status).toBe(403);
    expect(((await noBeat.json()) as { feature?: string }).feature).toBe("officeCloud");
    expect((await admin({ officeCloud: true })).status).toBe(200);

    expect((await admin({ officeExternalWrites: false })).status).toBe(200);
    const noExternal = await SELF.fetch(`https://test/v1/tasks/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION },
      body: JSON.stringify({}),
    });
    expect(noExternal.status).toBe(403);
    expect(((await noExternal.json()) as { feature?: string }).feature).toBe("officeExternalWrites");
    expect((await admin({ officeExternalWrites: true })).status).toBe(200);
  });

  it("blocks dispatch on either kill switch, before reading the body", async () => {
    const id = `flag-task-${Date.now()}-dispatch`;
    expect((await create(id, "flag-d1")).status).toBe(200);
    const dispatch = (body: object) =>
      SELF.fetch(`https://test/v1/tasks/${id}/actions/act-1/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", ...SESSION },
        body: JSON.stringify(body),
      });
    const shaped = { grantRevision: 1 };

    expect((await admin({ officeCloud: false })).status).toBe(200);
    const noCloud = await dispatch(shaped);
    expect(noCloud.status).toBe(403);
    expect(((await noCloud.json()) as { feature?: string }).feature).toBe("officeCloud");
    expect((await admin({ officeCloud: true, officeExternalWrites: false })).status).toBe(200);
    const noWrites = await dispatch(shaped);
    expect(noWrites.status).toBe(403);
    expect(((await noWrites.json()) as { feature?: string }).feature).toBe("officeExternalWrites");

    // Past both switches, the same body reaches validation instead.
    expect((await admin({ officeExternalWrites: true })).status).toBe(200);
    expect((await dispatch({})).status).toBe(400);
  });
});
