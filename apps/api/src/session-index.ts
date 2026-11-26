/// The lifted auth's sessions, kept small and found by tenant (docs/pilot-api.md, "Sessions"). AuthObject is one object for
/// every person, and before this its sessions were never swept and a tenant's wipe read every session there was. Two
/// things here change that, and AuthObject calls each from one place:
///
/// - **The per-tenant index.** Every grant chain (an access record `sat:<hash>` and its refresh grant `srt:<hash>`) has
///   one row under its tenant, `tenant-session:<tenant>:<refresh hash>`, written and deleted in the same transaction as the
///   chain's own records: minted with them, moved on by each refresh, and gone when the chain is revoked, ends at a
///   check, is wiped or is swept. A tenant's wipe lists only its own rows (`wipeTenantSessions`).
/// - **The sweep.** The object's one alarm also sweeps sessions (`sweepSessions`): each run reads at most `SWEEP_BATCH`
///   records from where the last run stopped, deletes the access records past their hour and the grants past their 30
///   days or their chain's 90, and saves where it stopped. A pass that has more to read runs again ten seconds on; a
///   finished pass starts the next an hour later while any session is left, and none is set when none is.
///
/// Sessions made before the index have no row. The sweep's first full pass gives every live grant it reads a row (a
/// one-time pass, spread over the alarm's runs, a page at a time) and then marks the index filled. Until then a wipe also
/// looks for its tenant's records the old way, so no old session outlives its tenant's deletion while the pass runs.

/// A chain's row in its tenant's index: its access record's hash, and the wipe generation it was minted at, so a wipe
/// ends only the chains older than itself without reading their records.
export type SessionIndexRow = { accessHash: string; generation: number };

const ACCESS_PREFIX = "sat:";
const REFRESH_PREFIX = "srt:";
const INDEX_PREFIX = "tenant-session:";
/// Where the sweep stopped, and the mark its first full pass leaves.
const SWEEP_CURSOR_KEY = "session-sweep";
const INDEX_FILLED_KEY = "session-index-filled";

/// Session records one alarm run reads at most, so a run stays short however many sessions the object keeps.
export const SWEEP_BATCH = 256;
/// How long a finished pass waits before the next starts, while sessions are left. An access record lasts an hour, so
/// none outlives its end by much more than another hour.
export const SWEEP_EVERY_SECONDS = 3600;
/// How long a pass part way through waits before its next run: long enough to leave the object's requests room between
/// runs, short enough that a pass over a hundred thousand sessions still finishes within the hour.
export const SWEEP_PAUSE_SECONDS = 10;
/// The absolute cap on a grant chain (auth-object.ts, `REFRESH_ABSOLUTE_TTL_SECONDS`): a grant older than this is
/// refused at its next refresh, so the sweep may take it.
const CHAIN_LIFETIME_SECONDS = 90 * 24 * 3600;
/// Keys a storage call reads or deletes at a time: Durable Object storage takes at most 128 keys per delete.
const PAGE = 128;

type Store = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;

/// The sweep's place: the prefix it is reading, and the last key it read there.
type SweepCursor = { prefix: typeof ACCESS_PREFIX | typeof REFRESH_PREFIX; after?: string };

const enc = encodeURIComponent;

/// The prefix of one tenant's rows. The tenant is URI-encoded, so its own `:` can never make one tenant's prefix another's.
export function sessionIndexPrefix(tenant: string): string {
  return `${INDEX_PREFIX}${enc(tenant)}:`;
}

/// The row of the chain whose refresh grant has `refreshHash`.
export function sessionIndexKey(tenant: string, refreshHash: string): string {
  return `${sessionIndexPrefix(tenant)}${refreshHash}`;
}

/// A record's wipe generation: absent on records older than wipes, which belong to generation zero. A value this code
/// never writes throws, as AuthObject's own reading does, so nothing is taken for a generation it is not.
export function wipeGeneration(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("invalid_wipe_generation");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether an access record is past its hour. A record with no end this code wrote is no session anyone may use, so it
/// goes too.
function accessEnded(value: unknown, now: number): boolean {
  return !isRecord(value) || typeof value.exp !== "number" || !Number.isFinite(value.exp) || value.exp <= now;
}

/// Whether a refresh grant can never refresh again: past its 30 days, past its chain's 90, or not a grant this code wrote.
function grantEnded(value: unknown, now: number): boolean {
  if (!isRecord(value) || typeof value.exp !== "number" || !Number.isFinite(value.exp) || value.exp <= now) return true;
  return typeof value.born === "number" && now - value.born > CHAIN_LIFETIME_SECONDS;
}

/// Deletes `keys`, at most `PAGE` a call.
async function deleteKeys(storage: Store, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += PAGE) await storage.delete(keys.slice(i, i + PAGE));
}

/// One alarm run's share of the sweep, in the alarm's transaction, at `now` (seconds since the epoch). Answers when the
/// next run is due, in seconds: a pause on while the pass has more to read, an hour on once it has finished with sessions
/// left, and never (`Infinity`) when none are left.
export async function sweepSessions(storage: Store, now: number): Promise<number> {
  let cursor = (await storage.get<SweepCursor>(SWEEP_CURSOR_KEY)) ?? { prefix: ACCESS_PREFIX };
  const filled = (await storage.get(INDEX_FILLED_KEY)) === true;
  let budget = SWEEP_BATCH;
  while (budget > 0) {
    const limit = Math.min(PAGE, budget);
    const page = await storage.list<unknown>({ prefix: cursor.prefix, limit,
      ...(cursor.after === undefined ? {} : { startAfter: cursor.after }) });
    budget -= page.size;
    const ended: string[] = [];
    const rows: Record<string, SessionIndexRow> = {};
    for (const [key, value] of page) {
      cursor = { prefix: cursor.prefix, after: key };
      if (cursor.prefix === ACCESS_PREFIX) {
        // An access record alone: its grant may still refresh, so the grant and the row stay.
        if (accessEnded(value, now)) ended.push(key);
        continue;
      }
      const refreshHash = key.slice(REFRESH_PREFIX.length);
      const tenant = isRecord(value) && typeof value.tenant === "string" ? value.tenant : null;
      const accessHash = isRecord(value) && typeof value.accessHash === "string" ? value.accessHash : null;
      if (grantEnded(value, now)) {
        // The grant can never refresh again. The access record it last minted may still have part of its hour (a
        // refresh just before the chain's 90 days), and then the chain waits for a later pass. Otherwise it is over: its
        // grant, that access record and its row go together.
        if (accessHash && !accessEnded(await storage.get(`${ACCESS_PREFIX}${accessHash}`), now)) continue;
        ended.push(key, ...(accessHash ? [`${ACCESS_PREFIX}${accessHash}`] : []),
          ...(tenant ? [sessionIndexKey(tenant, refreshHash)] : []));
      } else if (!filled && tenant && accessHash) {
        // The first pass: a live grant made before the index gets the row it would have been minted with.
        const row = sessionIndexKey(tenant, refreshHash);
        if ((await storage.get(row)) === undefined) {
          rows[row] = { accessHash, generation: wipeGeneration((value as { wipeGeneration?: unknown }).wipeGeneration) };
        }
      }
    }
    await deleteKeys(storage, ended);
    if (Object.keys(rows).length > 0) await storage.put(rows);
    if (page.size < limit) {
      if (cursor.prefix === ACCESS_PREFIX) {
        cursor = { prefix: REFRESH_PREFIX };
        continue;
      }
      // The pass is over. The next starts from the first session, and every grant made before the index now has its row.
      await storage.delete(SWEEP_CURSOR_KEY);
      if (!filled) await storage.put(INDEX_FILLED_KEY, true);
      const left = (await storage.list({ prefix: ACCESS_PREFIX, limit: 1 })).size +
        (await storage.list({ prefix: REFRESH_PREFIX, limit: 1 })).size;
      return left > 0 ? now + SWEEP_EVERY_SECONDS : Infinity;
    }
  }
  await storage.put(SWEEP_CURSOR_KEY, cursor);
  return now + SWEEP_PAUSE_SECONDS;
}

/// Ends `tenant`'s sessions older than a wipe that moved it to `generation`: every chain its own rows name, a page at a
/// time, with each chain's access record and grant. A chain minted at `generation` or later (a sign-in just after the
/// wipe) stays. Until the sweep's first pass has filled the index, the tenant's records made before it are found the
/// old way too (`wipeUnindexed`). Answers how many chains it ended.
export async function wipeTenantSessions(storage: Store, tenant: string, generation: number): Promise<number> {
  const prefix = sessionIndexPrefix(tenant);
  let ended = 0;
  for (let after: string | undefined; ;) {
    const page = await storage.list<SessionIndexRow>({ prefix, limit: PAGE, ...(after === undefined ? {} : { startAfter: after }) });
    const doomed: string[] = [];
    for (const [key, row] of page) {
      after = key;
      if (wipeGeneration(row.generation) >= generation) continue;
      doomed.push(key, `${ACCESS_PREFIX}${row.accessHash}`, `${REFRESH_PREFIX}${key.slice(prefix.length)}`);
      ended++;
    }
    await deleteKeys(storage, doomed);
    if (page.size < PAGE) break;
  }
  if ((await storage.get(INDEX_FILLED_KEY)) !== true) ended += await wipeUnindexed(storage, tenant, generation);
  return ended;
}

/// Until the index is filled: the tenant's access records and grants older than the wipe, found by reading every one, a
/// page at a time, as the wipe did before the index. Each chain it finds goes with its row, if it has one.
async function wipeUnindexed(storage: Store, tenant: string, generation: number): Promise<number> {
  let ended = 0;
  for (const prefix of [ACCESS_PREFIX, REFRESH_PREFIX] as const) {
    for (let after: string | undefined; ;) {
      const page = await storage.list<Record<string, unknown>>({ prefix, limit: PAGE,
        ...(after === undefined ? {} : { startAfter: after }) });
      const doomed: string[] = [];
      for (const [key, record] of page) {
        after = key;
        if (!isRecord(record) || record.tenant !== tenant || wipeGeneration(record.wipeGeneration) >= generation) continue;
        const hash = key.slice(prefix.length);
        if (prefix === ACCESS_PREFIX) {
          const refreshHash = typeof record.refreshHash === "string" ? record.refreshHash : null;
          doomed.push(key, ...(refreshHash ? [`${REFRESH_PREFIX}${refreshHash}`, sessionIndexKey(tenant, refreshHash)] : []));
        } else {
          doomed.push(key, sessionIndexKey(tenant, hash),
            ...(typeof record.accessHash === "string" ? [`${ACCESS_PREFIX}${record.accessHash}`] : []));
        }
        ended++;
      }
      await deleteKeys(storage, doomed);
      if (page.size < PAGE) break;
    }
  }
  return ended;
}
