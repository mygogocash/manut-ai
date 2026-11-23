import { useState } from "react";
import { ApiError, type DeletedShop, type PilotApi } from "../api";
import { isWipeIncomplete } from "./words";

/// A deletion that stopped part way (`partial`), or whose answer never arrived. It is kept here, apart from
/// the shop list, on purpose: the API takes a shop off the list before its last step, so a partial wipe can
/// leave the list while data is still stored, and sending the same request again is the only way to finish.
export type UnfinishedDeletion = { tenant: string; name: string; partial: boolean; tries: number; error: unknown };

/// A deletion the API confirmed. `result` is null when the shop was already gone.
export type FinishedDeletion = { name: string; result: DeletedShop | null };

export type ShopDeletion = {
  /// Shops the API has confirmed deleted. The console hides them at once rather than wait for the list to
  /// reload, so a deleted shop's messages never show under the success note.
  gone: ReadonlySet<string>;
  finished: FinishedDeletion | null;
  unfinished: UnfinishedDeletion[];
  /// Sends one deletion. Resolves to the API's refusal when nothing was deleted, for the caller to show next
  /// to the name that was typed; every other answer is kept here and shown by the console. `retry` marks a
  /// run of an unfinished deletion, whose refusals stay with it too.
  run(tenant: string, name: string, retry?: boolean): Promise<unknown>;
  dismissFinished(): void;
};

/// The 404 codes that mean the shop no longer exists: `shop_not_found` from apps/api, and `unknown_tenant`
/// from the practice-mode fake.
const GONE_CODES = new Set(["shop_not_found", "unknown_tenant"]);

/// What a deletion that did not answer with its result means for the shop's data.
/// - `gone`: the shop no longer exists, which is what was asked for.
/// - `partial`: the API stopped part way (wipe_incomplete). Some data is deleted and some is still stored.
/// - `refused`: nothing was deleted, because the API turned it down with a 4xx, or because the client never
///   sent it for want of an operator key.
/// - `unclear`: anything else. With no answer, a server error, or a success whose body could not be read,
///   nobody can say how much was deleted.
export type DeleteErrorKind = "gone" | "partial" | "refused" | "unclear";

export function classifyDeleteError(error: unknown): DeleteErrorKind {
  if (!(error instanceof ApiError)) return "unclear";
  if (error.status === 404 && GONE_CODES.has(error.code)) return "gone";
  if (isWipeIncomplete(error)) return "partial";
  if ((error.status >= 400 && error.status < 500) || error.code === "operator_key_missing") return "refused";
  return "unclear";
}

export function useShopDeletion(
  api: PilotApi,
  events: { onAnswered: () => void; onDeleted: () => void },
): ShopDeletion {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [finished, setFinished] = useState<FinishedDeletion | null>(null);
  const [unfinished, setUnfinished] = useState<UnfinishedDeletion[]>([]);

  function finish(tenant: string, name: string, result: DeletedShop | null): void {
    setGone((current) => new Set(current).add(tenant));
    setUnfinished((list) => list.filter((entry) => entry.tenant !== tenant));
    setFinished({ name, result });
    events.onDeleted();
  }

  async function run(tenant: string, name: string, retry = false): Promise<unknown> {
    try {
      finish(tenant, name, await api.deleteShop({ tenant, confirmName: name }));
      return null;
    } catch (error) {
      const kind = classifyDeleteError(error);
      // A shop that no longer exists is what the operator asked for. On a retry it means an earlier attempt
      // finished after all, even though its answer was lost.
      if (kind === "gone") {
        finish(tenant, name, null);
        return null;
      }
      if (kind === "refused" && !retry) return error;
      setUnfinished((list) => {
        const previous = list.find((entry) => entry.tenant === tenant);
        const entry: UnfinishedDeletion = {
          tenant,
          name,
          // Once part of a shop is known to be deleted, a later unclear answer does not make that less so.
          partial: kind === "partial" || (previous?.partial ?? false),
          tries: (previous?.tries ?? 0) + 1,
          error,
        };
        return previous ? list.map((item) => (item.tenant === tenant ? entry : item)) : [...list, entry];
      });
      return null;
    } finally {
      // Whatever the answer, the list should show what the server now has: a partial wipe may already have
      // taken the shop off it, and a name mismatch means the name on screen is out of date.
      events.onAnswered();
    }
  }

  return { gone, finished, unfinished, run, dismissFinished: () => setFinished(null) };
}
