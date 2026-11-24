/// The shop's Google connection as the Worker reads and changes it through the vault (google-vault.ts): its listing,
/// which never holds a secret, the vault's Google operations, and what the owner reads when the connection broke.
/// Shared by the owner's routes (google-connect.ts) and Ton's append (books-sheet.ts).

import { GOOGLE_PROVIDER, type SheetRef } from "./google-vault";
import { credStub, type TenantDataEnv } from "./tenant-data";

const enc = encodeURIComponent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// The shop's live Google connection, as the vault lists it (never a secret).
export type GoogleConnection = {
  id: string;
  accountId: string;
  grantRevision: number;
  createdAt: string;
  sheet: SheetRef | null;
  brokenAt: string | null;
  brokenReason: string | null;
};

/// The shop's live Google connection, null when it has none, undefined when the vault cannot be read. The vault keeps at
/// most one live (a new connection replaces the old in the same write), so the newest is the one.
export async function googleConnectionOf(env: Pick<TenantDataEnv, "CRED">, tenant: string):
  Promise<GoogleConnection | null | undefined> {
  try {
    const response = await credStub(env, tenant).fetch(new Request(`https://cred/connections?tenant=${enc(tenant)}`,
      { headers: { "x-tenant": tenant } }));
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { connections } = (await response.json()) as { connections?: Record<string, unknown>[] };
    const google = (connections ?? []).filter((connection) => connection.provider === GOOGLE_PROVIDER &&
      typeof connection.id === "string" && typeof connection.createdAt === "string")
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!google) return null;
    return {
      id: google.id as string,
      accountId: typeof google.accountId === "string" ? google.accountId : "",
      grantRevision: typeof google.grantRevision === "number" ? google.grantRevision : 1,
      createdAt: google.createdAt as string,
      sheet: isRecord(google.sheet) ? google.sheet as SheetRef : null,
      brokenAt: typeof google.brokenAt === "string" ? google.brokenAt : null,
      brokenReason: typeof google.brokenReason === "string" ? google.brokenReason : null,
    };
  } catch {
    return undefined;
  }
}

/// One of the vault's Google operations (google-vault.ts), with the Worker's own `x-google` header. Null when the vault
/// did not answer.
export async function googleVaultCall(env: Pick<TenantDataEnv, "CRED">, tenant: string, path: string,
  body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const response = await credStub(env, tenant).fetch(new Request(`https://cred${path}`, { method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant, "x-google": "1" },
      body: JSON.stringify(body) }));
    const answer = (await response.json().catch(() => null)) as unknown;
    return { status: response.status, body: isRecord(answer) ? answer : {} };
  } catch {
    return null;
  }
}

/// What the owner reads about a broken connection, by why it broke.
export function brokenWords(reason: string | null): string {
  return reason === "invalid_grant"
    ? "Google no longer lets Manut AI into your sheet: the access was removed or ran out. Connect Google again."
    : "Google refused Manut AI. Connect Google again.";
}
