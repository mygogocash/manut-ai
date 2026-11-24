/// The Google connection's part of the shop's vault (CredObject, cred-object.ts), for Ton's books in a Google Sheet
/// (docs/connectors.md, 4b). The connection is an ordinary vault connection of the provider kind `gsheets`, its refresh
/// token sealed under `CRED_KEY` like every other, so listing, reading for the broker, revoking, re-keying, re-sealing
/// and the tenant's wipe treat it as they treat the rest. What only a Google connection has is here:
///
/// - **Made only by the sign-in.** `POST /google/connections` stores the refresh token the callback received, and in the
///   same write forgets every other live Google connection of the shop: a second connect replaces the first. The generic
///   `POST /connections` refuses this provider (cred-object.ts), so no route can put a Google token in by another way.
/// - **The sheet.** The connection keeps the id, title and tab of the spreadsheet Ton appends to, never what is in it, and
///   its one granted resource is that spreadsheet, so a proposal for any other is refused before Google is called. A new
///   sheet is made at most once at a time: whoever makes it first claims the connection (`/google/sheet-claim`), and only
///   that claim may then bind the sheet it made (`/google/sheet`), which moves the grant to a new revision.
/// - **Broken.** When Google refuses the grant (`invalid_grant`), `/google/broken` marks the connection broken; nothing is
///   sent through it again, and the owner connects again to mend it.
/// - **The sign-in in flight.** `/google/flows` keeps one pending sign-in per shop: the SHA-256 of its `state`, the PKCE
///   verifier sealed like a secret, who started it, and its end ten minutes on. `/google/flows/take` hands it back once
///   and deletes it in the same step, so a callback can be used once, and never after its time.
///
/// Every write needs the Worker's `x-google` header, which only this API's own code sets, and works on the tenant the
/// `x-tenant` header names; a record of another tenant reads as missing.

import { readJsonBody } from "./body";
import { openSecret, sealSecret, type SealedSecret } from "./cred-crypto";
import type { StoredConnectionRec } from "./cred-object";

/// The vault's provider kind for the owner's Google account, connected with `drive.file` only.
export const GOOGLE_PROVIDER = "gsheets";
/// What the connection names as its account. With `drive.file` alone Google does not say who signed in (that would need
/// the `openid` and `email` scopes, a wider promise than the books need), so every Google connection names the same
/// placeholder, and a proposal still binds the connection by its id.
export const GOOGLE_ACCOUNT = "google";
/// How long a pending sign-in waits for its callback.
export const FLOW_TTL_MS = 10 * 60 * 1000;
/// How long a claim to make the sheet holds before another ask may make one instead.
const SHEET_CLAIM_SECONDS = 120;
const MAX_BODY_BYTES = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/// The sheet a Google connection appends to. Its title and tab are as they were when it was made; an ask reads the title
/// as it is now from Google.
export type SheetRef = { id: string; title: string; tab: string; url: string | null; madeAt: string };

/// What only a Google connection's record carries, beside the fields every connection has.
export type GoogleFields = {
  sheet?: SheetRef;
  brokenAt?: string;
  brokenReason?: string;
  /// The one claim to make a sheet now: a random token and when it lapses, in seconds.
  sheetClaim?: { token: string; until: number };
};

type GoogleRec = StoredConnectionRec & GoogleFields;

/// One pending sign-in. The state itself is never kept, only its hash, as a shop session is kept.
type FlowRec = {
  tenant: string;
  stateHash: string;
  verifier: SealedSecret;
  /// Who started it: the owner's linked account by its id, or `owner-session` for the shop's own session.
  startedBy: string;
  /// The SHA-256 of the owner session that started it (`mos1.`), so the callback can check that session still holds;
  /// null for the shop's own session, which the lifted auth holds by its token alone.
  sessionHash: string | null;
  createdAt: string;
  expiresAt: number;
};

type VaultKeys = { CRED_KEY?: string; CRED_KEY_PREVIOUS?: string };

const FLOW_PREFIX = "gflow:";
const CONN_PREFIX = "conn:";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= max && !CONTROL.test(value);
}

export function isGoogleVaultPath(pathname: string): boolean {
  return pathname.startsWith("/google/");
}

/// The keys of the shop's pending sign-ins, for the tenant's wipe (cred-object.ts). Google connections are `conn:` records
/// and go with the rest.
export async function googleFlowKeys(storage: DurableObjectStorage): Promise<string[]> {
  return [...(await storage.list({ prefix: FLOW_PREFIX })).keys()];
}

/// A live Google connection of `tenant`, or null.
function liveGoogle(record: GoogleRec | undefined, tenant: string): GoogleRec | null {
  return record && record.tenant === tenant && record.provider === GOOGLE_PROVIDER && !record.revokedAt ? record : null;
}

export async function googleVaultRoute(storage: DurableObjectStorage, keys: VaultKeys, request: Request, url: URL):
  Promise<Response> {
  const tenant = request.headers.get("x-tenant") ?? "";
  if (!tenant) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-google") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  switch (url.pathname) {
    case "/google/flows":
      return startFlow(storage, keys, tenant, body);
    case "/google/flows/take":
      return takeFlow(storage, keys, tenant, body);
    case "/google/connections":
      return storeConnection(storage, keys, tenant, body);
    case "/google/sheet-claim":
      return claimSheet(storage, tenant, body);
    case "/google/sheet":
      return bindSheet(storage, tenant, body);
    case "/google/sheet-release":
      return releaseSheet(storage, tenant, body);
    case "/google/broken":
      return markBroken(storage, tenant, body);
    default:
      return json({ error: "not_found" }, 404);
  }
}

/// `POST /google/flows` with exactly `{ stateHash, verifier, startedBy, sessionHash }`: a new pending sign-in, in place of
/// any the shop had, so only the newest link the owner opened can finish.
async function startFlow(storage: DurableObjectStorage, keys: VaultKeys, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  if (!keys.CRED_KEY) return json({ error: "vault_not_configured" }, 503);
  const { stateHash, verifier, startedBy, sessionHash } = body;
  if (!hasExactly(body, ["stateHash", "verifier", "startedBy", "sessionHash"]) || typeof stateHash !== "string" ||
      !HEX64.test(stateHash) || typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !text(startedBy, 256) || !(sessionHash === null || (typeof sessionHash === "string" && HEX64.test(sessionHash)))) {
    return json({ error: "invalid_request" }, 400);
  }
  const sealed = await sealSecret(verifier, keys.CRED_KEY);
  const nowMs = Date.now();
  const flow: FlowRec = { tenant, stateHash, verifier: sealed, startedBy, sessionHash,
    createdAt: new Date(nowMs).toISOString(), expiresAt: nowMs + FLOW_TTL_MS };
  storage.transactionSync(() => {
    const kv = storage.kv;
    // The keys are read whole before any is deleted, so no delete runs under the list it came from.
    for (const key of [...kv.list({ prefix: FLOW_PREFIX })].map(([listed]) => listed)) kv.delete(key);
    kv.put(`${FLOW_PREFIX}${stateHash}`, flow);
  });
  return json({ expiresAt: new Date(flow.expiresAt).toISOString() });
}

/// `POST /google/flows/take` with exactly `{ stateHash }`: the pending sign-in that state started, deleted in the same
/// step it is read, so a second callback with the same state finds nothing. 404 `unknown_state` for a state this shop
/// never started or already used, 410 `state_expired` for one past its ten minutes (deleted all the same).
async function takeFlow(storage: DurableObjectStorage, keys: VaultKeys, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const { stateHash } = body;
  if (!hasExactly(body, ["stateHash"]) || typeof stateHash !== "string" || !HEX64.test(stateHash)) {
    return json({ error: "invalid_request" }, 400);
  }
  const taken = storage.transactionSync(() => {
    const kv = storage.kv;
    const flow = kv.get<FlowRec>(`${FLOW_PREFIX}${stateHash}`);
    if (flow) kv.delete(`${FLOW_PREFIX}${stateHash}`);
    return flow;
  });
  if (!taken || taken.tenant !== tenant) return json({ error: "unknown_state" }, 404);
  if (!(Date.now() < taken.expiresAt)) return json({ error: "state_expired" }, 410);
  if (!keys.CRED_KEY) return json({ error: "vault_not_configured" }, 503);
  try {
    const verifier = await openSecret(taken.verifier, keys.CRED_KEY, keys.CRED_KEY_PREVIOUS);
    return json({ verifier, startedBy: taken.startedBy, sessionHash: taken.sessionHash });
  } catch {
    return json({ error: "unseal_failed" }, 500);
  }
}

/// `POST /google/connections` with exactly `{ refreshToken, scopes }`: the shop's Google connection, sealed, in place of
/// any it had. In one write every other live Google connection of the shop is forgotten (its sealed token wiped and the
/// record kept as a tombstone, as every revoked connection is) and the new one is stored, so the shop never has two. It is
/// not revoked at Google: revoking ends the whole grant the account gave the project, and when the same account connects
/// again that would end the new token too. The newest earlier connection's sheet is carried over, so the books stay in one
/// spreadsheet; the next ask checks it is still there for this account before naming it. Answers the new id and the ids
/// it replaced.
async function storeConnection(storage: DurableObjectStorage, keys: VaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  if (!keys.CRED_KEY) return json({ error: "vault_not_configured" }, 503);
  const { refreshToken, scopes } = body;
  if (!hasExactly(body, ["refreshToken", "scopes"]) || typeof refreshToken !== "string" || refreshToken.length === 0 ||
      refreshToken.length > 8192 || !Array.isArray(scopes) || scopes.length === 0 || scopes.length > 10 ||
      !scopes.every((scope) => text(scope, 256))) {
    return json({ error: "invalid_request" }, 400);
  }
  const sealed = await sealSecret(refreshToken, keys.CRED_KEY);
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const replaced = storage.transactionSync(() => {
    const kv = storage.kv;
    // Read whole before anything is written, so no write runs under the list it came from.
    const earlier = [...kv.list<GoogleRec>({ prefix: CONN_PREFIX })].map(([, record]) => record)
      .filter((record) => record.tenant === tenant && record.provider === GOOGLE_PROVIDER);
    const newestWithSheet = earlier.filter((record) => record.sheet)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
    const gone: string[] = [];
    for (const record of earlier) {
      if (record.revokedAt) continue;
      const { sheetClaim: _claim, ...rest } = record;
      kv.put(`${CONN_PREFIX}${record.id}`, { ...rest, sealed: { keyTag: "", iv: "", data: "" }, revokedAt: nowIso,
        refreshLeaseUntil: 0 } satisfies GoogleRec);
      gone.push(record.id);
    }
    const sheet = newestWithSheet?.sheet;
    const record: GoogleRec = {
      id,
      tenant,
      provider: GOOGLE_PROVIDER,
      accountId: GOOGLE_ACCOUNT,
      scopes: [...(scopes as string[])],
      sealed,
      createdAt: nowIso,
      revokedAt: null,
      refreshLeaseUntil: 0,
      resourceIds: sheet ? [sheet.id] : [],
      allowsActions: true,
      grantRevision: 1,
      ...(sheet ? { sheet } : {}),
    };
    kv.put(`${CONN_PREFIX}${id}`, record);
    return gone;
  });
  return json({ id, replaced });
}

/// The live Google connection `body.id` names, or the refusal to send.
function connectionFor(storage: DurableObjectStorage, tenant: string, id: unknown): GoogleRec | Response {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return json({ error: "invalid_request" }, 400);
  return liveGoogle(storage.kv.get<GoogleRec>(`${CONN_PREFIX}${id}`), tenant) ?? json({ error: "not_found" }, 404);
}

/// `POST /google/sheet-claim` with exactly `{ id, replacing }`: claims the right to make the connection's sheet now.
/// `replacing` is the sheet the caller found gone, or null when the connection had none; if the connection now names
/// another (someone made one meanwhile) the claim is refused as `sheet_changed`, and while another claim holds, as
/// `sheet_in_progress`. A broken connection makes nothing. Answers the claim's token, which binding needs.
function claimSheet(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  if (!hasExactly(body, ["id", "replacing"]) || !(body.replacing === null ||
      (typeof body.replacing === "string" && SPREADSHEET_ID.test(body.replacing)))) {
    return json({ error: "invalid_request" }, 400);
  }
  return storage.transactionSync(() => {
    const record = connectionFor(storage, tenant, body.id);
    if (record instanceof Response) return record;
    if (record.brokenAt) return json({ error: "connection_broken" }, 409);
    if ((record.sheet?.id ?? null) !== body.replacing) return json({ error: "sheet_changed" }, 409);
    const nowS = Date.now() / 1000;
    if (record.sheetClaim && record.sheetClaim.until > nowS) return json({ error: "sheet_in_progress" }, 409);
    const token = crypto.randomUUID();
    storage.kv.put(`${CONN_PREFIX}${record.id}`, { ...record, sheetClaim: { token, until: nowS + SHEET_CLAIM_SECONDS } });
    return json({ claim: token });
  });
}

/// `POST /google/sheet` with exactly `{ id, claim, sheet: { id, title, tab, url } }`: the sheet the claim's holder made,
/// kept with the connection as its one granted resource, under a new grant revision so nothing approved for an earlier
/// sheet can go to this one. Refused as `claim_lost` unless the claim is still this connection's.
function bindSheet(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  const sheet = body.sheet;
  if (!hasExactly(body, ["id", "claim", "sheet"]) || typeof body.claim !== "string" || !isRecord(sheet) ||
      !hasExactly(sheet, ["id", "title", "tab", "url"]) || typeof sheet.id !== "string" ||
      !SPREADSHEET_ID.test(sheet.id) || !text(sheet.title, 200) || !text(sheet.tab, 100) ||
      !(sheet.url === null || (text(sheet.url, 512) && sheet.url.startsWith("https://")))) {
    return json({ error: "invalid_request" }, 400);
  }
  return storage.transactionSync(() => {
    const record = connectionFor(storage, tenant, body.id);
    if (record instanceof Response) return record;
    if (record.sheetClaim?.token !== body.claim) return json({ error: "claim_lost" }, 409);
    const { sheetClaim: _claim, ...rest } = record;
    const made: SheetRef = { id: sheet.id as string, title: sheet.title as string, tab: sheet.tab as string,
      url: sheet.url as string | null, madeAt: new Date().toISOString() };
    const grantRevision = (record.grantRevision ?? 1) + 1;
    storage.kv.put(`${CONN_PREFIX}${record.id}`, { ...rest, sheet: made, resourceIds: [made.id], allowsActions: true,
      grantRevision } satisfies GoogleRec);
    return json({ sheet: made, grantRevision });
  });
}

/// `POST /google/sheet-release` with exactly `{ id, claim }`: gives a claim back when no sheet was made under it.
function releaseSheet(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  if (!hasExactly(body, ["id", "claim"]) || typeof body.claim !== "string") return json({ error: "invalid_request" }, 400);
  return storage.transactionSync(() => {
    const record = connectionFor(storage, tenant, body.id);
    if (record instanceof Response) return record;
    if (record.sheetClaim?.token === body.claim) {
      const { sheetClaim: _claim, ...rest } = record;
      storage.kv.put(`${CONN_PREFIX}${record.id}`, rest);
    }
    return json({ released: true });
  });
}

/// `POST /google/broken` with exactly `{ id, reason }`: Google refused the grant, so the connection is broken from now on
/// and nothing is sent through it. Answers whether this call is the one that broke it, so it is written to the log once.
function markBroken(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>): Response {
  if (!hasExactly(body, ["id", "reason"]) || typeof body.reason !== "string" || !CODE.test(body.reason)) {
    return json({ error: "invalid_request" }, 400);
  }
  return storage.transactionSync(() => {
    const record = connectionFor(storage, tenant, body.id);
    if (record instanceof Response) return record;
    if (record.brokenAt) return json({ broken: true, newly: false });
    storage.kv.put(`${CONN_PREFIX}${record.id}`, { ...record, brokenAt: new Date().toISOString(),
      brokenReason: body.reason as string });
    return json({ broken: true, newly: true });
  });
}
