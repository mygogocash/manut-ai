/// A person's own account deletion, from AuthObject's side (item 124; docs/pilot-api.md, "Deleting your own account").
/// The Worker runs the deletion (account-deletion.ts); this keeps what has to outlive it, in the one global object where a
/// person's sessions and index of shops already live:
///
/// - `account-deletion:<SHA-256 of the subject>`: the record of the deletion. Who asked is the account, named by the hash
///   of its subject (`apple:<sub>` or `email:<hash>`), so the record outlives the account without holding its Apple id; the
///   kind of sign-in; when it was asked for; the shops it deletes as their owner, each with its name and the owner link's
///   id; the shops it leaves as their helper, each with its name and the helper's id; when it finished; and what became of the Apple
///   token. It is written before anything is deleted, and a request that cannot write it deletes nothing. While one
///   request runs it holds a lease (`runningUntil`), so a second press answers `deletion_running` instead of deleting the
///   same shops twice at once; a deletion that stopped part way keeps its record, and the next request finishes the same
///   one, keeping when it was first asked for.
/// - `apple-grant:<hash>`: the person's Apple refresh token, sealed under the vault's key (cred-crypto.ts), kept from a
///   sign-in that carried an authorization code (apple-tokens.ts) until the account is deleted.
/// - `apple-revoke:<hash>`: that sealed token once the account is being deleted, until Apple has revoked it: tried at once,
///   then by this object's alarm on a lengthening wait (`RETRY_AFTER_MS`), at most `MAX_TRIES` times over about three days,
///   after which it is forgotten unrevoked and the record says so. The deletion never waits on Apple: a failure is
///   recorded here and retried, and the person's data is gone either way.
///
/// Writes need the Worker's `x-admin` header, like the other global index writes. A token is never in an answer, a record
/// other than its sealed row, or a log.

import { appleRestConfig, revokeToken, type AppleRestConfig, type AppleRestEnv } from "./apple-tokens";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { openSecret, sealSecret, type SealedSecret } from "./cred-crypto";
import { forgetPersonShops, personMakes } from "./shops-store";

/// What became of the person's Apple token: revoked at Apple; waiting for another try; never kept (signed in before this
/// item, or with no authorization code), so it could not be revoked by us; or given up after the last try.
export type AppleRevokeState = "revoked" | "retrying" | "no_token" | "gave_up";

export type OwnedShop = { shop: string; name: string; account: string };
export type HelpedShop = { shop: string; name: string; helper: string };

export type AccountDeletionRecord = {
  account: string;
  kind: "apple" | "email";
  requestedAt: string;
  owned: OwnedShop[];
  helping: HelpedShop[];
  /// Shops the person began to make and never finished, which the deletion takes too (shops-store.ts, `personMakes`).
  makes: string[];
  runningUntil?: number;
  finishedAt?: string;
  apple?: AppleRevokeState;
};

type KeptGrant = { sealed: SealedSecret; at: number };
type PendingRevoke = { account: string; sealed: SealedSecret; tries: number; nextAt: number; firstAt: number;
  lastStatus?: number };

/// How long one request holds the deletion. A shop's wipe is a few object calls each; this leaves room for many shops.
export const LEASE_MS = 5 * 60 * 1000;
/// The waits after each failed try to revoke, in order: about three days in all.
export const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000,
  24 * 3600_000];
/// The first try, then one after each wait.
export const MAX_TRIES = RETRY_AFTER_MS.length + 1;
/// Pending revokes one alarm run tries, so a run stays short whatever is queued.
const REVOKES_PER_RUN = 16;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHOPS = 64;

const RECORD = "account-deletion:";
const GRANT = "apple-grant:";
export const REVOKE = "apple-revoke:";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// The name a record and the Apple rows are kept under: the SHA-256 of the account's subject.
export function accountHash(subject: string): Promise<string> {
  return sha256Hex(subject);
}

function kindOf(subject: string): "apple" | "email" | null {
  return subject.startsWith("apple:") ? "apple" : subject.startsWith("email:") ? "email" : null;
}

function ownedOf(value: unknown): OwnedShop[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHOPS) return null;
  const out: OwnedShop[] = [];
  for (const one of value) {
    if (!isRecord(one) || !isValidTenant(one.shop) || typeof one.name !== "string" || one.name.length > 200 ||
        !isValidTenant(one.account)) return null;
    out.push({ shop: one.shop, name: one.name, account: one.account });
  }
  return out;
}

function helpingOf(value: unknown): HelpedShop[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHOPS) return null;
  const out: HelpedShop[] = [];
  for (const one of value) {
    if (!isRecord(one) || !isValidTenant(one.shop) || typeof one.name !== "string" || one.name.length > 200 ||
        !isValidTenant(one.helper)) return null;
    out.push({ shop: one.shop, name: one.name, helper: one.helper });
  }
  return out;
}

/// `a` with every entry of `b` whose shop it does not name yet.
function union<T extends { shop: string }>(a: readonly T[], b: readonly T[]): T[] {
  return [...a, ...b.filter((one) => !a.some((kept) => kept.shop === one.shop))];
}

// ---------------------------------------------------------------------------
// Keeping the Apple token at sign-in
// ---------------------------------------------------------------------------

/// Keeps `token`, sealed, as `subject`'s Apple refresh token, replacing any kept before: the newest sign-in's is the one a
/// deletion revokes. Throws when it cannot be sealed, which the exchange treats as nothing kept.
export async function keepAppleGrant(storage: DurableObjectStorage, config: AppleRestConfig, subject: string, token: string):
  Promise<void> {
  const sealed = await sealSecret(token, config.credKey);
  await storage.put(`${GRANT}${await accountHash(subject)}`, { sealed, at: Date.now() } satisfies KeptGrant);
}

// ---------------------------------------------------------------------------
// Revoking it
// ---------------------------------------------------------------------------

/// One try at revoking the pending token of `hash`, and its outcome written: gone and `revoked` on Apple's 200; otherwise
/// another try after the next wait, or forgotten and `gave_up` after the last. A token whose seal cannot be opened (the
/// vault's key changed twice since) can never be revoked, so it is given up at once. `none` when nothing is pending.
export async function tryRevoke(storage: DurableObjectStorage, env: AppleRestEnv, hash: string, nowMs = Date.now()):
  Promise<AppleRevokeState | "none"> {
  const pending = await storage.get<PendingRevoke>(`${REVOKE}${hash}`);
  if (!pending) return "none";
  const config = appleRestConfig(env);
  let status = -1;
  let ok = false;
  let unopenable = false;
  if (config) {
    let token: string | null = null;
    try {
      token = await openSecret(pending.sealed, config.credKey, config.credKeyPrevious);
    } catch {
      unopenable = true;
    }
    if (token !== null) {
      const result = await revokeToken(config, token);
      ok = result.ok;
      status = result.ok ? 200 : result.status;
    }
  }
  return storage.transaction(async (txn) => {
    const current = await txn.get<PendingRevoke>(`${REVOKE}${hash}`);
    if (!current) return "none" as const;
    const tries = current.tries + 1;
    const done = ok || unopenable || tries >= MAX_TRIES;
    const state: AppleRevokeState = ok ? "revoked" : done ? "gave_up" : "retrying";
    if (done) await txn.delete(`${REVOKE}${hash}`);
    else {
      await txn.put(`${REVOKE}${hash}`, { ...current, tries, lastStatus: status,
        nextAt: nowMs + (RETRY_AFTER_MS[tries - 1] ?? RETRY_AFTER_MS[RETRY_AFTER_MS.length - 1]!) } satisfies PendingRevoke);
    }
    const record = await txn.get<AccountDeletionRecord>(`${RECORD}${hash}`);
    if (record) await txn.put(`${RECORD}${hash}`, { ...record, apple: state });
    return state;
  });
}

/// The alarm's part: one try for each pending revoke that is due, at most `REVOKES_PER_RUN` a run. Answers when the next one
/// is due (ms since the epoch), or Infinity when none is left.
export async function retryAppleRevokes(storage: DurableObjectStorage, env: AppleRestEnv, nowMs = Date.now()): Promise<number> {
  const due: string[] = [];
  for (const [key, pending] of await storage.list<PendingRevoke>({ prefix: REVOKE })) {
    if (pending.nextAt <= nowMs && due.length < REVOKES_PER_RUN) due.push(key.slice(REVOKE.length));
  }
  for (const hash of due) await tryRevoke(storage, env, hash, nowMs);
  return nextRevokeAt(storage);
}

/// When the earliest pending revoke is due, or Infinity.
export async function nextRevokeAt(storage: Pick<DurableObjectStorage, "list"> | DurableObjectTransaction): Promise<number> {
  let next = Infinity;
  for (const [, pending] of await storage.list<PendingRevoke>({ prefix: REVOKE })) next = Math.min(next, pending.nextAt);
  return next;
}

// ---------------------------------------------------------------------------
// The Worker's routes on AuthObject
// ---------------------------------------------------------------------------

type Ops = {
  env: AppleRestEnv;
  /// Brings the object's one alarm forward to `ms` when it is set later, or not at all (auth-object.ts).
  alarmBy: (ms: number) => Promise<void>;
};

/// `/account-deletion` on AuthObject:
/// - `GET ?subject=`: the record, or null;
/// - `POST /begin` `{ subject, owned, helping }`: writes the record and takes the lease, or answers 409 `deletion_running`
///   while another request holds it. A record that has not finished is the same deletion: what it covers is kept and the new
///   request's shops are added. The answer is the record, with `makes`, the person's unfinished makes, filled in.
/// - `POST /release` `{ subject }`: gives the lease back, after a stop.
/// - `POST /forget` `{ subject }`: in one transaction, every row of the person's index of shops (shops-store.ts), and their
///   Apple token moved from kept to pending revoke, with the alarm brought forward to try it.
/// - `POST /revoke` `{ subject }`: one try at the pending revoke now, and what it came to.
/// - `POST /finish` `{ subject }`: the deletion finished; the lease goes.
export async function accountDeletionRoute(storage: DurableObjectStorage, request: Request, url: URL, ops: Ops):
  Promise<Response> {
  if (request.method === "GET" && url.pathname === "/account-deletion") {
    const subject = url.searchParams.get("subject") ?? "";
    if (!kindOf(subject)) return json({ error: "invalid_request" }, 400);
    return json({ record: (await storage.get<AccountDeletionRecord>(`${RECORD}${await accountHash(subject)}`)) ?? null });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-admin") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || typeof body.subject !== "string") return json({ error: "invalid_request" }, 400);
  const subject = body.subject;
  const kind = kindOf(subject);
  if (!kind || !isValidTenant(subject)) return json({ error: "invalid_request" }, 400);
  const hash = await accountHash(subject);
  const key = `${RECORD}${hash}`;
  switch (url.pathname) {
    case "/account-deletion/begin": {
      const owned = ownedOf(body.owned);
      const helping = helpingOf(body.helping);
      if (!owned || !helping) return json({ error: "invalid_request" }, 400);
      const answer = storage.transactionSync(() => {
        const nowMs = Date.now();
        const kept = storage.kv.get<AccountDeletionRecord>(key);
        if (kept && !kept.finishedAt && (kept.runningUntil ?? 0) > nowMs) return null;
        const makes = personMakes(storage.kv, subject);
        const record: AccountDeletionRecord = kept && !kept.finishedAt
          ? { ...kept, owned: union(kept.owned, owned), helping: union(kept.helping, helping),
            makes: [...new Set([...kept.makes, ...makes])], runningUntil: nowMs + LEASE_MS }
          : { account: hash, kind, requestedAt: new Date(nowMs).toISOString(), owned, helping, makes,
            runningUntil: nowMs + LEASE_MS };
        storage.kv.put(key, record);
        return record;
      });
      return answer ? json({ record: answer }) : json({ error: "deletion_running" }, 409);
    }
    case "/account-deletion/release": {
      storage.transactionSync(() => {
        const kept = storage.kv.get<AccountDeletionRecord>(key);
        if (kept?.runningUntil !== undefined) {
          const { runningUntil: _released, ...rest } = kept;
          storage.kv.put(key, rest);
        }
      });
      return json({ released: true });
    }
    case "/account-deletion/forget": {
      const grantKey = `${GRANT}${hash}`;
      const nowMs = Date.now();
      const pending = storage.transactionSync(() => {
        forgetPersonShops(storage.kv, subject);
        const grant = storage.kv.get<KeptGrant>(grantKey);
        const queued = storage.kv.get<PendingRevoke>(`${REVOKE}${hash}`);
        if (grant) {
          storage.kv.delete(grantKey);
          if (!queued) {
            storage.kv.put(`${REVOKE}${hash}`, { account: hash, sealed: grant.sealed, tries: 0, nextAt: nowMs,
              firstAt: nowMs } satisfies PendingRevoke);
          }
        }
        const record = storage.kv.get<AccountDeletionRecord>(key);
        const waiting = Boolean(grant || queued);
        // An Apple account with no token kept has nothing for us to revoke: the record and the answer say so, and the
        // person can end it in their Apple Account's settings (TN3194).
        if (record && !record.apple) {
          const apple: AppleRevokeState | undefined = waiting ? "retrying" : kind === "apple" ? "no_token" : undefined;
          if (apple) storage.kv.put(key, { ...record, apple });
        }
        return waiting;
      });
      if (pending) await ops.alarmBy(nowMs);
      return json({ pending });
    }
    case "/account-deletion/revoke":
      return json({ apple: await tryRevoke(storage, ops.env, hash) });
    case "/account-deletion/finish": {
      const record = storage.transactionSync(() => {
        const kept = storage.kv.get<AccountDeletionRecord>(key);
        if (!kept) return null;
        const { runningUntil: _done, ...rest } = kept;
        const finished: AccountDeletionRecord = { ...rest, finishedAt: kept.finishedAt ?? new Date().toISOString() };
        storage.kv.put(key, finished);
        return finished;
      });
      return record ? json({ record }) : json({ error: "not_found" }, 404);
    }
  }
  return json({ error: "not_found" }, 404);
}
