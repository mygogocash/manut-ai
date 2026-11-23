import { readConnectionSecret } from "./cred-broker";
import { checkGrant, ConnectorError } from "./connectors/types";
import type { ActionProposalJSON } from "./task-object";

type ActionEnv = {
  TASK: DurableObjectNamespace;
  CRED: DurableObjectNamespace;
};

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/// A provider fault the broker classifies: permanent failures settle the
/// action as failed, ambiguous ones as unknown. Unknown never retries
/// blindly: the next dispatch finds it and refuses, so a human decides.
export class ProviderFault extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export type LinearIssueReceipt = {
  id: string;
  identifier: string;
  title: string;
  url: string;
};

/// The pilot's first and only writable operation: creating a reviewed issue
/// in an approved test project. Title and description come from the approved
/// proposal alone; the project is the proposal's target, already checked
/// against its declared scope at propose time.
export async function createLinearIssue(
  fetchImpl: FetchImpl,
  token: string,
  input: { projectId: string; title: string; description?: string | undefined },
): Promise<LinearIssueReceipt> {
  if (!input.projectId || !input.title || input.title.length > 256) {
    throw new ProviderFault("invalid_payload", true);
  }
  if (input.description !== undefined && input.description.length > 20000) {
    throw new ProviderFault("invalid_payload", true);
  }
  let response: Response;
  try {
    response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation IssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier title url } }
        }`,
        variables: {
          input: {
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            projectId: input.projectId,
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error instanceof ProviderFault) throw error;
    throw new ProviderFault("provider_unreachable", false);
  }
  if (response.status === 401 || response.status === 403 || response.status === 422) {
    throw new ProviderFault(`provider_${response.status}`, true);
  }
  if (!response.ok) throw new ProviderFault(`provider_${response.status}`, false);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderFault("provider_bad_json", false);
  }
  const result = (payload as { data?: { issueCreate?: { success?: boolean; issue?: LinearIssueReceipt } } })
    .data?.issueCreate;
  if (!result?.success || !result.issue?.id) {
    throw new ProviderFault("provider_rejected", true);
  }
  return result.issue;
}

export type DispatchOptions = {
  tenant: string;
  grantRevision: number;
  fetchImpl?: FetchImpl;
  /// Worker-asserted company membership for company tasks, letting a
  /// dispatcher that is a member but not the task creator read, begin, and
  /// settle the action. The object still matches it against the proposal's
  /// own company.
  companyMember?: string;
};

export type BeginDispatchResult =
  | { ok: true; proposal: ActionProposalJSON }
  | { ok: false; response: Response };

/// Synchronous half of a dispatch: re-reads the authoritative proposal,
/// checks approval freshness, grant revision, tenant, connection health, and
/// task state through the object's begin gate, and consumes the one-use
/// approval by moving to dispatching. The Worker answers 202 with the
/// returned proposal and runs the provider call in `ctx.waitUntil`.
export async function beginDispatchAction(
  env: ActionEnv,
  taskId: string,
  actionId: string,
  opts: DispatchOptions,
): Promise<BeginDispatchResult> {
  const taskStub = env.TASK.get(env.TASK.idFromName(taskId));
  const actionHeaders = (): Headers => {
    const headers = new Headers({ "x-tenant": opts.tenant });
    if (opts.companyMember) headers.set("x-company-member", opts.companyMember);
    return headers;
  };
  const read = async (): Promise<Response> =>
    taskStub.fetch(
      new Request(`https://task/actions/${actionId}`, {
        headers: actionHeaders(),
      }),
    );
  // An already-confirmed action replays its receipt without touching the
  // provider again: retries and recovery attempts share one logical outcome.
  const current = await read();
  if (current.ok) {
    const seen = (await current.json()) as ActionProposalJSON;
    if (seen.state === "confirmed") {
      return {
        ok: false,
        response: new Response(JSON.stringify(seen), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      };
    }
  }
  const taskStubBegin = await taskStub.fetch(
    new Request(`https://task/actions/${actionId}/begin`, {
      method: "POST",
      headers: (() => {
        const headers = actionHeaders();
        headers.set("content-type", "application/json");
        return headers;
      })(),
      body: JSON.stringify({ grantRevision: opts.grantRevision }),
    }),
  );
  if (!taskStubBegin.ok) {
    // A lost race with another dispatcher that just confirmed still replays.
    const settled = (await read().then((response) => response.json()).catch(() => null)) as
      | ActionProposalJSON
      | null;
    if (settled?.state === "confirmed") {
      return {
        ok: false,
        response: new Response(JSON.stringify(settled), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return { ok: false, response: taskStubBegin };
  }
  return { ok: true, proposal: (await taskStubBegin.json()) as ActionProposalJSON };
}

/// Background half of a dispatch: runs in `ctx.waitUntil` after the Worker
/// answered 202. Checks connection health, calls the provider, and settles
/// confirmed, failed, or unknown. A second finish replays the receipt without
/// touching the provider again (the begin gate owns at-most-once).
export async function finishDispatchAction(
  env: ActionEnv,
  taskId: string,
  actionId: string,
  opts: DispatchOptions & { proposal: ActionProposalJSON },
): Promise<Response> {
  const taskStub = env.TASK.get(env.TASK.idFromName(taskId));
  const { proposal } = opts;

  const settle = (outcome: string, extra: Record<string, unknown> = {}) =>
    taskStub.fetch(
      new Request(`https://task/actions/${actionId}/settle`, {
        method: "POST",
        headers: (() => {
          const headers = new Headers({
            "content-type": "application/json",
            "x-tenant": opts.tenant,
          });
          if (opts.companyMember) headers.set("x-company-member", opts.companyMember);
          return headers;
        })(),
        body: JSON.stringify({ outcome, ...extra }),
      }),
    );

  // The connection must be live and ours: per-tenant vault, tenant match
  // plus no revocation. The secret itself travels only from the vault to
  // the provider call.
  const cred = env.CRED.get(env.CRED.idFromName(`t:${proposal.tenant || "operator"}`));
  const listing = (await (
    await cred.fetch(
      new Request(
        `https://cred/connections?tenant=${encodeURIComponent(proposal.tenant)}`,
        { headers: { "x-tenant": proposal.tenant } },
      ),
    )
  ).json()) as {
    connections?: {
      id?: string;
      accountId?: string;
      resourceIds?: string[];
      allowsActions?: boolean;
      grantRevision?: number;
    }[];
  };
  const connection = (listing.connections ?? []).find((entry) => entry.id === proposal.connectionId);
  if (!connection) {
    return settle("failed");
  }
  // The stored grant is authoritative: the approved account and target must
  // still sit inside the connection's granted scope, actions must be allowed,
  // and the stored revision must match the approved one. Anything else fails
  // closed here, before any provider traffic. Narrowing or revoking the grant
  // after approval therefore stops dispatch even though the approval itself
  // is untouched.
  if (connection.grantRevision !== proposal.grantRevision) {
    return settle("failed");
  }
  if (connection.allowsActions !== true) {
    return settle("failed");
  }
  try {
    checkGrant(
      {
        connectionId: connection.id ?? "",
        accountId: connection.accountId ?? "",
        resourceIds: connection.resourceIds ?? [],
        allowsActions: true,
      },
      { accountId: proposal.providerAccountId, resourceIds: [proposal.targetResourceId] },
    );
  } catch (error) {
    if (error instanceof ConnectorError) return settle("failed");
    throw error;
  }
  let secret: string;
  try {
    secret = await readConnectionSecret(
      env,
      proposal.connectionId,
      proposal.tenant,
    );
  } catch {
    return settle("failed");
  }

  if (proposal.operationType !== "linear.issue.create") {
    return settle("failed");
  }
  const payload = proposal.payload as { title?: unknown; description?: unknown };
  try {
    const receipt = await createLinearIssue(opts.fetchImpl ?? fetch, secret, {
      projectId: proposal.targetResourceId,
      title: typeof payload.title === "string" ? payload.title : "",
      description: typeof payload.description === "string" ? payload.description : undefined,
    });
    return settle("confirmed", { providerOperationId: receipt.id, receipt });
  } catch (error) {
    if (error instanceof ProviderFault && error.permanent) return settle("failed");
    return settle("unknown");
  }
}

/// Dispatches an approved action exactly once. Begin-then-finish inline: the
/// same halves the Worker runs split across the 202 boundary, kept as one
/// call so the broker unit tests cover both without a Worker round trip.
export async function dispatchAction(
  env: ActionEnv,
  taskId: string,
  actionId: string,
  opts: DispatchOptions,
): Promise<Response> {
  const begun = await beginDispatchAction(env, taskId, actionId, opts);
  if (!begun.ok) return begun.response;
  return finishDispatchAction(env, taskId, actionId, { ...opts, proposal: begun.proposal });
}
