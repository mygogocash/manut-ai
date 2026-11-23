import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readLinear } from "../src/connectors/linear";
import type { FetchImpl, ResourceGrant } from "../src/connectors/types";

// ofc22-cloud-linear-read-route: Linear issues inside granted projects.
//
// Two levels, honestly separated. The adapter runs against injected fixture
// fetch, including the regression pin for the removed $projectId variable
// (Linear rejects unused GraphQL variables, so the declaration had to go).
// The route tests cover everything before provider traffic — auth, tenancy,
// validation, the wrong provider, an unknown connection, and a denied
// project refused by the grant check ahead of any traffic. A live GraphQL
// call is never made here: the test realm cannot stub the worker's fetch,
// so the happy path over the wire counts only as the owner's recorded
// sandbox run (H-OFC22-sandbox-run), per docs/office-connections.md §7.

const grant: ResourceGrant = {
  connectionId: "conn-linear",
  accountId: "workspace-1",
  resourceIds: ["ws/proj"],
  allowsActions: false,
};

function node(id: string, project: string) {
  return {
    id,
    identifier: `GO-${id}`,
    title: `Issue ${id}`,
    priority: 1,
    updatedAt: "2026-09-21T03:00:00Z",
    url: `https://linear/GO-${id}`,
    state: { name: "Todo" },
    assignee: { name: "Ann" },
    project: { id: project },
  };
}

function fixtureFetch(calls: unknown[][]) {
  const fetch: FetchImpl = async (_url, init) => {
    calls.push([_url, JSON.parse(String(init?.body ?? "{}"))]);
    return new Response(
      JSON.stringify({ data: { issues: { nodes: [node("1", "ws/proj")] } } }),
      { status: 200 },
    );
  };
  return fetch;
}

describe("linear read adapter", () => {
  it("sends no projectId variable and scopes by filter from the grant", async () => {
    const calls: unknown[][] = [];
    const { issues } = await readLinear(fixtureFetch(calls), grant, "token", {
      accountId: "workspace-1",
      projectIds: ["ws/proj"],
      updatedSince: "2026-09-14T00:00:00Z",
      first: 25,
    });
    expect(issues).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const variables = (calls[0]![1] as { variables: Record<string, unknown> }).variables;
    expect(variables).not.toHaveProperty("projectId");
    expect(variables).toMatchObject({
      filter: { project: { id: { eq: "ws/proj" } }, updatedAt: { gte: "2026-09-14T00:00:00Z" } },
      first: 25,
    });
  });

  it("refuses a denied project before any provider traffic", async () => {
    const calls: unknown[][] = [];
    await expect(
      readLinear(fixtureFetch(calls), grant, "token", {
        accountId: "workspace-1",
        projectIds: ["ws/other"],
        updatedSince: "2026-09-14T00:00:00Z",
        first: 25,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "resource_escape" });
    expect(calls).toHaveLength(0);
  });

  it("reads nothing when asked for nothing, without traffic", async () => {
    const calls: unknown[][] = [];
    const { issues } = await readLinear(fixtureFetch(calls), grant, "token", {
      accountId: "workspace-1",
      projectIds: [],
      updatedSince: "2026-09-14T00:00:00Z",
      first: 25,
    });
    expect(issues).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("bounds the page to 1..50 per project", async () => {
    const calls: unknown[][] = [];
    for (const first of [0, 51]) {
      await expect(
        readLinear(fixtureFetch(calls), grant, "token", {
          accountId: "workspace-1",
          projectIds: ["ws/proj"],
          updatedSince: "2026-09-14T00:00:00Z",
          first,
        }),
      ).rejects.toMatchObject({ code: "forbidden", message: "bounds" });
    }
    expect(calls).toHaveLength(0);
  });
});

const OPERATOR = { authorization: "Bearer test-key" };
const TENANT = "linear-read-tenant";

let counter = 8000;
const freshID = () => `read-route-${Date.now()}-${counter++}`;

async function storeConnection(extra: Record<string, unknown> = {}) {
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

async function readIssues(connection: string, query: string, tenant = TENANT) {
  return SELF.fetch(
    `https://test/v1/connections/${connection}/linear/issues?${query}&tenant=${encodeURIComponent(tenant)}`,
    { headers: await tenantSession(tenant, false) },
  );
}

describe("linear read route", () => {
  it("requires a session", async () => {
    expect(
      (await SELF.fetch("https://test/v1/connections/conn-1/linear/issues?first=5")).status,
    ).toBe(401);
  });

  it("refuses a tenantless operator key", async () => {
    const response = await SELF.fetch("https://test/v1/connections/conn-1/linear/issues?first=5", {
      headers: OPERATOR,
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error?: string }).error).toBe("unauthorized");
  });

  it("refuses a connection from another provider", async () => {
    const id = await storeConnection({ provider: "gmail", accountId: "user@example.com" });
    const response = await readIssues(
      id,
      "projectIds=ws%2Fproj&updatedSince=2026-09-14T00%3A00%3A00Z&first=5",
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe("wrong_provider");
  });

  it("validates the window and the page", async () => {
    const id = await storeConnection();
    const base = `projectIds=ws%2Fproj&first=5`;
    const missingWindow = await readIssues(id, base);
    expect(missingWindow.status).toBe(400);
    const badWindow = await readIssues(id, `${base}&updatedSince=not-a-date`);
    expect(badWindow.status).toBe(400);
    for (const first of ["0", "26", "many"]) {
      const response = await readIssues(
        id,
        `projectIds=ws%2Fproj&updatedSince=2026-09-14T00%3A00%3A00Z&first=${first}`,
      );
      expect(response.status).toBe(400);
    }
  });

  it("answers an unknown connection without leaking its absence", async () => {
    const response = await readIssues(
      "00000000-0000-0000-0000-000000000000",
      "projectIds=ws%2Fproj&updatedSince=2026-09-14T00%3A00%3A00Z&first=5",
    );
    expect(response.status).toBe(404);
  });

  it("refuses a denied project without provider traffic", async () => {
    const id = await storeConnection();
    // Reaches the vault (no provider call yet), then the grant check inside
    // the adapter refuses ahead of the GraphQL loop by construction.
    const response = await readIssues(
      id,
      "projectIds=ws%2Fother&updatedSince=2026-09-14T00%3A00%3A00Z&first=5",
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error?: string }).error).toBe("resource_escape");
  });

  it("reads nothing when asked for nothing", async () => {
    const id = await storeConnection();
    const response = await readIssues(id, "updatedSince=2026-09-14T00%3A00%3A00Z&first=5");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { issues?: unknown[] }).issues).toEqual([]);
  });
});
