/// Pilot retention policy: source snapshots 7 days, operational metadata
/// 30 days, outputs and deliberately kept memory until deleted. These
/// constants drive expiry checks; the on-call sweep (`POST /v1/admin/prune`
/// fanning out to per-task `/prune`) enforces the ops-metadata window for
/// finished attempts and dead (rejected/expired) proposals. Confirmed, failed
/// and unknown proposals stay as receipt and reconciliation evidence, and the
/// scheduled trigger arrives with durable routines (OFF-S04), which own
/// alarms and cursors.

export const RETENTION = {
  sourceSnapshotDays: 7,
  opsMetadataDays: 30,
} as const;

export function expiredAt(createdAtMs: number, days: number): number {
  return createdAtMs + days * 24 * 3600 * 1000;
}

export function isExpired(nowMs: number, createdAtMs: number, days: number): boolean {
  return nowMs >= expiredAt(createdAtMs, days);
}

/// The smallest shape the sweep reads off a stored attempt. `finishedAt` is
/// epoch seconds, stamped at finish; older records lack it.
export type PrunableAttempt = {
  status: unknown;
  finishedAt?: unknown;
};

/// The smallest shape the sweep reads off a stored action proposal. Timestamps
/// are the ISO strings the routes already write; absent or unparseable means
/// unknown age.
export type PrunableAction = {
  state: unknown;
  proposedAt?: unknown;
  expiresAt?: unknown;
  approval?: { at?: unknown };
  dispatch?: { at?: unknown };
};

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/// Whether a finished attempt may be pruned. Active attempts are never
/// prunable, whatever their age: the executor may still publish. A finished
/// attempt without a timestamp is of unknown age and is kept.
export function isPrunableAttempt(attempt: PrunableAttempt, nowMs: number): boolean {
  if (attempt.status !== "done") return false;
  const finished = epochMs(attempt.finishedAt);
  if (finished === null) return false;
  return isExpired(nowMs, finished, RETENTION.opsMetadataDays);
}

/// The latest known timestamp on an action proposal, or null when nothing on
/// the record parses.
export function actionAgeMs(action: PrunableAction): number | null {
  const candidates = [
    epochMs(action.dispatch?.at),
    epochMs(action.approval?.at),
    epochMs(action.expiresAt),
    epochMs(action.proposedAt),
  ].filter((ms): ms is number => ms !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/// Whether a dead proposal may be pruned. Only rejected and expired proposals
/// qualify: confirmed and failed proposals are the receipts duplicates replay
/// and the evidence reconciliation reads, and unknown outcomes are held
/// deliberately until a person re-decides. Anything of unknown age is kept.
export function isPrunableAction(action: PrunableAction, nowMs: number): boolean {
  if (action.state !== "rejected" && action.state !== "expired") return false;
  const latest = actionAgeMs(action);
  if (latest === null) return false;
  return isExpired(nowMs, latest, RETENTION.opsMetadataDays);
}
