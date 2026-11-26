/// Typed connector contracts. Every read takes its resource scope from the
/// approved grant, never from model input: prompt text, mail HTML, and tool
/// arguments are untrusted data and cannot widen accounts, labels, calendars,
/// or projects. Adapters take an injected fetch plus a broker-supplied token
/// so tests run them against fixtures while production passes global fetch.

export type ConnectorName = "gmail" | "gcal" | "linear";

/// The approved slice one Role may read, mirroring OfficeConnectionGrant.
export type ResourceGrant = {
  connectionId: string;
  accountId: string;
  /// Provider-native scope: Gmail label ids, Calendar calendar ids, Linear
  /// project ids. Empty means the adapter's safe default, never everything.
  resourceIds: string[];
  allowsActions: boolean;
};

/// Provenance every returned record carries: what it is, where it came from,
/// and when it was read. Source update time and retrieval time stay distinct.
export type SourceRecord<T> = {
  record: T;
  source: {
    provider: ConnectorName;
    accountId: string;
    retrievedAt: string;
  };
  deepLink?: string | undefined;
};

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class ConnectorError extends Error {
  readonly code:
    | "auth"
    | "forbidden"
    | "rate_limited"
    | "network"
    | "schema"
    | "scope_escape";
  readonly retryAfter?: number | undefined;

  constructor(code: ConnectorError["code"], message: string, retryAfter?: number | undefined) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/// Rejects any call whose account or resource differs from the grant before
/// any provider traffic happens. Model-supplied values never reach the
/// adapter uncompared.
export function checkGrant(
  grant: ResourceGrant,
  args: { accountId: string; resourceIds: string[] },
): void {
  if (args.accountId !== grant.accountId) throw new ConnectorError("forbidden", "account_escape");
  const allowed = new Set(grant.resourceIds);
  for (const id of args.resourceIds) {
    if (!allowed.has(id)) throw new ConnectorError("forbidden", "resource_escape");
  }
}

export async function providerGet<T>(
  fetchImpl: FetchImpl,
  url: string,
  token: string,
  parse: (payload: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ConnectorError("network", "provider_unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError("auth", "provider_rejected_credentials");
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    throw new ConnectorError(
      "rate_limited",
      "provider_throttled",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  if (!response.ok) throw new ConnectorError("network", `provider_${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ConnectorError("schema", "provider_bad_json");
  }
  try {
    return parse(payload);
  } catch {
    throw new ConnectorError("schema", "provider_shape_changed");
  }
}

/// Decodes base64url (Gmail bodies, JWT parts) to UTF-8 text without Node
/// Buffer, which workerd does not guarantee.
export function base64UrlToText(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/// Strips markup for display. Display text is derived, never trusted structure.
/// Script and style blocks go whole, whatever their closing tag carries
/// (`</script >`, attributes, capitals), so their code never reaches the text.
/// Entities are decoded once, `&amp;` last: decoding it first would turn the
/// text `&amp;lt;` into `<`, unescaping twice.
export function textFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
