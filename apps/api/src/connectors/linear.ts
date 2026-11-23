import {
  checkGrant,
  ConnectorError,
  type FetchImpl,
  type ResourceGrant,
  type SourceRecord,
} from "./types";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number;
  assignee: string;
  updatedAt: string;
  url: string;
};

export type LinearReadArgs = {
  accountId: string;
  /// Workspace-scoped project ids from the grant, as "workspace/project".
  /// Only these projects are ever queried.
  projectIds: string[];
  updatedSince: string;
  first: number;
};

const LINEAR_SCOPES = ["read"] as const;

/// Minimal scopes this connector needs. Issue creation is a later action
/// behind its own consent, never this read path.
export const LINEAR_SCOPES_LIST: readonly string[] = LINEAR_SCOPES;

function issueShape(payload: unknown): LinearIssue {
  const node = payload as Record<string, unknown>;
  if (typeof node.id !== "string") throw new Error("shape");
  const state = node.state as Record<string, unknown> | undefined;
  const assignee = node.assignee as Record<string, unknown> | undefined;
  return {
    id: node.id,
    identifier: typeof node.identifier === "string" ? node.identifier : node.id,
    title: typeof node.title === "string" ? node.title : "(no title)",
    state: typeof state?.name === "string" ? (state.name as string) : "unknown",
    priority: typeof node.priority === "number" ? node.priority : 0,
    assignee: typeof assignee?.name === "string" ? (assignee.name as string) : "unassigned",
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
    url: typeof node.url === "string" ? node.url : "",
  };
}

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title priority updatedAt url
        state { name }
        assignee { name }
        project { id }
      }
    }
  }
`;

/// Bounded issue updates inside selected projects. Project scope travels as
/// a server-side filter value from the grant; model input cannot substitute
/// a different workspace or project. Write support is absent until the
/// action broker and extra consent enable it.
export async function readLinear(
  fetchImpl: FetchImpl,
  grant: ResourceGrant,
  token: string,
  args: LinearReadArgs,
): Promise<{ issues: SourceRecord<LinearIssue>[] }> {
  checkGrant(grant, { accountId: args.accountId, resourceIds: args.projectIds });
  if (!Number.isInteger(args.first) || args.first < 1 || args.first > 50) {
    throw new ConnectorError("forbidden", "bounds");
  }
  const retrievedAt = new Date().toISOString();
  const issues: SourceRecord<LinearIssue>[] = [];
  for (const projectId of args.projectIds) {
    const response = await graphql(fetchImpl, token, {
      query: ISSUES_QUERY,
      variables: {
        filter: { project: { id: { eq: projectId } }, updatedAt: { gte: args.updatedSince } },
        first: args.first,
      },
    });
    const nodes = (((response as Record<string, unknown>).data as Record<string, unknown> | undefined)?.issues as
      | { nodes?: unknown[] }
      | undefined)?.nodes;
    if (!Array.isArray(nodes)) throw new Error("shape");
    for (const node of nodes) {
      const record = issueShape(node);
      issues.push({
        record,
        source: { provider: "linear", accountId: args.accountId, retrievedAt },
        deepLink: record.url || undefined,
      });
    }
  }
  return { issues };
}

async function graphql(
  fetchImpl: FetchImpl,
  token: string,
  body: { query: string; variables: Record<string, unknown> },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConnectorError("network", "provider_unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError("auth", "provider_rejected_credentials");
  }
  if (response.status === 429) {
    throw new ConnectorError("rate_limited", "provider_throttled");
  }
  if (!response.ok) throw new ConnectorError("network", `provider_${response.status}`);
  try {
    const payload = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
    if (payload.errors?.length) throw new ConnectorError("schema", "provider_graphql_error");
    return payload;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("schema", "provider_bad_json");
  }
}
