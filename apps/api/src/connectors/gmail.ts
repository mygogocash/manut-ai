import {
  base64UrlToText,
  checkGrant,
  ConnectorError,
  providerGet,
  textFromHtml,
  type FetchImpl,
  type ResourceGrant,
  type SourceRecord,
} from "./types";

export type GmailMessage = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string;
  labelIds: string[];
};

export type GmailReadArgs = {
  accountId: string;
  /// Label ids from the grant. Passed to the API as labelIds, so Google
  /// enforces the narrowed scope no matter what the query says.
  labelIds: string[];
  query: string;
  maxResults: number;
  pageToken?: string;
};

const GMAIL_READONLY = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

/// Minimal OAuth scopes this connector needs. The broker requests exactly
/// these; send or full-mailbox scopes arrive only through separate consent.
export const GMAIL_SCOPES: readonly string[] = GMAIL_READONLY;

function messageShape(payload: unknown): GmailMessage {
  const root = payload as Record<string, unknown>;
  if (typeof root.id !== "string") throw new Error("shape");
  const headers = ((root.payload as Record<string, unknown> | undefined)?.headers ?? []) as {
    name?: string;
    value?: string;
  }[];
  const header = (name: string) => headers.find((entry) => entry.name?.toLowerCase() === name)?.value ?? "";
  const parts = (root.payload as Record<string, unknown> | undefined)?.parts;
  const body = (root.payload as Record<string, unknown> | undefined)?.body as
    | { data?: string; mimeType?: string }
    | undefined;
  // Prefer a plain-text part; fall back to sanitized HTML, then the snippet.
  let bodyText = typeof root.snippet === "string" ? root.snippet : "";
  const candidates = Array.isArray(parts) ? parts : body ? [body] : [];
  for (const part of candidates) {
    const candidate = part as { mimeType?: string; body?: { data?: string } };
    if (candidate.mimeType === "text/plain" && candidate.body?.data) {
      bodyText = base64UrlToText(candidate.body.data);
      break;
    }
  }
  if (!bodyText || bodyText === root.snippet) {
    for (const part of candidates) {
      const candidate = part as { mimeType?: string; body?: { data?: string } };
      if (candidate.mimeType === "text/html" && candidate.body?.data) {
        const html = base64UrlToText(candidate.body.data);
        bodyText = textFromHtml(html);
        break;
      }
    }
  }
  const labels = Array.isArray(root.labelIds) ? root.labelIds.filter((id): id is string => typeof id === "string") : [];
  return {
    id: root.id,
    threadId: typeof root.threadId === "string" ? root.threadId : "",
    subject: header("subject"),
    from: header("from"),
    date: header("date"),
    snippet: typeof root.snippet === "string" ? root.snippet : "",
    bodyText,
    labelIds: labels,
  };
}

/// Bounded Gmail retrieval inside an approved mailbox slice. Labels come
/// from the grant and ride the API's labelIds filter; the model query only
/// narrows further. Attachments stay out by default: bodies carry text.
export async function readGmail(
  fetchImpl: FetchImpl,
  grant: ResourceGrant,
  token: string,
  args: GmailReadArgs,
): Promise<{ messages: SourceRecord<GmailMessage>[]; nextPageToken?: string | undefined }> {
  checkGrant(grant, { accountId: args.accountId, resourceIds: args.labelIds });
  if (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 50) {
    throw new ConnectorError("forbidden", "bounds");
  }
  const params = new URLSearchParams({ maxResults: String(args.maxResults), q: args.query });
  for (const label of args.labelIds) params.append("labelIds", label);
  if (args.pageToken) params.set("pageToken", args.pageToken);
  const listing = await providerGet(
    fetchImpl,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    token,
    (payload) => {
      const root = payload as { messages?: { id?: string }[]; nextPageToken?: string };
      if (root.messages !== undefined && !Array.isArray(root.messages)) throw new Error("shape");
      return {
        ids: (root.messages ?? []).map((entry) => {
          if (typeof entry.id !== "string") throw new Error("shape");
          return entry.id;
        }),
        nextPageToken: typeof root.nextPageToken === "string" ? root.nextPageToken : undefined,
      };
    },
  );
  const retrievedAt = new Date().toISOString();
  const messages: SourceRecord<GmailMessage>[] = [];
  for (const id of listing.ids) {
    const record = await providerGet(
      fetchImpl,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      token,
      messageShape,
    );
    messages.push({
      record,
      source: { provider: "gmail", accountId: args.accountId, retrievedAt },
      deepLink: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    });
  }
  return { messages, nextPageToken: listing.nextPageToken };
}
