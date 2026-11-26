const DAY_MS = 24 * 60 * 60 * 1000;

/// Days of practice mode a new connection starts with.
export const PRACTICE_DAYS = 3;

/// One connection of the shop (a LINE account, a bank feed, a machine). Practice mode is a setting
/// of the connection, not of the member, because the same member is trusted differently on a
/// channel it has used for a month and on one that was connected this morning.
export interface Connection {
  readonly connected: boolean;
  /// When it was connected, in ms.
  readonly connectedAt: number;
  /// Days of practice from `connectedAt`; defaults to `PRACTICE_DAYS`. Zero means none.
  readonly practiceDays?: number;
  /// When the owner ended practice early, in ms.
  readonly practiceEndedAt?: number;
}

export function newConnection(connectedAt: number, practiceDays: number = PRACTICE_DAYS): Connection {
  return { connected: true, connectedAt, practiceDays };
}

function validDays(days: number | undefined): number {
  if (days === undefined) return PRACTICE_DAYS;
  // A broken setting falls back to the default: more caution, never less.
  return Number.isFinite(days) && days >= 0 ? days : PRACTICE_DAYS;
}

/// The moment practice ends on its own, in ms.
export function practiceEndsAt(c: Connection): number {
  return c.connectedAt + validDays(c.practiceDays) * DAY_MS;
}

/// Practice lasts until its end moment, which is already outside it, or until the owner ends it.
export function inPracticeMode(c: Connection, now: number): boolean {
  if (c.practiceEndedAt !== undefined && Number.isFinite(c.practiceEndedAt) && now >= c.practiceEndedAt) return false;
  return now < practiceEndsAt(c);
}

/// The owner ends practice early. Ending twice keeps the first moment.
export function endPractice(c: Connection, now: number): Connection {
  if (c.practiceEndedAt !== undefined) return c;
  return { ...c, practiceEndedAt: now };
}
