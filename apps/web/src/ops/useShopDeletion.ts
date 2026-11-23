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
      // A shop that no longer exists is what the operator asked for. On a retry it means an earlier attempt
      // finished after all, even though its answer was lost.
      if (error instanceof ApiError && error.status === 404 && GONE_CODES.has(error.code)) {
        finish(tenant, name, null);
        return null;
      }
      const partial = isWipeIncomplete(error);
      // No answer, or a server error, leaves it unknown how much was deleted.
      const unclear = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (!partial && !unclear && !retry) return error;
      setUnfinished((list) => {
        const previous = list.find((entry) => entry.tenant === tenant);
        const entry: UnfinishedDeletion = {
          tenant,
          name,
          partial: partial || (previous?.partial ?? false),
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
