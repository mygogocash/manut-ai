import type { Running, Stamp } from "./types";

/// Which turn and attempt a decision belongs to, ported from GoSpark's `DecisionBinding`.
///
/// The runtime stamps every request as it is asked with the turn it was asked in and, inside a
/// task, the attempt then running. Once another turn or attempt is running, a decision on that
/// request is refused as superseded: whatever an ended turn or an earlier attempt asked about,
/// acting on it now would do something nobody is waiting for any more.
///
/// The turn and the attempt are compared separately, each only when both sides are known, so a
/// missing stamp on either side never blocks. A request asked between turns, or a store row
/// written before stamps existed, carries no stamp and is decided by whatever runs.

/// Which half of the binding no longer holds, if either. The turn is checked first, because a new
/// turn usually brings a new attempt with it and the turn is the plainer reason to show.
export function bindingBreak(stamp: Stamp, running: Running): "turn_ended" | "attempt_ended" | undefined {
  if (!agrees(stamp.turnId, running.turnId)) return "turn_ended";
  if (!agrees(stamp.attemptId, running.attemptId)) return "attempt_ended";
  return undefined;
}

/// True when the request belongs to the turn and attempt running now.
export function bindingHolds(stamp: Stamp, running: Running): boolean {
  return bindingBreak(stamp, running) === undefined;
}

/// Records on a request the turn and attempt it is being asked in. Whatever it carried is
/// replaced, a missing value included: where a request was asked is the runtime's to say, never
/// the asking model's, so a model cannot pin a request to a turn of its choosing.
///
/// `T` is any object rather than a `Stamp`, because a draft with no stamp keys at all is the usual
/// case, and TypeScript refuses such an object where a type with only optional keys is expected.
export function stampRequest<T extends object>(request: T, running: Running): Omit<T, keyof Stamp> & Stamp {
  const { turnId: _carriedTurn, attemptId: _carriedAttempt, ...rest } = request as T & Stamp;
  return {
    ...rest,
    ...(running.turnId != null ? { turnId: running.turnId } : {}),
    ...(running.attemptId != null ? { attemptId: running.attemptId } : {}),
  };
}

/// Two ids disagree only when both are known. `null` counts as unknown because a database column
/// with no value reads back as `null`.
function agrees(stamp: string | null | undefined, current: string | null | undefined): boolean {
  if (stamp == null || current == null) return true;
  return stamp === current;
}
